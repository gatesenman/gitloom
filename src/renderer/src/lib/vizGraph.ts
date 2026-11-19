// Pure graph helpers for 变更可视化 (no React / DOM): side filtering, focus (changed + N hops), auto-clustering of big
// graphs, search, and text exports (Mermaid / PlantUML). Unit-tested in tests/vizGraph.test.ts.
import type { DiffGraph, DiffStatus, GEdge, GNode, SeqDiagram, SeqItem } from '../../../shared/viz'

export type Side = 'before' | 'after' | 'both'
export const STATUS_LABEL: Record<DiffStatus, string> = { added: '新增', removed: '删除', modified: '修改', moved: '移动', unchanged: '未变' }
export const STATUS_SIGN: Record<DiffStatus, string> = { added: '+', removed: '−', modified: '~', moved: '→', unchanged: '' }

export const visibleOn = (s: DiffStatus, side: Side): boolean => side === 'both' || (side === 'before' ? s !== 'added' : s !== 'removed')
export const isChanged = (s: DiffStatus): boolean => s !== 'unchanged'

/** nodes / edges that exist on one side (groups are kept when any child is) */
export function sideOf(g: DiffGraph, side: Side): DiffGraph {
  if (side === 'both') return g
  const leaf = g.nodes.filter((n) => !n.group && visibleOn(n.status, side))
  const keep = new Set(leaf.map((n) => n.id))
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  for (const n of leaf) { let p = n.parent; while (p && !keep.has(p)) { keep.add(p); p = byId.get(p)?.parent } }
  return { ...g, nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => visibleOn(e.status, side) && keep.has(e.source) && keep.has(e.target)) }
}

/** HEAD / current-state graph for 架构与知识: after-side only, no diff coloring. */
export function presentGraph(g: DiffGraph): DiffGraph {
  const after = sideOf(g, 'after')
  return {
    ...after,
    nodes: after.nodes.map((n) => ({
      ...n,
      status: 'unchanged' as const,
      members: n.members?.map((m) => ({ ...m, status: 'unchanged' as const }))
    })),
    edges: after.edges.map((e) => ({ ...e, status: 'unchanged' as const }))
  }
}

const withAncestors = (g: DiffGraph, keep: Set<string>): Set<string> => {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  for (const id of [...keep]) { let p = byId.get(id)?.parent; while (p && !keep.has(p)) { keep.add(p); p = byId.get(p)?.parent } }
  return keep
}

/** 只看变更 + N 跳邻居 (or the neighbourhood of one node when `center` is given) */
export function focusGraph(g: DiffGraph, hops: number, center?: string): DiffGraph {
  const adj = new Map<string, string[]>()
  for (const e of g.edges) { (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target); (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source) }
  let frontier = center ? [center] : g.nodes.filter((n) => !n.group && isChanged(n.status)).map((n) => n.id)
  const keep = new Set(frontier)
  for (let h = 0; h < hops; h++) {
    const next: string[] = []
    for (const id of frontier) for (const m of adj.get(id) ?? []) if (!keep.has(m)) { keep.add(m); next.push(m) }
    frontier = next
  }
  // keep leaf children of a kept group node (e.g. focus on a changed cluster) out: groups are containers only
  withAncestors(g, keep)
  return { ...g, nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) }
}

const mergeStatus = (xs: DiffStatus[]): DiffStatus => xs.every((s) => s === 'added') ? 'added' : xs.every((s) => s === 'removed') ? 'removed' : xs.some(isChanged) ? 'modified' : 'unchanged'

/** collapse one group node into a cluster leaf, redirecting edges of its descendants */
export function collapse(g: DiffGraph, groupId: string): DiffGraph {
  const kids = new Map<string, string[]>()
  for (const n of g.nodes) if (n.parent) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n.id)
  const desc = new Set<string>()
  const walk = (id: string) => { for (const k of kids.get(id) ?? []) { desc.add(k); walk(k) } }
  walk(groupId)
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const leaves = [...desc].map((id) => byId.get(id)!).filter((n) => !n.group)
  const changed = leaves.filter((n) => isChanged(n.status)).length
  const grp = byId.get(groupId)!
  const cluster: GNode = { ...grp, group: false, kind: 'cluster', count: leaves.reduce((s, n) => s + (n.count ?? 1), 0), status: leaves.length ? mergeStatus(leaves.map((n) => n.status)) : grp.status,
    sub: `${leaves.length} 项${changed ? ` · ${changed} 处改动` : ''}`, note: grp.note ?? leaves.slice(0, 8).map((n) => n.label).join('\n') }
  const map = (id: string) => (desc.has(id) ? groupId : id)
  const edges = new Map<string, GEdge & { _s: DiffStatus[] }>()
  for (const e of g.edges) {
    const s = map(e.source); const t = map(e.target)
    if (s === t) continue
    const k = `${s}>${t}>${e.kind}`
    const x = edges.get(k)
    if (x) { x._s.push(e.status); x.weight = (x.weight ?? 1) + (e.weight ?? 1) }
    else edges.set(k, { ...e, id: s === e.source && t === e.target ? e.id : `cl:${k}`, source: s, target: t, _s: [e.status], weight: e.weight ?? 1 })
  }
  return {
    ...g,
    nodes: g.nodes.filter((n) => !desc.has(n.id)).map((n) => (n.id === groupId ? cluster : n)),
    edges: [...edges.values()].map(({ _s, ...e }) => ({ ...e, status: _s.length > 1 ? mergeStatus(_s) : e.status, ...(_s.length > 1 && !e.label ? { label: `×${_s.length}` } : {}) }))
  }
}

/**
 * Auto-cluster above `max` leaf nodes: collapse groups bottom-up, untouched groups first (largest first), then
 * changed ones (fewest changes first). `expanded` groups are never collapsed (user clicked 展开).
 */
export function autoCluster(g: DiffGraph, max = 150, expanded: Set<string> = new Set()): { graph: DiffGraph; collapsed: string[] } {
  const leafCount = (x: DiffGraph) => x.nodes.filter((n) => !n.group).length
  if (leafCount(g) <= max) return { graph: g, collapsed: [] }
  let cur = g
  const collapsed: string[] = []
  const depth = (x: DiffGraph, id: string) => { const by = new Map(x.nodes.map((n) => [n.id, n])); let d = 0; let p = by.get(id)?.parent; while (p) { d++; p = by.get(p)?.parent } return d }
  for (let pass = 0; pass < 2 && leafCount(cur) > max; pass++) {
    for (;;) {
      if (leafCount(cur) <= max) break
      const groups = cur.nodes.filter((n) => n.group && !expanded.has(n.id))
      if (!groups.length) break
      const kids = new Map<string, GNode[]>()
      for (const n of cur.nodes) if (n.parent) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n)
      // innermost groups only (no group children)
      const inner = groups.filter((x) => !(kids.get(x.id) ?? []).some((k) => k.group))
      const score = inner.map((x) => {
        const ks = kids.get(x.id) ?? []
        const ch = ks.filter((k) => isChanged(k.status)).length
        return { x, ch, size: ks.length, d: depth(cur, x.id) }
      }).filter((s) => s.size > 1 && (pass === 1 || s.ch === 0))
      if (!score.length) break
      score.sort((a, b) => a.ch - b.ch || b.size - a.size || b.d - a.d || (a.x.id < b.x.id ? -1 : 1))
      cur = collapse(cur, score[0].x.id)
      collapsed.push(score[0].x.id)
    }
  }
  return { graph: cur, collapsed }
}

/** collapse an arbitrary set of leaves into one cluster node (edges redirected + aggregated, internal edges dropped) */
export function collapseSet(g: DiffGraph, members: Set<string>, cluster: GNode, dropGroups: Set<string> = new Set()): DiffGraph {
  const leaves = g.nodes.filter((n) => members.has(n.id) && !n.group)
  if (leaves.length < 2) return g
  const changed = leaves.filter((n) => isChanged(n.status)).length
  const dists = leaves.map((n) => n.dist).filter((d): d is number => d !== undefined)
  const node: GNode = {
    ...cluster, group: false, kind: 'cluster', count: leaves.reduce((s, n) => s + (n.count ?? 1), 0),
    status: mergeStatus(leaves.map((n) => n.status)), members: undefined,
    ...(dists.length ? { dist: Math.min(...dists) } : {}),
    sub: cluster.sub ?? `${leaves.length} 项${changed ? ` · ${changed} 处改动` : ''}`,
    note: cluster.note ?? leaves.slice(0, 12).map((n) => n.label).join('\n') + (leaves.length > 12 ? `\n… 还有 ${leaves.length - 12} 项` : '')
  }
  const map = (id: string) => (members.has(id) ? node.id : id)
  const edges = new Map<string, GEdge & { _s: DiffStatus[] }>()
  for (const e of g.edges) {
    const s = map(e.source); const t = map(e.target)
    if (s === t) continue
    if (s === e.source && t === e.target) { edges.set(`${e.id}`, { ...e, _s: [e.status] }); continue }
    const k = `${s}>${t}>${e.kind}`
    const x = edges.get(k)
    if (x) { x._s.push(e.status); x.weight = (x.weight ?? 1) + (e.weight ?? 1) }
    else edges.set(k, { ...e, id: `cl:${k}`, source: s, target: t, _s: [e.status], weight: e.weight ?? 1, label: undefined })
  }
  const first = g.nodes.findIndex((n) => members.has(n.id))
  const nodes = g.nodes.filter((n) => !members.has(n.id) && !dropGroups.has(n.id))
  nodes.splice(Math.min(first, nodes.length), 0, node)
  return { ...g, nodes, edges: [...edges.values()].map(({ _s, ...e }) => ({ ...e, status: _s.length > 1 ? mergeStatus(_s) : e.status, ...(_s.length > 1 ? { label: `×${_s.length}` } : {}) })) }
}

const dirOf = (n: GNode): string | null => { const f = n.after?.file ?? n.before?.file; return f ? (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.') : null }

/**
 * Change-centric clustering for readability (0.5.2): keep every changed node, fold the unchanged context.
 *  1. folders / files without any change → one cluster each (largest first)
 *  2. inside a changed folder / file, the unchanged siblings → one "其他 N 个" cluster
 *  3. loose unchanged leaves (impact / class graphs have no containers) → one cluster per directory
 * Stops as soon as at most `max` leaves are visible. Ids in `expanded` (group ids, `<group>#rest`, `dir:<path>`)
 * are never folded, so a click on a cluster opens it for good.
 */
export function changeCluster(g: DiffGraph, max = 48, expanded: Set<string> = new Set()): { graph: DiffGraph; collapsed: string[] } {
  const leafCount = (x: DiffGraph) => x.nodes.filter((n) => !n.group).length
  if (leafCount(g) <= max) return { graph: g, collapsed: [] }
  let cur = g
  const collapsed: string[] = []
  const kidsOf = (x: DiffGraph) => { const k = new Map<string, GNode[]>(); for (const n of x.nodes) if (n.parent) (k.get(n.parent) ?? k.set(n.parent, []).get(n.parent)!).push(n); return k }
  // 1) untouched containers (innermost first, biggest first)
  for (;;) {
    if (leafCount(cur) <= max) return { graph: cur, collapsed }
    const kids = kidsOf(cur)
    const cand = cur.nodes.filter((n) => n.group && !expanded.has(n.id)).map((x) => ({ x, ks: kids.get(x.id) ?? [] }))
      .filter(({ ks }) => ks.length > 1 && !ks.some((k) => k.group) && !ks.some((k) => isChanged(k.status)))
      .sort((a, b) => b.ks.length - a.ks.length || (a.x.id < b.x.id ? -1 : 1))
    if (!cand.length) break
    cur = collapse(cur, cand[0].x.id); collapsed.push(cand[0].x.id)
  }
  // 2) unchanged siblings inside changed containers
  for (;;) {
    if (leafCount(cur) <= max) return { graph: cur, collapsed }
    const kids = kidsOf(cur)
    const cand = cur.nodes.filter((n) => n.group && !expanded.has(`${n.id}#rest`)).map((x) => ({ x, un: (kids.get(x.id) ?? []).filter((k) => !k.group && k.kind !== 'cluster' && !isChanged(k.status)) }))
      .filter(({ un }) => un.length > 1).sort((a, b) => b.un.length - a.un.length || (a.x.id < b.x.id ? -1 : 1))
    if (!cand.length) break
    const { x, un } = cand[0]
    cur = collapseSet(cur, new Set(un.map((n) => n.id)), { id: `${x.id}#rest`, label: `其他 ${un.length} 个`, kind: 'cluster', status: 'unchanged', parent: x.id, sub: '未改动 · 点击展开' })
    collapsed.push(`${x.id}#rest`)
  }
  // 3) loose unchanged leaves, by directory
  for (;;) {
    if (leafCount(cur) <= max) break
    const buckets = new Map<string, GNode[]>()
    for (const n of cur.nodes) {
      if (n.group || n.parent || n.kind === 'cluster' || isChanged(n.status)) continue
      const d = dirOf(n); if (d === null || expanded.has(`dir:${d}`)) continue
      ;(buckets.get(d) ?? buckets.set(d, []).get(d)!).push(n)
    }
    const best = [...buckets.entries()].filter(([, ns]) => ns.length > 1).sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))[0]
    if (!best) break
    const [d, ns] = best
    cur = collapseSet(cur, new Set(ns.map((n) => n.id)), { id: `dir:${d}`, label: d === '.' ? '根目录' : d.split('/').slice(-2).join('/'), kind: 'cluster', status: 'unchanged', sub: `${ns.length} 个未改动 · 点击展开`, note: `${d}\n` + ns.slice(0, 12).map((n) => n.label).join('\n') })
    collapsed.push(`dir:${d}`)
  }
  // 4) untouched folders / files that are still on their own → one cluster per parent directory
  const up = (id: string) => { const p = id.replace(/^[a-z]+:/i, '').replace(/#rest$/, ''); return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.' }
  for (;;) {
    if (leafCount(cur) <= max) break
    const kids = kidsOf(cur)
    const desc = (id: string): GNode[] => (kids.get(id) ?? []).flatMap((k) => (k.group ? desc(k.id) : [k]))
    const buckets = new Map<string, { groups: GNode[]; leaves: GNode[] }>()
    for (const n of cur.nodes) {
      if (n.parent) continue
      let leaves: GNode[]
      if (n.group) { leaves = desc(n.id); if (!leaves.length || leaves.some((k) => isChanged(k.status))) continue }
      else if (n.kind === 'cluster' && !isChanged(n.status)) leaves = [n]
      else continue
      const d = up(n.id)
      if (expanded.has(`up:${d}`)) continue
      const b = buckets.get(d) ?? buckets.set(d, { groups: [], leaves: [] }).get(d)!
      if (n.group) b.groups.push(n)
      b.leaves.push(...leaves)
    }
    const best = [...buckets.entries()].filter(([, b]) => b.groups.length + b.leaves.filter((l) => !l.parent).length > 1 && b.leaves.length > 1)
      .sort((a, b) => b[1].leaves.length - a[1].leaves.length || (a[0] < b[0] ? -1 : 1))[0]
    if (!best) break
    const [d, b] = best
    const files = b.leaves.reduce((s, n) => s + (n.count ?? 1), 0)
    cur = collapseSet(cur, new Set(b.leaves.map((n) => n.id)), { id: `up:${d}`, label: d === '.' ? '根目录（未改动）' : d.split('/').slice(-2).join('/'), kind: 'cluster', status: 'unchanged', sub: `${files} 项未改动 · 点击展开`, note: `${d}\n` + [...b.groups, ...b.leaves.filter((l) => !l.parent)].slice(0, 12).map((n) => n.label).join('\n') }, new Set(b.groups.map((x) => x.id)))
    collapsed.push(`up:${d}`)
  }
  return { graph: cur, collapsed }
}

/** drop secondary lines that only repeat the container label ("src/lib" under the src/lib folder, "a.ts:12" inside a.ts → "第 12 行") */
export function tidyLabels(g: DiffGraph): DiffGraph {
  const by = new Map(g.nodes.map((n) => [n.id, n]))
  let touched = false
  const nodes = g.nodes.map((n) => {
    const par = n.parent ? by.get(n.parent) : undefined
    if (!n.sub || !par || n.group || n.kind === 'cluster') return n
    const pl = par.label
    const same = (x: string) => x === pl || pl.endsWith('/' + x) || x.endsWith('/' + pl)
    if (same(n.sub)) { touched = true; const { sub: _s, ...rest } = n; return rest }
    const m = /^(.+):(\d+)$/.exec(n.sub)
    if (m && same(m[1])) { touched = true; return { ...n, sub: `第 ${m[2]} 行` } }
    return n
  })
  return touched ? { ...g, nodes } : g
}

/** changed leaves in reading order (left→right for RIGHT layouts, top→bottom for DOWN) for the 改动 i/N navigator */
export function changeOrder(g: DiffGraph, pos: (id: string) => { x: number; y: number } | null, dir: 'RIGHT' | 'DOWN'): string[] {
  const xs = g.nodes.filter((n) => !n.group && isChanged(n.status)).map((n) => ({ id: n.id, p: pos(n.id) })).filter((x): x is { id: string; p: { x: number; y: number } } => !!x.p)
  const band = 60
  return xs.sort((a, b) => dir === 'RIGHT'
    ? Math.round(a.p.x / band) - Math.round(b.p.x / band) || a.p.y - b.p.y || (a.id < b.id ? -1 : 1)
    : Math.round(a.p.y / band) - Math.round(b.p.y / band) || a.p.x - b.p.x || (a.id < b.id ? -1 : 1)).map((x) => x.id)
}

/** shortest path between two nodes: directed first (a → b, then b → a), else ignoring direction. Returns node + edge ids. */
export function shortestPath(g: DiffGraph, a: string, b: string): { nodes: string[]; edges: string[]; directed: boolean } | null {
  if (a === b) return { nodes: [a], edges: [], directed: true }
  const bfs = (from: string, to: string, undirected: boolean) => {
    const adj = new Map<string, { to: string; e: string }[]>()
    const push = (k: string, v: { to: string; e: string }) => (adj.get(k) ?? adj.set(k, []).get(k)!).push(v)
    for (const e of g.edges) { push(e.source, { to: e.target, e: e.id }); if (undirected) push(e.target, { to: e.source, e: e.id }) }
    const prev = new Map<string, { from: string; e: string }>([[from, { from: '', e: '' }]])
    const q = [from]
    while (q.length) {
      const c = q.shift()!
      if (c === to) break
      for (const x of adj.get(c) ?? []) if (!prev.has(x.to)) { prev.set(x.to, { from: c, e: x.e }); q.push(x.to) }
    }
    if (!prev.has(to)) return null
    const nodes = [to]; const edges: string[] = []
    let c = to
    while (c !== from) { const p = prev.get(c)!; edges.unshift(p.e); nodes.unshift(p.from); c = p.from }
    return { nodes, edges }
  }
  const d = bfs(a, b, false) ?? bfs(b, a, false)
  if (d) return { ...d, directed: true }
  const u = bfs(a, b, true)
  return u ? { ...u, directed: false } : null
}

export interface ViewSummary { added: number; removed: number; modified: number; moved: number; unchanged: number; edgesAdded: number; edgesRemoved: number; text: string }
/** one plain-language line per diagram: what changed in THIS picture */
export function viewSummary(g: DiffGraph, noun: string, edgeNoun: string): ViewSummary {
  const c = countStatus(g)
  const ea = g.edges.filter((e) => e.status === 'added').length
  const er = g.edges.filter((e) => e.status === 'removed').length
  const parts: string[] = []
  if (c.added) parts.push(`新增 ${c.added} 个${noun}`)
  if (c.modified) parts.push(`修改 ${c.modified} 个`)
  if (c.removed) parts.push(`删除 ${c.removed} 个`)
  if (c.moved) parts.push(`移动 ${c.moved} 个`)
  if (ea) parts.push(`多了 ${ea} 条${edgeNoun}`)
  if (er) parts.push(`少了 ${er} 条${edgeNoun}`)
  return { ...c, edgesAdded: ea, edgesRemoved: er, text: parts.length ? parts.join('，') : `这张图里没有改动的${noun}` }
}

export function searchNodes(g: DiffGraph, q: string): string[] {
  const s = q.trim().toLowerCase()
  if (!s) return []
  return g.nodes.filter((n) => !n.group && (n.label.toLowerCase().includes(s) || (n.sub ?? '').toLowerCase().includes(s) || n.id.toLowerCase().includes(s))).map((n) => n.id)
}

export function countStatus(g: DiffGraph): Record<DiffStatus, number> {
  const c: Record<DiffStatus, number> = { added: 0, removed: 0, modified: 0, moved: 0, unchanged: 0 }
  for (const n of g.nodes) if (!n.group) c[n.status]++
  return c
}

// ------------------------------------------------------------------------------------------- text exports
const mid = (id: string, ids: Map<string, string>) => { let v = ids.get(id); if (!v) { v = `n${ids.size}`; ids.set(id, v) } return v }
const q = (s: string) => s.replace(/"/g, "'").replace(/[\n\r]+/g, ' ').replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'))
const MERMAID_CLASSES = [
  'classDef added fill:#dcfce7,stroke:#16a34a,color:#14532d',
  'classDef removed fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-dasharray: 5 3',
  'classDef modified fill:#fef3c7,stroke:#d97706,color:#78350f',
  'classDef moved fill:#dbeafe,stroke:#2563eb,color:#1e3a8a',
  'classDef unchanged fill:#f4f4f5,stroke:#a1a1aa,color:#52525b'
]

export type DiagramKind = 'flowchart' | 'state' | 'class'

export function toMermaid(g: DiffGraph, kind: DiagramKind = 'flowchart', dir: 'LR' | 'TD' = 'LR'): string {
  const ids = new Map<string, string>()
  if (kind === 'state') {
    const out = ['stateDiagram-v2', `  %% 图例：＋新增 −删除 ～修改`]
    const init = g.nodes.find((n) => n.kind === 'initial')
    for (const n of g.nodes) if (n.kind === 'state') out.push(`  state "${q(STATUS_SIGN[n.status] + n.label)}" as ${mid(n.id, ids)}`)
    for (const e of g.edges) {
      const s = e.source === init?.id ? '[*]' : mid(e.source, ids)
      out.push(`  ${s} --> ${mid(e.target, ids)}${e.label || isChanged(e.status) ? ` : ${q(`${STATUS_SIGN[e.status]}${e.label ?? ''}`)}` : ''}`)
    }
    for (const n of g.nodes) if (n.kind === 'state' && isChanged(n.status)) out.push(`  class ${mid(n.id, ids)} ${n.status}`)
    out.push(...MERMAID_CLASSES.map((c) => '  ' + c))
    return out.join('\n')
  }
  if (kind === 'class') {
    const out = ['classDiagram']
    for (const n of g.nodes) {
      if (n.group) continue
      const id = mid(n.id, ids)
      out.push(`  class ${id}["${q(STATUS_SIGN[n.status] + n.label)}"] {`)
      if (n.kind === 'interface') out.push('    <<interface>>')
      else if (n.kind === 'enum') out.push('    <<enumeration>>')
      for (const m of n.members ?? []) out.push(`    ${m.status === 'added' ? '+' : m.status === 'removed' ? '-' : m.status === 'modified' ? '~' : ' '}${q(m.name)}${m.kind === 'method' ? '()' : ''}`)
      out.push('  }')
      out.push(`  cssClass "${id}" ${n.status}`)
    }
    for (const e of g.edges) {
      const a = mid(e.source, ids); const b = mid(e.target, ids)
      const arrow = e.kind === 'extends' ? '--|>' : e.kind === 'implements' ? '..|>' : e.status === 'removed' ? '..>' : '-->'
      out.push(`  ${a} ${arrow} ${b}${isChanged(e.status) ? ` : ${STATUS_LABEL[e.status]}` : ''}`)
    }
    out.push(...MERMAID_CLASSES.map((c) => '  ' + c))
    return out.join('\n')
  }
  const out = [`flowchart ${dir}`]
  const kids = new Map<string, GNode[]>()
  const roots: GNode[] = []
  for (const n of g.nodes) { if (n.parent && g.nodes.some((p) => p.id === n.parent)) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n); else roots.push(n) }
  const shape = (n: GNode, id: string) => {
    const l = q(`${STATUS_SIGN[n.status]}${n.label}`)
    return n.kind === 'decision' ? `${id}{"${l}"}` : n.kind === 'start' || n.kind === 'end' ? `${id}(["${l}"])` : n.kind === 'state' ? `${id}("${l}")` : n.kind === 'cluster' ? `${id}[["${l} (${n.count ?? ''})"]]` : `${id}["${l}"]`
  }
  const emit = (n: GNode, ind: string) => {
    const id = mid(n.id, ids)
    if (n.group) { out.push(`${ind}subgraph ${id}["${q(n.label)}"]`); for (const k of kids.get(n.id) ?? []) emit(k, ind + '  '); out.push(`${ind}end`) }
    else out.push(`${ind}${shape(n, id)}:::${n.status}`)
  }
  for (const r of roots) emit(r, '  ')
  g.edges.forEach((e) => {
    const lab = e.label ? `|${q(e.label)}|` : ''
    out.push(`  ${mid(e.source, ids)} ${e.status === 'removed' ? '-.->' : e.status === 'added' ? '==>' : '-->'}${lab} ${mid(e.target, ids)}`)
  })
  out.push(...MERMAID_CLASSES.map((c) => '  ' + c))
  return out.join('\n')
}

const PUML_COLOR: Record<DiffStatus, string> = { added: '#dcfce7;line:16a34a', removed: '#fee2e2;line:dc2626;line.dashed', modified: '#fef3c7;line:d97706', moved: '#dbeafe;line:2563eb', unchanged: '#f4f4f5;line:a1a1aa' }

export function toPlantUML(g: DiffGraph, kind: DiagramKind = 'flowchart'): string {
  const ids = new Map<string, string>()
  const out = ['@startuml', 'skinparam shadowing false', 'skinparam defaultFontName "Microsoft YaHei"']
  if (kind === 'state') {
    const init = g.nodes.find((n) => n.kind === 'initial')
    for (const n of g.nodes) if (n.kind === 'state') out.push(`state "${q(STATUS_SIGN[n.status] + n.label)}" as ${mid(n.id, ids)} #${PUML_COLOR[n.status]}`)
    for (const e of g.edges) out.push(`${e.source === init?.id ? '[*]' : mid(e.source, ids)} ${e.status === 'removed' ? '-[dashed]->' : '-->'} ${mid(e.target, ids)}${e.label ? ` : ${q(e.label)}` : ''}`)
  } else if (kind === 'class') {
    for (const n of g.nodes) {
      if (n.group) continue
      const kw = n.kind === 'interface' ? 'interface' : n.kind === 'enum' ? 'enum' : 'class'
      out.push(`${kw} "${q(STATUS_SIGN[n.status] + n.label)}" as ${mid(n.id, ids)} #${PUML_COLOR[n.status]} {`)
      for (const m of n.members ?? []) out.push(`  ${m.status === 'added' ? '+' : m.status === 'removed' ? '-' : m.status === 'modified' ? '~' : ''}${q(m.name)}${m.kind === 'method' ? '()' : ''}`)
      out.push('}')
    }
    for (const e of g.edges) out.push(`${mid(e.source, ids)} ${e.kind === 'extends' ? '--|>' : e.kind === 'implements' ? '..|>' : e.status === 'removed' ? '..>' : '-->'} ${mid(e.target, ids)}`)
  } else {
    const kids = new Map<string, GNode[]>()
    const roots: GNode[] = []
    for (const n of g.nodes) { if (n.parent && g.nodes.some((p) => p.id === n.parent)) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n); else roots.push(n) }
    const emit = (n: GNode, ind: string) => {
      const id = mid(n.id, ids)
      if (n.group) { out.push(`${ind}package "${q(n.label)}" as ${id} {`); for (const k of kids.get(n.id) ?? []) emit(k, ind + '  '); out.push(`${ind}}`) }
      else out.push(`${ind}${n.kind === 'decision' ? 'hexagon' : n.kind === 'cluster' ? 'collections' : 'rectangle'} "${q(STATUS_SIGN[n.status] + n.label)}" as ${id} #${PUML_COLOR[n.status]}`)
    }
    for (const r of roots) emit(r, '')
    for (const e of g.edges) out.push(`${mid(e.source, ids)} ${e.status === 'removed' ? '..>' : '-->'} ${mid(e.target, ids)}${e.label ? ` : ${q(e.label)}` : ''}`)
  }
  out.push('@enduml')
  return out.join('\n')
}

export function seqToMermaid(d: SeqDiagram): string {
  const ids = new Map<string, string>()
  const out = ['sequenceDiagram', '  %% 图例：＋新增 −删除 ～修改']
  for (const p of d.participants) out.push(`  ${p.kind === 'actor' ? 'actor' : 'participant'} ${mid(p.id, ids)} as ${q(STATUS_SIGN[p.status] + p.label)}`)
  const walk = (items: SeqItem[], ind: string) => {
    for (const it of items) {
      if (it.t === 'msg') out.push(`${ind}${mid(it.from, ids)}${it.ret ? '-->>' : it.status === 'removed' ? '--x' : '->>'}${mid(it.to, ids)}: ${q(STATUS_SIGN[it.status] + it.label)}`)
      else {
        const kw = it.kind === 'try' ? 'critical' : it.kind
        it.branches.forEach((b, i) => {
          const head = i === 0 ? kw : it.kind === 'par' ? 'and' : it.kind === 'try' ? 'option' : 'else'
          out.push(`${ind}${head} ${q(STATUS_SIGN[it.status] + (i === 0 ? it.label + (b.label ? ' ' + b.label : '') : b.label))}`)
          walk(b.items, ind + '  ')
        })
        out.push(`${ind}end`)
      }
    }
  }
  walk(d.items, '  ')
  return out.join('\n')
}

export function seqToPlantUML(d: SeqDiagram): string {
  const ids = new Map<string, string>()
  const color: Record<DiffStatus, string> = { added: '#16a34a', removed: '#dc2626', modified: '#d97706', moved: '#2563eb', unchanged: '#52525b' }
  const out = ['@startuml', 'skinparam shadowing false', 'skinparam defaultFontName "Microsoft YaHei"']
  for (const p of d.participants) out.push(`${p.kind === 'actor' ? 'actor' : 'participant'} "${q(STATUS_SIGN[p.status] + p.label)}" as ${mid(p.id, ids)}`)
  const walk = (items: SeqItem[]) => {
    for (const it of items) {
      if (it.t === 'msg') out.push(`${mid(it.from, ids)} ${it.ret ? '-[' + color[it.status] + ']->' : it.status === 'removed' ? '-[' + color.removed + ',dashed]>' : '-[' + color[it.status] + ']>'} ${mid(it.to, ids)} : ${q(STATUS_SIGN[it.status] + it.label)}`)
      else {
        const kw = it.kind === 'try' ? 'group' : it.kind
        it.branches.forEach((b, i) => { out.push(i === 0 ? `${kw} ${q(it.label + (b.label ? ' ' + b.label : ''))}` : `else ${q(b.label)}`); walk(b.items) })
        out.push('end')
      }
    }
  }
  walk(d.items)
  out.push('@enduml')
  return out.join('\n')
}

/** sequence items visible on a side (frames whose branches become empty are dropped) */
export function seqSide(items: SeqItem[], side: Side): SeqItem[] {
  if (side === 'both') return items
  const out: SeqItem[] = []
  for (const it of items) {
    if (!visibleOn(it.status, side)) continue
    if (it.t === 'msg') out.push(it)
    else {
      const branches = it.branches.map((b) => ({ ...b, items: seqSide(b.items, side) })).filter((b) => b.items.length)
      if (branches.length) out.push({ ...it, branches })
    }
  }
  return out
}
