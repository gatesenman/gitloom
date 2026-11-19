// 代码地图 + 改动导览 (0.5.1) — codemap-style comparison on top of the two SideModels.
//
// Inspired by (see docs/PLAN.md §10):
//  - codemap CLI (github.com/JordanCoin/codemap): project tree with sizes, `--diff --ref` changed files with +/−,
//    HUB files (most imported), `--importers` / blast radius, and an explicit coverage status for every dependency answer.
//  - Windsurf / Devin Codemaps (cognition.com/blog/codemaps): numbered, grouped code-path steps that link to code.
//  - CodeSee Review Maps: unchanged files that depend on a changed file are shown as "possibly affected".
import { posix } from 'path'
import type { ChangedFile, CodeMap, DiffStatus, MapFile, Tour, TourGroup, TourStep } from '../../shared/viz'
import type { SideModel } from './model'
import { componentOf, layerOf, layerName, LAYER_ORDER } from './diff'

export interface MapInput {
  before: SideModel
  after: SideModel
  changed: ChangedFile[]
  /** canonical (after) path → original before path, for renamed files */
  beforeOrig: Map<string, string>
  /** every file in scope on each side (source or not) → size in bytes; before keys are ORIGINAL paths */
  sizesB: Map<string, number>
  sizesA: Map<string, number>
  /** files skipped from parsing in huge repos */
  truncatedFiles?: number
  maxFiles?: number
}

const reverse = (M: SideModel): Map<string, Set<string>> => {
  const rev = new Map<string, Set<string>>()
  for (const [s, ts] of M.imports) for (const t of ts.keys()) (rev.get(t) ?? rev.set(t, new Set()).get(t)!).add(s)
  return rev
}
/** transitive importers of `start` (not including itself) */
export function blastOf(rev: Map<string, Set<string>>, start: string[], cap = 100000): Set<string> {
  const seen = new Set<string>(start)
  const out = new Set<string>()
  let frontier = [...start]
  while (frontier.length && out.size < cap) {
    const next: string[] = []
    for (const f of frontier) for (const s of rev.get(f) ?? []) if (!seen.has(s)) { seen.add(s); out.add(s); next.push(s) }
    frontier = next
  }
  return out
}

const fnCounts = (B: SideModel, A: SideModel, path: string, oldPath: string): [number, number, number] => {
  const b = new Map((B.fnsByFile.get(path) ?? B.fnsByFile.get(oldPath) ?? []).map((r) => [`${r.f.owner ?? ''}.${r.f.name}`, r.f.sig]))
  const a = new Map((A.fnsByFile.get(path) ?? []).map((r) => [`${r.f.owner ?? ''}.${r.f.name}`, r.f.sig]))
  let ad = 0; let rm = 0; let md = 0
  for (const [k, s] of a) { if (!b.has(k)) ad++; else if (b.get(k) !== s) md++ }
  for (const k of b.keys()) if (!a.has(k)) rm++
  return [ad, rm, md]
}

export function buildCodeMap(inp: MapInput): CodeMap {
  const { before: B, after: A, changed, beforeOrig } = inp
  const maxFiles = inp.maxFiles ?? 8000
  const renamedTo = new Map<string, string>()   // old → new
  for (const [canon, orig] of beforeOrig) renamedTo.set(orig, canon)
  for (const f of changed) if (f.status === 'R' && f.oldPath) renamedTo.set(f.oldPath, f.path)
  const changedBy = new Map(changed.map((f) => [f.path, f]))
  const revB = reverse(B); const revA = reverse(A)

  // canonical path set: after paths + before paths mapped through renames
  const canonB = new Map<string, number>()
  for (const [p, sz] of inp.sizesB) canonB.set(renamedTo.get(p) ?? p, sz)
  const paths = [...new Set([...canonB.keys(), ...inp.sizesA.keys()])].sort()

  const changedSet = new Set<string>()
  for (const p of paths) {
    const c = changedBy.get(p)
    if (c || !canonB.has(p) || !inp.sizesA.has(p)) changedSet.add(p)
  }
  // affected = unchanged files that transitively import a changed file (either side)
  const seeds = [...changedSet]
  const affected = new Set([...blastOf(revA, seeds), ...blastOf(revB, seeds)].filter((p) => !changedSet.has(p)))

  // hubs: importer count ≥ max(5, top 3 %) on the after side (before for removed files)
  const inCount = (rev: Map<string, Set<string>>, p: string) => rev.get(p)?.size ?? 0
  const counts = paths.map((p) => (inp.sizesA.has(p) ? inCount(revA, p) : inCount(revB, p))).filter((n) => n > 0).sort((a, b) => b - a)
  // small repos: a fixed 5; big ones: the top 3 % so "hub" stays rare (codemap flags files imported by many)
  const p97 = counts.length >= 60 ? counts[Math.floor(counts.length * 0.03)] : 0
  const hubMin = Math.max(5, p97)

  let files: MapFile[] = paths.map((p) => {
    const inB = canonB.has(p); const inA = inp.sizesA.has(p)
    const c = changedBy.get(p)
    const oldPath = c?.oldPath ?? beforeOrig.get(p)
    const status: DiffStatus = !inB ? 'added' : !inA ? 'removed' : c?.status === 'R' || (oldPath && oldPath !== p) ? (c && (c.add || c.del) ? 'modified' : 'moved') : c ? 'modified' : 'unchanged'
    const fb = B.files.get(p); const fa = A.files.get(p)
    const f: MapFile = { path: p, status }
    if (oldPath && oldPath !== p) f.oldPath = oldPath
    if (affected.has(p)) f.affected = true
    const lang = (fa ?? fb)?.lang ?? c?.lang
    if (lang) f.lang = lang
    if (inB) f.bytesB = canonB.get(p)
    if (inA) f.bytesA = inp.sizesA.get(p)
    if (fb) f.linesB = fb.lines
    if (fa) f.linesA = fa.lines
    if (c?.add !== undefined) f.add = c.add
    if (c?.del !== undefined) f.del = c.del
    if (fb || fa) {
      const ib = revB.get(p); const ia = revA.get(p)
      f.inB = ib?.size ?? 0; f.inA = ia?.size ?? 0
      f.out = (inA ? A.imports.get(p)?.size : B.imports.get(p)?.size) ?? 0
      const gained = [...(ia ?? [])].filter((x) => !ib?.has(x)).sort()
      const lost = [...(ib ?? [])].filter((x) => !ia?.has(x)).sort()
      if (gained.length) f.gained = gained.slice(0, 20)
      if (lost.length) f.lost = lost.slice(0, 20)
      const cur = [...((inA ? ia : ib) ?? [])].sort()
      if (cur.length) f.importers = cur.slice(0, 12)
      if (Math.max(f.inA, f.inB) >= hubMin) f.hub = true
      if (status !== 'unchanged') {
        f.blast = new Set([...blastOf(revA, [p]), ...blastOf(revB, [p])]).size
        const fc = fnCounts(B, A, p, oldPath ?? p)
        if (fc[0] + fc[1] + fc[2]) f.fns = fc
      }
    }
    return f
  })

  let truncated = 0
  if (files.length > maxFiles) {
    // huge repo: keep changed + affected + hubs, then the folders that contain changes
    const dirs = new Set(files.filter((f) => f.status !== 'unchanged').map((f) => posix.dirname(f.path)))
    const rank = (f: MapFile) => (f.status !== 'unchanged' ? 0 : f.affected || f.hub ? 1 : dirs.has(posix.dirname(f.path)) ? 2 : 3)
    const sorted = [...files].sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : 1))
    const keep = new Set(sorted.slice(0, maxFiles).map((f) => f.path))
    truncated = files.length - keep.size
    files = files.filter((f) => keep.has(f.path))
  }

  const sum = (xs: (number | undefined)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0)
  const hubs = files.filter((f) => f.hub).sort((a, b) => Math.max(b.inA ?? 0, b.inB ?? 0) - Math.max(a.inA ?? 0, a.inB ?? 0) || (a.path < b.path ? -1 : 1)).slice(0, 30).map((f) => f.path)
  const srcCount = B.files.size + A.files.size
  const coverage = !srcCount ? 'none' : inp.truncatedFiles ? 'partial' : 'complete'
  return {
    files,
    totals: {
      filesB: files.filter((f) => f.bytesB !== undefined).length, filesA: files.filter((f) => f.bytesA !== undefined).length,
      bytesB: sum(files.map((f) => f.bytesB)), bytesA: sum(files.map((f) => f.bytesA)),
      linesB: sum([...B.files.values()].map((f) => f.lines)), linesA: sum([...A.files.values()].map((f) => f.lines)),
      add: sum(changed.map((f) => f.add)), del: sum(changed.map((f) => f.del)),
      changed: files.filter((f) => f.status !== 'unchanged').length, affected: files.filter((f) => f.affected).length
    },
    hubMin, hubs, coverage,
    ...(coverage === 'partial' ? { coverageNote: `大仓库只解析了改动所在的目录（跳过 ${inp.truncatedFiles} 个源文件），这些文件的引用关系不完整` } : coverage === 'none' ? { coverageNote: '没有可解析的源代码文件，只能显示大小与行数变化' } : {}),
    ...(truncated ? { truncated } : {})
  }
}

// ------------------------------------------------------------------------------------------------ static tour
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
export function fileLayer(p: string): string {
  const l = layerOf(componentOf(p, new Set()))
  if (l !== 'other') return l
  return layerOf(posix.basename(p).replace(/\.[^.]+$/, ''))
}
const STATUS_WORD: Record<DiffStatus, string> = { added: '新增', removed: '删除', modified: '修改', moved: '移动', unchanged: '未变' }

/** reading order over changed files: callers before callees (Kahn on importer → imported), layer order breaks ties */
export function tourOrder(paths: string[], importsOf: (p: string) => Iterable<string>): string[] {
  const set = new Set(paths)
  const out = new Map<string, Set<string>>(); const indeg = new Map<string, number>(paths.map((p) => [p, 0]))
  for (const p of paths) {
    const ts = new Set([...importsOf(p)].filter((t) => set.has(t) && t !== p))
    out.set(p, ts)
    for (const t of ts) indeg.set(t, (indeg.get(t) ?? 0) + 1)
  }
  const rank = (p: string) => LAYER_ORDER.indexOf(fileLayer(p))
  const cmp = (a: string, b: string) => rank(a) - rank(b) || (a < b ? -1 : 1)
  const ready = paths.filter((p) => indeg.get(p) === 0).sort(cmp)
  const order: string[] = []
  const done = new Set<string>()
  while (order.length < paths.length) {
    if (!ready.length) {   // cycle: take the remaining file with the fewest unresolved importers
      const rest = paths.filter((p) => !done.has(p)).sort((a, b) => indeg.get(a)! - indeg.get(b)! || cmp(a, b))
      ready.push(rest[0]); indeg.set(rest[0], 0)
    }
    const p = ready.shift()!
    if (done.has(p)) continue
    done.add(p); order.push(p)
    for (const t of [...out.get(p)!].sort(cmp)) { const d = indeg.get(t)! - 1; indeg.set(t, d); if (d === 0 && !done.has(t)) { ready.push(t); ready.sort(cmp) } }
  }
  return order
}

export function buildTour(inp: { before: SideModel; after: SideModel; changed: ChangedFile[]; beforeOrig: Map<string, string>; map: CodeMap }, maxFiles = 40, maxFns = 6): Tour {
  const { before: B, after: A, changed, map } = inp
  const mf = new Map(map.files.map((f) => [f.path, f]))
  const src = changed.filter((c) => A.files.has(c.path) || B.files.has(c.path))
  const other = changed.filter((c) => !A.files.has(c.path) && !B.files.has(c.path))
  const importsOf = (p: string) => (A.imports.get(p) ?? B.imports.get(p) ?? new Map()).keys()
  const order = tourOrder(src.map((c) => c.path), importsOf).slice(0, maxFiles)
  const stepOfFile = new Map<string, TourStep>()
  const stepOfFn = new Map<string, TourStep>()
  const groups = new Map<string, TourStep[]>()
  let n = 0
  const topo = new Map<string, number>()
  for (const p of order) {
    topo.set(`t:${p}`, n)
    const c = changed.find((x) => x.path === p)!
    const m = mf.get(p)
    const st: DiffStatus = m?.status ?? (c.status === 'A' ? 'added' : c.status === 'D' ? 'removed' : 'modified')
    const orig = c.oldPath ?? inp.beforeOrig.get(p) ?? p
    const step: TourStep = { n: String(++n), id: `t:${p}`, title: posix.basename(p), status: st, kind: 'file', file: p,
      ...(st !== 'added' ? { before: { file: orig, line: 1 } } : {}), ...(st !== 'removed' ? { after: { file: p, line: 1 } } : {}), why: '', ...(m?.hub ? { hub: true } : {}) }
    stepOfFile.set(p, step)
    const layer = fileLayer(p)
    ;(groups.get(layer) ?? groups.set(layer, []).get(layer)!).push(step)
    // changed functions / methods inside, in source order
    const bf = new Map((B.fnsByFile.get(p) ?? []).map((r) => [`${r.f.owner ?? ''}.${r.f.name}`, r]))
    const af = new Map((A.fnsByFile.get(p) ?? []).map((r) => [`${r.f.owner ?? ''}.${r.f.name}`, r]))
    const fns: { k: string; s: DiffStatus; line: number }[] = []
    for (const [k, r] of af) { const b = bf.get(k); if (!b) fns.push({ k, s: 'added', line: r.f.line }); else if (b.f.sig !== r.f.sig) fns.push({ k, s: 'modified', line: r.f.line }) }
    for (const [k, r] of bf) if (!af.has(k)) fns.push({ k, s: 'removed', line: r.f.line + 0.5 })
    fns.sort((x, y) => x.line - y.line)
    fns.slice(0, maxFns).forEach((x, i) => {
      const a = af.get(x.k); const b = bf.get(x.k)
      const r = (a ?? b)!
      const label = `${r.f.owner ? r.f.owner + '.' : ''}${r.f.name}`
      const delta = a && b ? a.f.size - b.f.size : 0
      const fs: TourStep = { n: `${n}${LETTERS[i]}`, id: `t:${r.id}`, title: `${label}()`, status: x.s, kind: 'function', file: p,
        ...(b ? { before: { file: orig, line: b.f.line, endLine: b.f.endLine } } : {}), ...(a ? { after: { file: p, line: a.f.line, endLine: a.f.endLine } } : {}),
        why: x.s === 'added' ? `新增${r.f.owner ? '方法' : '函数'}（${r.f.size} 行）` : x.s === 'removed' ? `删除${r.f.owner ? '方法' : '函数'}` : `函数体改动${delta ? `（${delta > 0 ? '+' : '−'}${Math.abs(delta)} 行）` : ''}` }
      stepOfFn.set(a?.id ?? b!.id, fs)
      if (b) stepOfFn.set(b.id, fs)
      groups.get(layer)!.push(fs)
    })
    if (fns.length > maxFns) step.why = `另有 ${fns.length - maxFns} 个函数改动未列出`
  }
  // edges: file imports between steps, function calls between steps
  for (const [p, step] of stepOfFile) {
    const next = [...importsOf(p)].map((t) => stepOfFile.get(t)?.id).filter((x): x is string => !!x && x !== step.id)
    if (next.length) step.next = [...new Set(next)]
  }
  for (const [fid, step] of stepOfFn) {
    const calls = A.calls.get(fid) ?? B.calls.get(fid)
    if (!calls) continue
    const next = [...calls.keys()].map((t) => stepOfFn.get(t)?.id).filter((x): x is string => !!x && x !== step.id)
    if (next.length) step.next = [...new Set([...(step.next ?? []), ...next])]
  }
  // number in display order: groups by their earliest file in the reading order, steps in reading order inside
  const sortedGroups = [...groups].sort((a, b) => topo.get(a[1][0].id)! - topo.get(b[1][0].id)!)
  let k = 0
  for (const [, steps] of sortedGroups) {
    let li = 0
    for (const s of steps) { if (s.kind === 'file') { s.n = String(++k); li = 0 } else s.n = `${k}${LETTERS[li++]}` }
  }
  n = k
  const nOf = new Map([...stepOfFile.values(), ...stepOfFn.values()].map((s) => [s.id, s.n]))
  for (const step of stepOfFile.values()) {
    const m = mf.get(step.file)
    const parts: string[] = []
    parts.push(m?.oldPath ? `从 ${m.oldPath} ${step.status === 'moved' ? '移动' : '重命名并修改'}` : `${STATUS_WORD[step.status]}文件`)
    if (m && (m.add || m.del)) parts.push(`+${m.add ?? 0} −${m.del ?? 0} 行`)
    const imp = step.status === 'removed' ? m?.inB : m?.inA
    if (imp) parts.push(`被 ${imp} 个文件引用`)
    if (step.hub) parts.push('热点文件，改动影响面大')
    if (m?.lost?.length && step.status !== 'removed') parts.push(`失去 ${m.lost.length} 个引用方`)
    if (step.next?.length) parts.push(`引用第 ${step.next.map((x) => nOf.get(x)).join('、')} 步`)
    step.why = parts.join(' · ') + (step.why ? ` · ${step.why}` : '')
  }
  for (const step of stepOfFn.values()) if (step.next?.length) step.why += ` · 调用第 ${step.next.map((x) => nOf.get(x)).join('、')} 步`
  const out: TourGroup[] = sortedGroups.map(([layer, steps]) => ({ id: `g:${layer}`, title: layerName(layer), steps }))
  if (other.length) {
    out.push({ id: 'g:other-files', title: '其他改动（文档 / 配置 / 资源）', guide: '没有代码结构，建议最后快速浏览', steps: other.slice(0, 15).map((c) => {
      const st: DiffStatus = c.status === 'A' ? 'added' : c.status === 'D' ? 'removed' : c.status === 'R' ? 'moved' : 'modified'
      return { n: String(++n), id: `t:${c.path}`, title: posix.basename(c.path), status: st, kind: 'file' as const, file: c.path,
        ...(st !== 'added' ? { before: { file: c.oldPath ?? c.path, line: 1 } } : {}), ...(st !== 'removed' ? { after: { file: c.path, line: 1 } } : {}),
        why: `${STATUS_WORD[st]}${c.add || c.del ? ` · +${c.add ?? 0} −${c.del ?? 0} 行` : ''}` }
    }) })
  }
  const total = order.length
  const first = order[0]
  return {
    id: 'tour:static', source: 'static', title: total ? `阅读路线：${total} 个源文件，按调用顺序` : '阅读路线',
    summary: total ? `从调用方读到被调用方：先看 ${posix.basename(first)}${src.length > total ? `（只列前 ${total} 个，共 ${src.length} 个）` : ''}` : '这次改动没有源代码文件',
    groups: out
  }
}
