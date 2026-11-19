// Pure helpers for 代码地图 / 改动导览 (no React / DOM): folder tree with aggregates, squarified treemap,
// colouring, Markdown / JSON exports, tour → DiffGraph. Unit-tested in tests/codemap.test.ts.
import type { CodeMap, DiffGraph, DiffStatus, GEdge, GNode, MapFile, Tour, TourStep, VizResult } from '../../../shared/viz'
import { scopeLabel } from '../../../shared/viz'

export type MapScope = 'changed' | 'all'
export type ColorBy = 'status' | 'heat' | 'growth'
export type SizeSide = 'before' | 'after'

export interface Agg { files: number; bytesB: number; bytesA: number; add: number; del: number; changed: number; affected: number; hubs: number }
export interface MapDir { name: string; path: string; dirs: MapDir[]; files: MapFile[]; agg: Agg; status: DiffStatus }

export const STATUS_WORD: Record<DiffStatus, string> = { added: '新增', removed: '删除', modified: '修改', moved: '移动', unchanged: '未变' }

export function fmtBytes(n?: number): string {
  if (n === undefined) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
export const fmtDelta = (b?: number, a?: number, f: (n: number) => string = String): string => {
  const d = (a ?? 0) - (b ?? 0)
  return d === 0 ? '' : `${d > 0 ? '+' : '−'}${f(Math.abs(d))}`
}
export const importersOf = (f: MapFile): number => (f.status === 'removed' ? f.inB ?? 0 : f.inA ?? 0)

/** files shown for a scope + search: 'changed' = changed + affected + files whose importers changed */
export function filterFiles(map: CodeMap, scope: MapScope, q = ''): MapFile[] {
  const s = q.trim().toLowerCase()
  return map.files.filter((f) => (scope === 'all' || f.status !== 'unchanged' || f.affected || !!f.gained?.length || !!f.lost?.length) && (!s || f.path.toLowerCase().includes(s)))
}

const emptyAgg = (): Agg => ({ files: 0, bytesB: 0, bytesA: 0, add: 0, del: 0, changed: 0, affected: 0, hubs: 0 })
const dirStatus = (d: MapDir): DiffStatus => {
  const all = [...d.files.map((f) => f.status), ...d.dirs.map((x) => x.status)]
  return !all.length ? 'unchanged' : all.every((s) => s === 'added') ? 'added' : all.every((s) => s === 'removed') ? 'removed' : all.some((s) => s !== 'unchanged') ? 'modified' : 'unchanged'
}

/** nested folders (single-child chains compressed like "src/main/viz"), sorted: folders first, then files */
export function buildTree(files: MapFile[]): MapDir {
  const root: MapDir = { name: '', path: '', dirs: [], files: [], agg: emptyAgg(), status: 'unchanged' }
  const byPath = new Map<string, MapDir>([['', root]])
  for (const f of files) {
    const parts = f.path.split('/')
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/')
      let d = byPath.get(p)
      if (!d) { d = { name: parts[i], path: p, dirs: [], files: [], agg: emptyAgg(), status: 'unchanged' }; byPath.set(p, d); cur.dirs.push(d) }
      cur = d
    }
    cur.files.push(f)
  }
  const fin = (d: MapDir): MapDir => {
    d.dirs = d.dirs.map(fin)
    // compress a folder holding exactly one folder and no files
    while (d !== root && d.dirs.length === 1 && !d.files.length) { const c = d.dirs[0]; d.name = `${d.name}/${c.name}`; d.path = c.path; d.dirs = c.dirs; d.files = c.files; d.agg = c.agg }
    const a = emptyAgg()
    for (const f of d.files) {
      a.files++; a.bytesB += f.bytesB ?? 0; a.bytesA += f.bytesA ?? 0; a.add += f.add ?? 0; a.del += f.del ?? 0
      if (f.status !== 'unchanged') a.changed++; if (f.affected) a.affected++; if (f.hub) a.hubs++
    }
    for (const c of d.dirs) for (const k of Object.keys(a) as (keyof Agg)[]) a[k] += c.agg[k]
    d.agg = a
    d.dirs.sort((x, y) => (x.name < y.name ? -1 : 1))
    d.files.sort((x, y) => (x.path < y.path ? -1 : 1))
    d.status = dirStatus(d)
    return d
  }
  return fin(root)
}

/** css class of a file cell / dot */
export function colorClass(f: MapFile, by: ColorBy, hubMin: number): string {
  if (by === 'status') return f.status === 'unchanged' ? (f.affected ? 'cm-affected' : 'cm-un') : `cm-${f.status}`
  if (by === 'heat') { const n = Math.max(f.inA ?? 0, f.inB ?? 0); return n >= hubMin ? 'cm-hot3' : n >= Math.max(3, Math.ceil(hubMin / 2)) ? 'cm-hot2' : n >= 1 ? 'cm-hot1' : 'cm-hot0' }
  if (f.status === 'added') return 'cm-grnew'
  if (f.status === 'removed') return 'cm-grgone'
  const b = f.bytesB ?? 0; const a = f.bytesA ?? 0
  if (a === b) return 'cm-gr0'
  const r = b ? (a - b) / b : 1
  return r > 0.2 ? 'cm-grup2' : r > 0 ? 'cm-grup1' : r < -0.2 ? 'cm-grdn2' : 'cm-grdn1'
}

export function fileTip(f: MapFile, hubMin: number): string {
  const L: string[] = [f.path]
  L.push(`状态：${STATUS_WORD[f.status]}${f.oldPath ? `（原 ${f.oldPath}）` : ''}${f.status === 'unchanged' && f.affected ? ' · 可能受影响（依赖了改动的文件）' : ''}`)
  L.push(`大小：${fmtBytes(f.bytesB)} → ${fmtBytes(f.bytesA)}`)
  if (f.linesB !== undefined || f.linesA !== undefined) L.push(`行数：${f.linesB ?? '—'} → ${f.linesA ?? '—'}`)
  if (f.add || f.del) L.push(`改动：+${f.add ?? 0} −${f.del ?? 0} 行`)
  if (f.inA !== undefined || f.inB !== undefined) L.push(`被引用：${f.inB ?? 0} → ${f.inA ?? 0} 个文件${f.hub ? `（热点，≥ ${hubMin}）` : ''}`)
  if (f.blast) L.push(`影响面：${f.blast} 个文件直接或间接依赖它`)
  if (f.gained?.length) L.push(`新增引用方：${f.gained.slice(0, 5).join('、')}${f.gained.length > 5 ? ` 等 ${f.gained.length} 个` : ''}`)
  if (f.lost?.length) L.push(`失去引用方：${f.lost.slice(0, 5).join('、')}${f.lost.length > 5 ? ` 等 ${f.lost.length} 个` : ''}`)
  if (f.fns) L.push(`函数：新增 ${f.fns[0]} · 删除 ${f.fns[1]} · 修改 ${f.fns[2]}`)
  return L.join('\n')
}

// ------------------------------------------------------------------------------------------------ treemap
export interface Rect { x: number; y: number; w: number; h: number }
export interface Cell extends Rect { id: string; depth: number; dir?: MapDir; file?: MapFile; label: boolean }

/** squarified treemap (Bruls et al.) of positive values inside a rect; deterministic for sorted input */
export function squarify<T extends { value: number; key?: string }>(items: T[], r: Rect): (T & Rect)[] {
  const out: (T & Rect)[] = []
  const list = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value || ((a.key ?? '') < (b.key ?? '') ? -1 : (a.key ?? '') > (b.key ?? '') ? 1 : 0))
  const total = list.reduce((s, i) => s + i.value, 0)
  if (!total || r.w <= 0 || r.h <= 0) return out
  const scale = (r.w * r.h) / total
  let { x, y, w, h } = r
  let i = 0
  while (i < list.length) {
    const side = Math.min(w, h)
    if (side <= 0.5) break
    const row: T[] = []
    let rowSum = 0
    let best = Infinity
    while (i < list.length) {
      const v = list[i].value * scale
      const s = rowSum + v
      const mx = Math.max(...row.map((it) => it.value * scale), v); const mn = Math.min(...row.map((it) => it.value * scale), v)
      const worst = Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn))
      if (row.length && worst > best) break
      row.push(list[i]); rowSum = s; best = worst; i++
    }
    const thick = rowSum / side
    let off = 0
    for (const it of row) {
      const len = (it.value * scale) / thick
      if (w >= h) out.push({ ...it, x, y: y + off, w: thick, h: len }); else out.push({ ...it, x: x + off, y, w: len, h: thick })
      off += len
    }
    if (w >= h) { x += thick; w -= thick } else { y += thick; h -= thick }
  }
  return out
}

export const sizeOf = (f: MapFile, side: SizeSide): number => Math.max(0, side === 'before' ? f.bytesB ?? 0 : f.bytesA ?? 0)
const dirSize = (d: MapDir, side: SizeSide): number => (side === 'before' ? d.agg.bytesB : d.agg.bytesA)

/** nested treemap cells; folders get a 16 px title band when they are big enough */
export function treemapCells(root: MapDir, r: Rect, side: SizeSide, minArea = 4): Cell[] {
  const out: Cell[] = []
  const walk = (d: MapDir, box: Rect, depth: number) => {
    const head = depth > 0 && box.h > 34 && box.w > 40 ? 16 : 0
    const pad = depth > 0 && box.w > 12 && box.h > 12 ? 2 : 0
    if (depth > 0) out.push({ id: `d:${d.path}`, depth, dir: d, ...box, label: head > 0 })
    const inner: Rect = { x: box.x + pad, y: box.y + head + pad, w: box.w - pad * 2, h: box.h - head - pad * 2 }
    // value floor of 1 byte so empty files still get a sliver (and a stable position)
    const items = [...d.dirs.map((x) => ({ key: x.path, value: Math.max(dirSize(x, side), x.agg.files ? 1 : 0), dir: x, file: undefined as MapFile | undefined })),
      ...d.files.map((f) => ({ key: f.path, value: (side === 'before' ? f.bytesB : f.bytesA) === undefined ? 0 : Math.max(1, sizeOf(f, side)), dir: undefined as MapDir | undefined, file: f }))]
    for (const it of squarify(items, inner)) {
      if (it.w * it.h < minArea) continue
      const box2 = { x: it.x, y: it.y, w: it.w, h: it.h }
      if (it.dir) walk(it.dir, box2, depth + 1)
      else out.push({ id: `f:${it.file!.path}`, depth: depth + 1, file: it.file, ...box2, label: box2.w > 46 && box2.h > 18 })
    }
  }
  walk(root, r, 0)
  return out
}

// ------------------------------------------------------------------------------------------------ exports
const COV: Record<CodeMap['coverage'], string> = { complete: '完整', partial: '部分', none: '无（没有源代码）' }

/** codemap-style review bundle (like `codemap blast-radius --ref`): summary, changed tree, hubs, importers */
export function codemapMarkdown(r: VizResult): string {
  const m = r.map
  if (!m) return ''
  const t = m.totals
  const L: string[] = []
  L.push(`# 代码地图对比：${scopeLabel(r.scope)}`, '')
  L.push(`- 范围：${r.beforeLabel} → ${r.afterLabel}${r.filter ? `（路径：${r.filter}）` : ''}`)
  L.push(`- 文件：${t.filesB} → ${t.filesA}，改动 ${t.changed} 个，可能受影响 ${t.affected} 个`)
  L.push(`- 大小：${fmtBytes(t.bytesB)} → ${fmtBytes(t.bytesA)}；源码行：${t.linesB} → ${t.linesA}；+${t.add} −${t.del} 行`)
  L.push(`- 依赖覆盖：${COV[m.coverage]}${m.coverageNote ? `（${m.coverageNote}）` : ''}`, '')
  const changedHubs = m.files.filter((f) => f.hub && f.status !== 'unchanged')
  if (changedHubs.length) {
    L.push('## ⚠ 改动了热点文件', '')
    for (const f of changedHubs) L.push(`- **${f.path}** 被 ${importersOf(f)} 个文件引用，影响面 ${f.blast ?? 0} 个文件`)
    L.push('')
  }
  L.push('## 改动的文件', '', '| 文件 | 状态 | 大小 | 行 | 被引用 | 影响面 |', '|---|---|---|---|---|---|')
  for (const f of m.files.filter((x) => x.status !== 'unchanged').sort((a, b) => (b.blast ?? 0) - (a.blast ?? 0) || (a.path < b.path ? -1 : 1))) {
    L.push(`| ${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}${f.hub ? ' 🔥' : ''} | ${STATUS_WORD[f.status]} | ${fmtBytes(f.bytesB)} → ${fmtBytes(f.bytesA)} | +${f.add ?? 0} −${f.del ?? 0} | ${f.inB ?? 0} → ${f.inA ?? 0} | ${f.blast ?? 0} |`)
  }
  L.push('')
  const deps = m.files.filter((f) => f.gained?.length || f.lost?.length)
  if (deps.length) {
    L.push('## 引用关系变化', '')
    for (const f of deps) {
      if (f.gained?.length) L.push(`- ${f.path}：新增引用方 ${f.gained.join('、')}`)
      if (f.lost?.length) L.push(`- ${f.path}：失去引用方 ${f.lost.join('、')}`)
    }
    L.push('')
  }
  const aff = m.files.filter((f) => f.affected)
  if (aff.length) {
    L.push(`## 可能受影响（未改动，但依赖了改动的文件）`, '')
    for (const f of aff.slice(0, 60)) L.push(`- ${f.path}`)
    if (aff.length > 60) L.push(`- ……共 ${aff.length} 个`)
    L.push('')
  }
  if (m.hubs.length) L.push(`## 热点文件（被引用 ≥ ${m.hubMin}）`, '', ...m.hubs.slice(0, 15).map((p) => { const f = m.files.find((x) => x.path === p)!; return `- ${p}（${importersOf(f)}←）` }), '')
  L.push('_由 GitLoom 织线 · 代码地图生成_')
  return L.join('\n')
}

export function codemapJson(r: VizResult): string {
  return JSON.stringify({ schema_version: 'gitloom.codemap/v1', scope: r.scope, before: r.beforeLabel, after: r.afterLabel, filter: r.filter ?? null, ...r.map }, null, 2)
}

export function tourMarkdown(t: Tour, r: VizResult): string {
  const L: string[] = [`# ${t.title}`, '']
  L.push(`- 范围：${r.beforeLabel} → ${r.afterLabel}`)
  if (t.question) L.push(`- 问题：${t.question}`)
  if (t.source === 'ai' && t.model) L.push(`- 由 AI 生成（${t.model}），步骤均引用静态分析得到的真实代码位置`)
  if (t.summary) L.push('', t.summary)
  L.push('')
  for (const g of t.groups) {
    L.push(`## ${g.title}`, '')
    if (g.guide) L.push(`> ${g.guide}`, '')
    for (const s of g.steps) {
      const loc = s.after ?? s.before
      const where = loc ? `\`${loc.file}:${loc.line}\`` : `\`${s.file}\``
      L.push(`${s.kind === 'file' ? '' : '  '}- **${s.n}. ${s.title}** [${STATUS_WORD[s.status]}] ${where}${s.why ? ` — ${s.why}` : ''}`)
    }
    L.push('')
  }
  return L.join('\n')
}

/** tour → graph for GraphDiff.
 *  static tour: one node per FILE step listing its changed functions as members (11 files stay readable instead of
 *  60 tiny boxes), edges = imports / calls between files + dashed reading-order links so it reads as a path.
 *  AI tour: one node per step (≤ 30), edges = reading order + real calls. */
export function tourGraph(t: Tour): DiffGraph {
  const nodes: GNode[] = []
  const edges: GEdge[] = []
  const edgeStatus = (a: DiffStatus, b: DiffStatus): DiffStatus => (a === 'added' || b === 'added' ? 'added' : a === 'removed' || b === 'removed' ? 'removed' : 'unchanged')
  const locSub = (s: TourStep) => { const l = s.after ?? s.before; return `${(l?.file ?? s.file).split('/').pop()}:${l?.line ?? ''}` }
  if (t.source === 'static') {
    const owner = new Map<string, string>()   // step id → file step id
    const files: TourStep[] = []
    for (const g of t.groups) {
      let cur: GNode | null = null
      for (const s of g.steps) {
        if (s.kind === 'file' || !cur) {
          cur = { id: s.id, label: `${s.n} · ${s.title}`, kind: 'file', status: s.status, sub: g.title, note: s.why, members: [],
            ...(s.before ? { before: s.before } : {}), ...(s.after ? { after: s.after } : {}), ...(s.hub ? { hub: true } : {}) }
          nodes.push(cur); files.push(s); owner.set(s.id, s.id)
          if (s.kind === 'file') continue
        }
        cur.members!.push({ name: `${s.n} ${s.title.replace(/\(\)$/, '')}`, kind: 'method', status: s.status, sig: s.why })
        owner.set(s.id, cur.id)
      }
    }
    const st = new Map(nodes.map((n) => [n.id, n.status]))
    const seen = new Set<string>()
    const add = (a: string, b: string, kind: GEdge['kind'], weight?: number) => {
      if (a === b || seen.has(`${a}>${b}`)) return
      seen.add(`${a}>${b}`)
      edges.push({ id: `tn${edges.length}`, source: a, target: b, kind, status: edgeStatus(st.get(a)!, st.get(b)!), ...(weight ? { weight } : {}) })
    }
    for (const g of t.groups) for (const s of g.steps) for (const nx of s.next ?? []) { const a = owner.get(s.id); const b = owner.get(nx); if (a && b) add(a, b, s.kind === 'file' ? 'import' : 'call') }
    // reading order: n → n+1 when not already linked either way (so unrelated files still read top → bottom)
    for (let i = 0; i + 1 < files.length; i++) { const a = files[i].id; const b = files[i + 1].id; if (!seen.has(`${a}>${b}`) && !seen.has(`${b}>${a}`)) add(a, b, 'flow') }
    for (const n of nodes) if (!n.members!.length) delete n.members
    return { nodes, edges }
  }
  const ids = new Set<string>()
  for (const g of t.groups) for (const s of g.steps) {
    ids.add(s.id)
    nodes.push({ id: s.id, label: `${s.n} · ${s.title}`, kind: s.kind === 'file' ? 'file' : s.kind === 'class' ? 'class' : 'function', status: s.status,
      sub: s.kind === 'file' ? g.title : locSub(s), ...(s.before ? { before: s.before } : {}), ...(s.after ? { after: s.after } : {}), note: s.why, ...(s.hub ? { hub: true } : {}) })
  }
  const status = new Map(nodes.map((n) => [n.id, n.status]))
  for (const g of t.groups) for (const s of g.steps) for (const nx of s.next ?? []) {
    if (!ids.has(nx)) continue
    edges.push({ id: `tn${edges.length}`, source: s.id, target: nx, kind: 'flow', status: edgeStatus(status.get(s.id)!, status.get(nx)!) })
  }
  return { nodes, edges }
}

/** a step as a side-panel node (function steps of the static tour are members, not graph nodes) */
export function stepNode(s: TourStep): GNode {
  return { id: s.id, label: `${s.n} · ${s.title}`, kind: s.kind === 'file' ? 'file' : s.kind === 'class' ? 'class' : 'function', status: s.status,
    sub: `${(s.after ?? s.before)?.file ?? s.file}`, ...(s.before ? { before: s.before } : {}), ...(s.after ? { after: s.after } : {}), note: s.why }
}

/** total / done counts for the 已看过 progress (file + function steps) */
export function tourProgress(t: Tour, seen: Set<string>): { done: number; total: number } {
  const all = t.groups.flatMap((g) => g.steps)
  return { done: all.filter((s) => seen.has(s.id)).length, total: all.length }
}

/** Natural compare ("v1.10" > "v1.9" > "v1.1" > "v1.0") without relying on Intl/ICU (results differed in Electron). */
export function natCmp(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [], tb = b.match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i]
    const nx = /^\d/.test(x), ny = /^\d/.test(y)
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1 }
    else if (x !== y) return x < y ? -1 : 1
  }
  return ta.length - tb.length
}
