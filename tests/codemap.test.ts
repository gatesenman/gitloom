// 0.5.1 代码地图 + 改动导览: CodeMap on a real git fixture (hubs, affected, renames, tags), static tour order,
// AI tour grounding (candidates / schema / retry / cache), and the pure renderer helpers (tree, treemap, exports).
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { VizService, type VizChat } from '../src/main/viz/service'
import { localDeps } from '../src/main/viz/local'
import { blastOf, tourOrder } from '../src/main/viz/codemap'
import { tourCandidates, validateTour, convertTour } from '../src/main/viz/tourAi'
// @ts-expect-error plain .mjs fixture builder shared with the e2e
import { makeHub } from '../scripts/viz-fixtures.mjs'
import type { VizResult, MapFile } from '../src/shared/viz'
import { buildTree, squarify, treemapCells, colorClass, codemapMarkdown, codemapJson, tourGraph, tourMarkdown, tourProgress, filterFiles, fmtBytes, fileTip, natCmp } from '../src/renderer/src/lib/codemap'

const root = mkdtempSync(join(tmpdir(), 'viz-map-'))
let HUB = ''
const deps = localDeps('node_modules/tree-sitter-wasms/out', 'node_modules/web-tree-sitter/tree-sitter.wasm')
const svc = new VizService(deps)
let pr: VizResult
const f = (r: VizResult, p: string): MapFile => r.map!.files.find((x) => x.path === p)!

beforeAll(async () => {
  HUB = makeHub(join(root, 'shop'))
  pr = await svc.analyze({ repo: HUB, scope: { kind: 'refs', base: 'main', head: 'feature/coupons' } })
}, 120000)

describe('CodeMap (codemap --diff style)', () => {
  it('every file of both sides, with status, sizes and +/− lines', () => {
    const m = pr.map!
    expect(f(pr, 'src/config.ts').status).toBe('modified')
    expect(f(pr, 'src/features/coupons/coupon.ts').status).toBe('added')
    expect(f(pr, 'src/features/coupons/coupon.ts').bytesB).toBeUndefined()
    expect(f(pr, 'src/features/legacy/oldPromo.ts').status).toBe('removed')
    expect(f(pr, 'src/features/legacy/oldPromo.ts').bytesA).toBeUndefined()
    const fmt = f(pr, 'src/lib/format.ts')
    expect(fmt.oldPath).toBe('src/lib/fmt.ts'); expect(['moved', 'modified']).toContain(fmt.status)
    expect(m.files.some((x) => x.path === 'src/lib/fmt.ts')).toBe(false)   // rename = one entry
    expect(f(pr, 'docs/coupons.md').status).toBe('added')                  // non-source files too (size only)
    expect(f(pr, 'assets/logo.svg')).toMatchObject({ status: 'unchanged', bytesB: f(pr, 'assets/logo.svg').bytesA })
    expect(f(pr, 'src/config.ts').add).toBeGreaterThan(0)
    expect(m.totals.filesA - m.totals.filesB).toBe(2)   // +coupon +couponService +coupons.md −oldPromo
    expect(m.totals.changed).toBeGreaterThanOrEqual(10)
  })
  it('hub files: config.ts imported by ≥ 12 files, flagged and listed first', () => {
    const c = f(pr, 'src/config.ts')
    expect(c.inA).toBeGreaterThanOrEqual(12); expect(c.hub).toBe(true)
    expect(pr.map!.hubs[0]).toBe('src/config.ts')
    expect(pr.map!.hubMin).toBe(5)
    expect(f(pr, 'src/lib/http.ts').hub).toBe(true)
    expect(f(pr, 'src/ui/App.tsx').hub).toBeUndefined()
    // same flag on graph nodes
    expect(pr.modules.nodes.find((n) => n.id === 'm:src/config.ts')?.hub).toBe(true)
  })
  it('importers gained / lost and blast radius', () => {
    const c = f(pr, 'src/config.ts')
    expect(c.gained).toContain('src/features/coupons/coupon.ts')
    expect(c.lost).toContain('src/features/legacy/oldPromo.ts')
    expect(c.blast).toBeGreaterThanOrEqual(c.inA!)
    const http = f(pr, 'src/lib/http.ts')
    expect(http.status).toBe('unchanged'); expect(http.gained).toContain('src/features/coupons/couponService.ts')
    expect(f(pr, 'src/features/coupons/couponService.ts').fns?.[0]).toBe(1)
  })
  it('affected = unchanged files that depend on a changed one (CodeSee "white boxes")', () => {
    expect(f(pr, 'src/ui/App.tsx').affected).toBe(true)          // imports checkoutView (changed)
    expect(f(pr, 'src/features/cart/cartApi.ts').affected).toBe(true)   // imports config (changed)
    expect(f(pr, 'src/config.ts').affected).toBeUndefined()
    expect(pr.map!.totals.affected).toBeGreaterThan(3)
    expect(pr.map!.coverage).toBe('complete')
  })
  it('tags as compare points: v1.0 → v1.1 only touched docs', async () => {
    const r = await svc.analyze({ repo: HUB, scope: { kind: 'range', from: 'v1.0', to: 'v1.1' } })
    expect(r.map!.totals.changed).toBe(1)
    expect(r.map!.files.filter((x) => x.status !== 'unchanged').map((x) => x.path)).toEqual(['docs/README.md'])
    expect(r.map!.totals.affected).toBe(0)
    expect(r.tour!.groups.map((g) => g.title)).toEqual(['其他改动（文档 / 配置 / 资源）'])
  })
  it('path filter limits the map', async () => {
    const r = await svc.analyze({ repo: HUB, scope: { kind: 'refs', base: 'main', head: 'feature/coupons' }, filter: 'src/features' })
    expect(r.map!.files.every((x) => x.path.startsWith('src/features/'))).toBe(true)
  })
  it('blastOf: transitive importers, cycles safe', () => {
    const rev = new Map([['a', new Set(['b'])], ['b', new Set(['c', 'a'])], ['c', new Set(['b'])]])
    expect([...blastOf(rev, ['a'])].sort()).toEqual(['b', 'c'])
  })
})

describe('static tour (阅读路线)', () => {
  it('callers before callees, numbered 1 / 1a, grouped by layer, docs last', () => {
    const t = pr.tour!
    const files = t.groups.flatMap((g) => g.steps).filter((s) => s.kind === 'file').map((s) => s.file)
    const at = (p: string) => files.indexOf(p)
    expect(at('src/features/checkout/checkoutView.ts')).toBeLessThan(at('src/features/coupons/couponService.ts'))
    expect(at('src/features/coupons/couponService.ts')).toBeLessThan(at('src/features/coupons/coupon.ts'))
    expect(at('src/features/coupons/coupon.ts')).toBeLessThan(at('src/config.ts'))
    const all = t.groups.flatMap((g) => g.steps)
    expect(all[0].n).toBe('1')
    expect(all.filter((s) => s.kind === 'file').map((s) => s.n)).toEqual(all.filter((s) => s.kind === 'file').map((_, i) => String(i + 1)))
    const fnStep = all.find((s) => s.kind === 'function' && s.title === 'applyCoupons()')!
    expect(fnStep.n).toMatch(/^\d+a$/); expect(fnStep.status).toBe('added'); expect(fnStep.after?.line).toBe(3)
    expect(t.groups[t.groups.length - 1].title).toContain('其他改动')
    const cfg = all.find((s) => s.file === 'src/config.ts' && s.kind === 'file')!
    expect(cfg.hub).toBe(true); expect(cfg.why).toContain('热点')
  })
  it('why text references later steps it imports / calls', () => {
    const cv = pr.tour!.groups.flatMap((g) => g.steps).find((s) => s.file === 'src/features/checkout/checkoutView.ts' && s.kind === 'file')!
    expect(cv.next?.length).toBeGreaterThan(0); expect(cv.why).toMatch(/引用第 [\d、]+ 步/)
  })
  it('tourOrder breaks cycles deterministically', () => {
    const g: Record<string, string[]> = { 'src/a.ts': ['src/b.ts'], 'src/b.ts': ['src/a.ts'], 'src/ui/c.ts': ['src/a.ts'] }
    const o1 = tourOrder(Object.keys(g), (p) => g[p]); const o2 = tourOrder(Object.keys(g).reverse(), (p) => g[p])
    expect(o1).toEqual(o2); expect(o1[0]).toBe('src/ui/c.ts'); expect(o1).toHaveLength(3)
  })
})

describe('AI tour (Codemaps-style, grounded)', () => {
  const s0 = () => svc.get(pr.id)!
  const good = (ids: string[]) => JSON.stringify({ title: '优惠券怎么生效', summary: '结账时先校验再扣减', groups: [
    { title: '结账入口', guide: '从页面开始', steps: [{ ref: ids[0], title: '渲染结账', note: '新增优惠券分支' }, { ref: ids[1], title: '应用优惠券' }] },
    { title: '规则', steps: [{ ref: ids[2], title: '校验数量' }] }] })
  it('candidates = static steps + unchanged neighbours on the call path', () => {
    const c = tourCandidates(pr, s0().before, s0().after)
    expect(c[0].id).toBe('C1')
    expect(c.some((x) => x.status === 'unchanged' && x.kind === 'function')).toBe(true)   // e.g. loadcheckout / post
    const apply = c.find((x) => x.title === 'applyCoupons()')!
    expect(apply.calls.length).toBeGreaterThan(0)
  })
  it('validateTour: fenced JSON ok, unknown ref rejected with a helpful error', () => {
    const ids = new Set(['C1', 'C2', 'C3'])
    expect(validateTour('```json\n' + good(['C1', 'C2', 'C3']) + '\n```', ids).ok).toBe(true)
    const bad = validateTour(good(['C1', 'C9', 'C3']), ids)
    expect(bad.ok).toBe(false); if (!bad.ok) expect(bad.errors[0]).toContain('C9')
  })
  it('convertTour: 1a/1b/2a numbering, locations from candidates, reading-order edges', () => {
    const c = tourCandidates(pr, s0().before, s0().after)
    const pick = ['src/features/checkout/checkoutView.ts', 'applyCoupons()', 'valid()'].map((k) => c.find((x) => x.file === k || x.title === k)!.id)
    const v = validateTour(good(pick), new Set(c.map((x) => x.id)))
    expect(v.ok).toBe(true)
    const t = convertTour((v as { data: Parameters<typeof convertTour>[0] }).data, c, '优惠券', 'mock')
    const steps = t.groups.flatMap((g) => g.steps)
    expect(steps.map((s) => s.n)).toEqual(['1a', '1b', '2a'])
    expect(steps[1].after?.file).toBe('src/features/coupons/couponService.ts')
    expect(steps[0].next).toContain(steps[1].id); expect(steps[1].next).toContain(steps[2].id)
    expect(t.source).toBe('ai'); expect(t.question).toBe('优惠券')
  })
  it('service.tour: one retry on a bad ref, then cached; single-flight', async () => {
    const c = tourCandidates(pr, s0().before, s0().after)
    let calls = 0
    const chat: VizChat = async (msgs) => {
      calls++
      const retry = JSON.stringify(msgs).includes('没有通过校验')
      await new Promise((r) => setTimeout(r, 30))
      return retry ? good([c[0].id, c[1].id, c[2].id]) : good([c[0].id, 'C999', c[2].id])
    }
    const [a, b] = await Promise.all([svc.tour(pr.id, '优惠券怎么用', 'mock', chat), svc.tour(pr.id, '优惠券怎么用', 'mock', chat)])
    expect(calls).toBe(2); expect(a.attempts).toBe(2); expect(b.groups.length).toBe(2)
    const again = await svc.tour(pr.id, '优惠券怎么用 ', 'mock', chat)
    expect(again.cached).toBe(true); expect(calls).toBe(2)
    expect(svc.tourCached(pr.id, '优惠券怎么用', 'mock')).toBeTruthy()
  })
  it('service.tour: two invalid answers → readable error', async () => {
    const chat: VizChat = async () => '{"title":"x","groups":[{"title":"g","steps":[{"ref":"C404","title":"t"}]}]}'
    await expect(svc.tour(pr.id, '另一个问题', 'mock', chat)).rejects.toThrow(/两次都不合法/)
  })
})

describe('renderer helpers (lib/codemap)', () => {
  it('buildTree: compressed folders + aggregates', () => {
    const t = buildTree(pr.map!.files)
    const src = t.dirs.find((d) => d.name === 'src')!
    expect(src.agg.changed).toBeGreaterThan(5)
    expect(src.agg.hubs).toBeGreaterThanOrEqual(2)
    const one = buildTree([{ path: 'a/b/c/x.ts', status: 'added', bytesA: 10 }])
    expect(one.dirs[0].name).toBe('a/b/c'); expect(one.dirs[0].agg.bytesA).toBe(10); expect(one.dirs[0].status).toBe('added')
  })
  it('squarify: conserves area, stays inside, deterministic', () => {
    const items = [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ key: String(i), value: v }))
    const r = squarify(items, { x: 0, y: 0, w: 600, h: 400 })
    expect(r).toHaveLength(7)
    const area = r.reduce((s, c) => s + c.w * c.h, 0)
    expect(Math.abs(area - 240000)).toBeLessThan(1)
    for (const c of r) { expect(c.x).toBeGreaterThanOrEqual(-1e-6); expect(c.y).toBeGreaterThanOrEqual(-1e-6); expect(c.x + c.w).toBeLessThanOrEqual(600 + 1e-6); expect(c.y + c.h).toBeLessThanOrEqual(400 + 1e-6) }
    expect(squarify([...items].reverse(), { x: 0, y: 0, w: 600, h: 400 })).toEqual(r)
    expect(squarify([{ value: 0 }], { x: 0, y: 0, w: 10, h: 10 })).toEqual([])
  })
  it('treemapCells: before side hides added files, after side hides removed ones', () => {
    const t = buildTree(pr.map!.files)
    const after = treemapCells(t, { x: 0, y: 0, w: 1200, h: 700 }, 'after', 0)
    const before = treemapCells(t, { x: 0, y: 0, w: 1200, h: 700 }, 'before', 0)
    expect(after.some((c) => c.file?.path === 'src/features/coupons/coupon.ts')).toBe(true)
    expect(after.some((c) => c.file?.path === 'src/features/legacy/oldPromo.ts')).toBe(false)
    expect(before.some((c) => c.file?.path === 'src/features/legacy/oldPromo.ts')).toBe(true)
    expect(before.some((c) => c.file?.path === 'src/features/coupons/coupon.ts')).toBe(false)
    expect(treemapCells(t, { x: 0, y: 0, w: 1200, h: 700 }, 'after', 0)).toEqual(after)
  })
  it('colorClass / filterFiles / fileTip / fmtBytes', () => {
    const cfg = f(pr, 'src/config.ts')
    expect(colorClass(cfg, 'status', 5)).toBe('cm-modified')
    expect(colorClass(cfg, 'heat', 5)).toBe('cm-hot3')
    expect(colorClass(f(pr, 'src/ui/App.tsx'), 'status', 5)).toBe('cm-affected')
    expect(colorClass(f(pr, 'src/features/coupons/coupon.ts'), 'growth', 5)).toBe('cm-grnew')
    const changed = filterFiles(pr.map!, 'changed')
    expect(changed.some((x) => x.path === 'assets/logo.svg')).toBe(false)
    expect(changed.some((x) => x.path === 'src/lib/http.ts')).toBe(true)    // importers changed
    expect(filterFiles(pr.map!, 'all').length).toBe(pr.map!.files.length)
    expect(filterFiles(pr.map!, 'all', 'COUPON').every((x) => x.path.toLowerCase().includes('coupon'))).toBe(true)
    expect(fileTip(cfg, 5)).toContain('热点')
    expect(fmtBytes(512)).toBe('512 B'); expect(fmtBytes(2048)).toBe('2.0 KB'); expect(fmtBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
  it('Markdown review bundle + JSON export', () => {
    const md = codemapMarkdown(pr)
    expect(md).toContain('⚠ 改动了热点文件'); expect(md).toContain('src/config.ts'); expect(md).toContain('可能受影响')
    expect(md).toContain('| 文件 | 状态 |')
    const j = JSON.parse(codemapJson(pr))
    expect(j.schema_version).toBe('gitloom.codemap/v1'); expect(j.files.length).toBe(pr.map!.files.length)
  })
  it('tourGraph / tourMarkdown / tourProgress', () => {
    const t = pr.tour!
    const g = tourGraph(t)
    const ids = new Set(g.nodes.map((n) => n.id))
    for (const e of g.edges) { expect(ids.has(e.source)).toBe(true); expect(ids.has(e.target)).toBe(true) }
    expect(g.nodes[0].label.startsWith('1 · ')).toBe(true)
    expect(g.nodes.every((n) => n.kind === 'file')).toBe(true)          // functions are members of their file node
    expect(g.nodes.find((n) => n.label.includes('couponService.ts'))?.members?.[0].name).toMatch(/^\d+a applyCoupons$/)
    expect(g.edges.some((e) => e.kind === 'flow')).toBe(true)           // reading-order links
    const md = tourMarkdown(t, pr)
    expect(md).toContain('**1. '); expect(md).toMatch(/`src\/[^`]+:\d+`/)
    expect(tourProgress(t, new Set([g.nodes[0].id]))).toEqual({ done: 1, total: t.groups.flatMap((x) => x.steps).length })
  })
  it('natCmp sorts tags naturally', () => {
    expect(['v1.0', 'v1.10', 'v1.9', 'v1.1', 'v2'].sort((a, b) => natCmp(b, a))).toEqual(['v2', 'v1.10', 'v1.9', 'v1.1', 'v1.0'])
  })
})
