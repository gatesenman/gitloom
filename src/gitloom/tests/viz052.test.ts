// 0.5.2 可视化深度优化: change-centric clustering, bundled orthogonal routes, component packing, navigator,
// path finding, per-view summary, label tidying and full-diagram SVG export.
import { describe, it, expect } from 'vitest'
import { changeCluster, collapseSet, tidyLabels, changeOrder, shortestPath, viewSummary } from '../src/renderer/src/lib/vizGraph'
import { layoutGraph } from '../src/renderer/src/lib/vizLayout'
import { graphSvg, sideBySideSvg, roundedPath, absBoxes, LIGHT } from '../src/renderer/src/lib/vizSvg'
import type { DiffGraph, GNode, GEdge, DiffStatus } from '../src/shared/viz'

const n = (id: string, status: DiffStatus = 'unchanged', extra: Partial<GNode> = {}): GNode => ({ id, label: id.split('/').pop()!, kind: 'file', status, ...extra })
const e = (s: string, t: string, status: DiffStatus = 'unchanged'): GEdge => ({ id: `${s}>${t}`, source: s, target: t, kind: 'import', status })
/** folders d0..dN of files; folder 0 and 1 have one changed file; a chain of cross-folder imports */
function repo(dirs: number, per: number): DiffGraph {
  const nodes: GNode[] = []; const edges: GEdge[] = []
  for (let d = 0; d < dirs; d++) {
    nodes.push({ id: `d:src/d${d}`, label: `src/d${d}`, kind: 'folder', status: d < 2 ? 'modified' : 'unchanged', group: true })
    for (let i = 0; i < per; i++) {
      const id = `m:src/d${d}/f${i}.ts`
      nodes.push(n(id, d < 2 && i === 0 ? (d ? 'added' : 'modified') : 'unchanged', { parent: `d:src/d${d}`, sub: `src/d${d}`, after: { file: `src/d${d}/f${i}.ts`, line: 1 } }))
      if (i) edges.push(e(id, `m:src/d${d}/f${i - 1}.ts`))
    }
    if (d) edges.push(e(`m:src/d${d}/f0.ts`, `m:src/d${d - 1}/f1.ts`, d === 1 ? 'added' : 'unchanged'))
  }
  return { nodes, edges }
}
const leaves = (g: DiffGraph) => g.nodes.filter((x) => !x.group)
const changed = (g: DiffGraph) => leaves(g).filter((x) => x.status !== 'unchanged').map((x) => x.id).sort()

describe('changeCluster', () => {
  it('keeps every changed node and gets under the budget', () => {
    const g = repo(12, 8)
    const r = changeCluster(g, 20)
    expect(leaves(r.graph).length).toBeLessThanOrEqual(20)
    expect(changed(r.graph)).toEqual(expect.arrayContaining(changed(g)))
    expect(r.collapsed.length).toBeGreaterThan(0)
    // edges only reference existing nodes, aggregated edges carry ×N labels
    const ids = new Set(r.graph.nodes.map((x) => x.id))
    for (const ed of r.graph.edges) { expect(ids.has(ed.source)).toBe(true); expect(ids.has(ed.target)).toBe(true) }
  })
  it('small graphs are untouched', () => {
    const g = repo(2, 3)
    expect(changeCluster(g, 40).graph).toBe(g)
  })
  it('unchanged siblings inside a changed folder fold into "其他 N 个", and expanding opens them for good', () => {
    const g = repo(2, 30)
    const r = changeCluster(g, 20)
    const rest = r.graph.nodes.find((x) => x.id === 'd:src/d0#rest')
    expect(rest?.kind).toBe('cluster'); expect(rest?.label).toMatch(/^其他 \d+ 个$/); expect(rest?.parent).toBe('d:src/d0')
    const open = changeCluster(g, 20, new Set(['d:src/d0#rest', 'd:src/d1#rest']))
    expect(open.graph.nodes.some((x) => x.id === 'd:src/d0#rest')).toBe(false)
    expect(leaves(open.graph).filter((x) => x.parent === 'd:src/d0').length).toBe(30)
  })
  it('untouched folders become clusters; ids are stable for the expanded set', () => {
    const g = repo(10, 6)
    const a = changeCluster(g, 24); const b = changeCluster(g, 24)
    expect(a.collapsed).toEqual(b.collapsed)
    const any = a.collapsed.find((id) => id.startsWith('d:') || id.startsWith('up:'))!
    expect(any).toBeTruthy()
    const c = changeCluster(g, 24, new Set([any]))
    expect(c.collapsed).not.toContain(any)
  })
  it('collapseSet aggregates parallel edges with a ×N label and merged status', () => {
    const g: DiffGraph = { nodes: [n('a'), n('b'), n('c'), n('x', 'modified')], edges: [e('a', 'x'), e('b', 'x', 'added'), e('c', 'x')] }
    const r = collapseSet(g, new Set(['a', 'b', 'c']), { id: 'cl', label: '3', kind: 'cluster', status: 'unchanged' })
    expect(r.edges).toHaveLength(1)
    expect(r.edges[0]).toMatchObject({ source: 'cl', target: 'x', label: '×3', status: 'modified' })
    expect(r.nodes.find((x) => x.id === 'cl')?.count).toBe(3)
  })
})

describe('tidyLabels / summary / navigator / path', () => {
  it('drops a sub line that repeats the folder, turns file:line into 第 N 行', () => {
    const g: DiffGraph = { nodes: [{ id: 'd', label: 'src/lib', kind: 'folder', status: 'unchanged', group: true }, n('m:src/lib/a.ts', 'unchanged', { parent: 'd', sub: 'src/lib' }),
      { id: 'g', label: 'orders.ts', kind: 'file', status: 'unchanged', group: true }, n('f', 'modified', { parent: 'g', sub: 'orders.ts:20', kind: 'function' }), n('loose', 'unchanged', { sub: 'keep/me' })], edges: [] }
    const t = tidyLabels(g)
    expect(t.nodes.find((x) => x.id === 'm:src/lib/a.ts')!.sub).toBeUndefined()
    expect(t.nodes.find((x) => x.id === 'f')!.sub).toBe('第 20 行')
    expect(t.nodes.find((x) => x.id === 'loose')!.sub).toBe('keep/me')
    expect(tidyLabels({ nodes: [n('z')], edges: [] }).nodes[0]).toEqual(n('z'))
  })
  it('viewSummary speaks plain Chinese', () => {
    const s = viewSummary(repo(3, 3), '文件', '依赖')
    expect(s.text).toBe('新增 1 个文件，修改 1 个，多了 1 条依赖')
    expect(viewSummary({ nodes: [n('a')], edges: [] }, '函数', '调用').text).toBe('这张图里没有改动的函数')
  })
  it('changeOrder reads left→right for RIGHT and top→bottom for DOWN', () => {
    const g: DiffGraph = { nodes: [n('a', 'added'), n('b', 'modified'), n('c', 'removed'), n('u')], edges: [] }
    const P: Record<string, { x: number; y: number }> = { a: { x: 400, y: 0 }, b: { x: 0, y: 300 }, c: { x: 200, y: 100 }, u: { x: 0, y: 0 } }
    expect(changeOrder(g, (id) => P[id], 'RIGHT')).toEqual(['b', 'c', 'a'])
    expect(changeOrder(g, (id) => P[id], 'DOWN')).toEqual(['a', 'c', 'b'])
  })
  it('shortestPath: directed first, reversed, then undirected', () => {
    const g: DiffGraph = { nodes: ['a', 'b', 'c', 'd', 'z'].map((x) => n(x)), edges: [e('a', 'b'), e('b', 'c'), e('d', 'c'), e('a', 'c')] }
    expect(shortestPath(g, 'a', 'c')).toEqual({ nodes: ['a', 'c'], edges: ['a>c'], directed: true })
    expect(shortestPath(g, 'c', 'a')?.directed).toBe(true)
    const u = shortestPath(g, 'b', 'd')!; expect(u.directed).toBe(false); expect(u.nodes).toEqual(['b', 'c', 'd'])
    expect(shortestPath(g, 'a', 'z')).toBeNull()
  })
})

describe('layout 0.5.2: routes + packing', () => {
  it('every edge gets an orthogonal route that starts/ends on its boxes (flat graph)', async () => {
    const g: DiffGraph = { nodes: ['a', 'b', 'c', 'd'].map((x) => n(x)), edges: [e('a', 'b'), e('a', 'c'), e('c', 'd'), e('b', 'd')] }
    const L = await layoutGraph(g, 'modules')
    expect(Object.keys(L.routes ?? {}).sort()).toEqual(g.edges.map((x) => x.id).sort())
    const abs = absBoxes(g, L)
    for (const ed of g.edges) {
      const r = L.routes![ed.id]
      for (let i = 1; i < r.pts.length; i++) expect(Math.min(Math.abs(r.pts[i].x - r.pts[i - 1].x), Math.abs(r.pts[i].y - r.pts[i - 1].y))).toBeLessThan(0.6)
      const s = abs.get(ed.source)!; const t = abs.get(ed.target)!; const a = r.pts[0]; const z = r.pts[r.pts.length - 1]
      expect(a.x).toBeGreaterThanOrEqual(s.x - 1); expect(a.x).toBeLessThanOrEqual(s.x + s.w + 1)
      expect(z.y).toBeGreaterThanOrEqual(t.y - 1); expect(z.y).toBeLessThanOrEqual(t.y + t.h + 1)
    }
  })
  it('compound graphs: cross-folder edges are routed as bundles, nothing NaN, top-level boxes never overlap', async () => {
    const g = changeCluster(repo(8, 5), 40).graph
    const L = await layoutGraph(g, 'modules', { aspect: 1.6 })
    expect(Object.keys(L.routes ?? {}).length).toBe(g.edges.length)
    for (const r of Object.values(L.routes!)) for (const p of r.pts) { expect(Number.isFinite(p.x)).toBe(true); expect(Number.isFinite(p.y)).toBe(true) }
    const top = g.nodes.filter((x) => !x.parent).map((x) => L.boxes[x.id])
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
      const a = top[i]; const b = top[j]
      expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false)
    }
    // children stay inside their folder
    for (const c of g.nodes.filter((x) => x.parent)) { const b = L.boxes[c.id]; const p = L.boxes[c.parent!]; expect(b.x + b.w).toBeLessThanOrEqual(p.w + 0.5); expect(b.y + b.h).toBeLessThanOrEqual(p.h + 0.5) }
  })
  it('disconnected pieces are packed towards the pane shape instead of one long strip', async () => {
    const nodes: GNode[] = []; const edges: GEdge[] = []
    for (let k = 0; k < 12; k++) { nodes.push(n(`a${k}`), n(`b${k}`)); edges.push(e(`a${k}`, `b${k}`)) }
    const wide = await layoutGraph({ nodes, edges }, 'calls', { aspect: 3 })
    const tall = await layoutGraph({ nodes, edges }, 'calls', { aspect: 0.7 })
    expect(wide.width / wide.height).toBeGreaterThan(tall.width / tall.height)
    expect(Math.max(wide.width / wide.height, wide.height / wide.width)).toBeLessThan(6)
  })
  it('deterministic with routes', async () => {
    const g = repo(5, 4)
    const a = await layoutGraph(g, 'modules'); const b = await layoutGraph({ nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() }, 'modules')
    expect(a.boxes).toEqual(b.boxes); expect(a.routes).toEqual(b.routes)
  })
})

describe('vizSvg export', () => {
  it('roundedPath keeps the end points and rounds the corners', () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }], 8)
    expect(d.startsWith('M0,0')).toBe(true); expect(d.endsWith('L50,40')).toBe(true); expect(d).toContain('Q50,0')
    expect(roundedPath([{ x: 1, y: 1 }])).toBe('')
  })
  it('whole-diagram SVG: every visible node, status colours, legend, escaped text; before side hides added', async () => {
    const g = repo(3, 3); g.nodes.push(n('m:<odd>&"x"', 'removed'))
    const L = await layoutGraph(g, 'modules')
    const after = graphSvg(g, L, { side: 'after', theme: LIGHT, title: '模块依赖 · A→B', legend: true })
    expect(after.startsWith('<svg')).toBe(true); expect(after).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(after).toContain('模块依赖 · A→B'); expect(after).toContain(LIGHT.add); expect(after).toContain('新增')
    expect(after).not.toContain('<odd>'); expect(after).not.toContain('&lt;odd&gt;')   // removed node is not on the after side
    const both = graphSvg(g, L, { side: 'both', theme: LIGHT })
    expect(both).toContain('&lt;odd&gt;&amp;')
    const before = graphSvg(g, L, { side: 'before', theme: LIGHT })
    expect(before).not.toMatch(/>f0\.ts<[^]*>f0\.ts<[^]*>f0\.ts</)   // d1/f0 (added) is missing before → only 2 of 3 f0 labels
    const sbs = sideBySideSvg(g, L, { theme: LIGHT, title: 't', beforeLabel: 'v1', afterLabel: 'v2' })
    expect(sbs).toContain('v1'); expect(sbs).toContain('v2')
    const w = Number(/width="([\d.]+)"/.exec(sbs)![1]); expect(w).toBeGreaterThan(L.width * 2)
  })
})

import { explainPrompt, linkNames, nameIndex } from '../src/renderer/src/lib/vizExplain'
describe('AI 解读本图 (grounded prompt + clickable names)', () => {
  const g: DiffGraph = { nodes: [n('f:a#cancel', 'added', { label: 'cancelOrder', kind: 'function', after: { file: 'a.ts', line: 3 } }), n('f:b#get', 'modified', { label: 'getOrder', kind: 'function' }),
    n('f:c#get', 'unchanged', { label: 'getOrder', kind: 'function' }), n('f:d#log', 'unchanged', { label: 'log', kind: 'function' })], edges: [e('f:a#cancel', 'f:b#get', 'added'), e('f:b#get', 'f:d#log')] }
  it('prompt lists changed nodes / edges with 「」 names and locations, and forbids invented names', () => {
    const [sys, user] = explainPrompt(g, '调用图', 'HEAD')
    expect(sys.role).toBe('system'); expect(sys.content).toContain('不要编造')
    expect(user.content).toContain('[新增] 函数 「cancelOrder」（a.ts:3）')
    expect(user.content).toContain('[新增] 「cancelOrder」 → 「getOrder」')
    expect(user.content).toContain('建议先看')
    expect(user.content).not.toContain('f:b#get>f:d#log')
  })
  it('only unique names become links; unknown names stay text', () => {
    const idx = nameIndex(g)
    expect(idx.get('cancelOrder')).toBe('f:a#cancel'); expect(idx.has('getOrder')).toBe(false)
    const parts = linkNames('新增「cancelOrder」调用「getOrder」和「nope」', idx)
    expect(parts).toEqual([{ text: '新增' }, { ref: 'cancelOrder', id: 'f:a#cancel' }, { text: '调用「getOrder」和「nope」' }])
  })
})
