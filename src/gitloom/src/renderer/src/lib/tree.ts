// Project tree model: directory-mirroring tree of repositories with compact folder chains,
// rolled-up status aggregation, fuzzy filtering, flattening for virtualization and status grouping.
import type { DiscoveredRepo, Project, RepoSummary } from '../../../shared/types'

export interface Agg {
  repos: number; changed: number; dirty: number; conflicts: number; ahead: number; behind: number
  needPush: number; needPull: number; detached: number; dirtySub: number; errors: number; uninit: number
}
export interface TNode {
  id: string
  path: string
  name: string
  type: 'project' | 'folder' | 'repo' | 'group'
  repo?: DiscoveredRepo
  children: TNode[]
  agg: Agg
}
export interface Row { node: TNode; depth: number; hasChildren: boolean; expanded: boolean }

export const emptyAgg = (): Agg => ({ repos: 0, changed: 0, dirty: 0, conflicts: 0, ahead: 0, behind: 0, needPush: 0, needPull: 0, detached: 0, dirtySub: 0, errors: 0, uninit: 0 })
export const OUTSIDE_ID = '__outside__'

const sep = (p: string) => p.replace(/\\/g, '/')
const join = (a: string, b: string) => (a.endsWith('/') ? a + b : `${a}/${b}`)
const cmp = (a: TNode, b: TNode) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })

/** Build the directory-mirroring tree for a project. Hidden repos are dropped. */
export function buildTree(project: Pick<Project, 'root' | 'name' | 'repos' | 'hidden'>, opts: { compact?: boolean } = {}): TNode {
  const hidden = new Set(project.hidden ?? [])
  const rootPath = sep(project.root).replace(/\/+$/, '') || '/'
  const root: TNode = { id: rootPath, path: rootPath, name: project.name, type: 'project', children: [], agg: emptyAgg() }
  const index = new Map<string, TNode>([[rootPath, root]])
  const visible = project.repos.filter((r) => !hidden.has(r.path))
  const outside: DiscoveredRepo[] = []
  const sorted = [...visible].sort((a, b) => a.rel.localeCompare(b.rel))
  for (const r of sorted) {
    if (r.outside || r.rel.startsWith('..')) { outside.push(r); continue }
    if (r.rel === '') { root.repo = r; continue }
    const parts = r.rel.split('/').filter(Boolean)
    let cur = root
    let curPath = rootPath
    for (let i = 0; i < parts.length; i++) {
      curPath = join(curPath, parts[i])
      let n = index.get(curPath)
      const last = i === parts.length - 1
      if (!n) {
        n = { id: curPath, path: curPath, name: parts[i], type: last ? 'repo' : 'folder', children: [], agg: emptyAgg() }
        index.set(curPath, n)
        cur.children.push(n)
      }
      if (last) { n.type = 'repo'; n.repo = r }
      cur = n
    }
  }
  // outside worktrees hang under their main repository; otherwise in a synthetic group
  const orphan: TNode[] = []
  for (const r of outside) {
    const n: TNode = { id: sep(r.path), path: sep(r.path), name: r.path.split(/[\\/]/).pop() ?? r.path, type: 'repo', repo: r, children: [], agg: emptyAgg() }
    const host = r.mainRepo ? index.get(sep(r.mainRepo)) : undefined
    if (host) host.children.push(n)
    else orphan.push(n)
    index.set(n.id, n)
  }
  if (orphan.length) root.children.push({ id: OUTSIDE_ID, path: OUTSIDE_ID, name: '项目文件夹之外', type: 'group', children: orphan, agg: emptyAgg() })
  const sortRec = (n: TNode) => { n.children.sort((a, b) => (a.type === 'group' ? 1 : b.type === 'group' ? -1 : cmp(a, b))); n.children.forEach(sortRec) }
  sortRec(root)
  if (opts.compact !== false) compactChains(root)
  return root
}

/** VS Code-style compact folders: a folder whose only child is a folder merges into "a/b". */
export function compactChains(node: TNode): void {
  for (let i = 0; i < node.children.length; i++) {
    let c = node.children[i]
    while (c.type === 'folder' && c.children.length === 1 && c.children[0].type === 'folder') {
      const only = c.children[0]
      c = { ...only, name: `${c.name}/${only.name}` }
      node.children[i] = c
    }
    compactChains(c)
  }
}

/** Status of a single repo expressed as an Agg (1 repo). */
export function repoAgg(r: DiscoveredRepo | undefined, s: RepoSummary | undefined): Agg {
  const a = emptyAgg()
  if (!r) return a
  a.repos = 1
  if (!r.initialized) { a.uninit = 1; return a }
  if (!s) return a
  if (s.error) { a.errors = 1; return a }
  a.changed = s.changes
  a.dirty = s.changes > 0 ? 1 : 0
  a.conflicts = s.conflicts ?? 0
  a.ahead = s.ahead
  a.behind = s.behind
  a.needPush = s.ahead > 0 ? 1 : 0
  a.needPull = s.behind > 0 ? 1 : 0
  a.detached = s.detached && r.kind !== 'submodule' ? 1 : 0 // submodules are detached by design
  a.dirtySub = s.dirtySubmodules ?? 0
  return a
}

export function addAgg(a: Agg, b: Agg): Agg {
  const o = { ...a }
  for (const k of Object.keys(o) as (keyof Agg)[]) o[k] += b[k]
  return o
}

/** Roll status up the tree (repo nodes include their nested repos). Mutates and returns the root. */
export function aggregate(node: TNode, sums: Record<string, RepoSummary | undefined>): TNode {
  let a = repoAgg(node.repo, node.repo ? sums[node.repo.path] : undefined)
  for (const c of node.children) a = addAgg(a, aggregate(c, sums).agg)
  node.agg = a
  return node
}

/** Flatten expanded nodes into rows (root first). */
export function flatten(root: TNode, expanded: Set<string>, opts: { includeRoot?: boolean; visible?: Set<string>; forceExpand?: boolean } = {}): Row[] {
  const rows: Row[] = []
  const walk = (n: TNode, depth: number) => {
    if (opts.visible && !opts.visible.has(n.id)) return
    const kids = opts.visible ? n.children.filter((c) => opts.visible!.has(c.id)) : n.children
    const isOpen = opts.forceExpand || expanded.has(n.id)
    rows.push({ node: n, depth, hasChildren: kids.length > 0, expanded: isOpen && kids.length > 0 })
    if (isOpen) for (const c of kids) walk(c, depth + 1)
  }
  if (opts.includeRoot !== false) walk(root, 0)
  else for (const c of root.children) walk(c, 0)
  return rows
}

export function allIds(root: TNode): string[] { const out: string[] = []; const w = (n: TNode) => { if (n.children.length) out.push(n.id); n.children.forEach(w) }; w(root); return out }
export function allRepoNodes(root: TNode): TNode[] { const out: TNode[] = []; const w = (n: TNode) => { if (n.repo) out.push(n); n.children.forEach(w) }; w(root); return out }
export function findNode(root: TNode, id: string): TNode | null { if (root.id === id) return root; for (const c of root.children) { const f = findNode(c, id); if (f) return f } return null }
/** Ids of all ancestors of `id` (excluding itself). */
export function ancestorsOf(root: TNode, id: string): string[] {
  const path: string[] = []
  const w = (n: TNode): boolean => { if (n.id === id) return true; path.push(n.id); for (const c of n.children) if (w(c)) return true; path.pop(); return false }
  return w(root) ? path : []
}

/** Fuzzy score (higher is better, -1 = no match). Space-separated tokens must all match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  let total = 0
  for (const tok of q.split(/\s+/)) {
    const idx = t.indexOf(tok)
    if (idx >= 0) { total += 1000 - idx * 2 - (t.length - tok.length) * 0.1 + (idx === 0 || /[/\-_. ]/.test(t[idx - 1]) ? 200 : 0); continue }
    // subsequence with gap penalty, bonus on word boundaries
    let ti = 0, score = 0, last = -1
    for (const ch of tok) {
      const f = t.indexOf(ch, ti)
      if (f < 0) return -1
      score += 10 - Math.min(9, last < 0 ? 0 : f - last - 1) + (f === 0 || /[/\-_. ]/.test(t[f - 1]) ? 8 : 0)
      last = f
      ti = f + 1
    }
    total += score
  }
  return total
}

/** Set of node ids to show for a query (matching repos/folders + their ancestors), and best score per repo. */
export function filterTree(root: TNode, query: string, sums: Record<string, RepoSummary | undefined> = {}): { visible: Set<string>; scores: Map<string, number> } {
  const visible = new Set<string>()
  const scores = new Map<string, number>()
  const walk = (n: TNode, trail: string[]): void => {
    const hay = [n.name, n.repo?.rel ?? '', n.repo ? sums[n.repo.path]?.branch ?? '' : ''].join(' ')
    const s = n.type === 'project' ? -1 : fuzzyScore(query, hay)
    if (s >= 0) { scores.set(n.id, s); visible.add(n.id); trail.forEach((t) => visible.add(t)) }
    for (const c of n.children) walk(c, [...trail, n.id])
  }
  walk(root, [])
  if (visible.size) visible.add(root.id)
  return { visible, scores }
}

/** A repo "needs attention": uncommitted changes, conflicts, or commits to push/pull. */
export function needsAttention(s?: RepoSummary): boolean {
  return !!s && !s.error && (s.changes > 0 || (s.conflicts ?? 0) > 0 || !!s.operation || s.ahead > 0 || s.behind > 0)
}

/** Visible node ids (matches + their ancestors) for an arbitrary predicate. */
export function filterTreeWhere(root: TNode, pred: (n: TNode) => boolean): Set<string> {
  const visible = new Set<string>()
  const walk = (n: TNode, trail: string[]): void => {
    if (n.type !== 'project' && pred(n)) { visible.add(n.id); trail.forEach((t) => visible.add(t)) }
    for (const c of n.children) walk(c, [...trail, n.id])
  }
  walk(root, [])
  if (visible.size) visible.add(root.id)
  return visible
}

export type StatusGroup = 'conflict' | 'changed' | 'push' | 'pull' | 'clean' | 'other'
export const STATUS_GROUPS: { key: StatusGroup; label: string }[] = [
  { key: 'conflict', label: '冲突' }, { key: 'changed', label: '有改动' }, { key: 'push', label: '需要推送' },
  { key: 'pull', label: '需要拉取' }, { key: 'clean', label: '干净' }, { key: 'other', label: '未初始化 / 不可用' }
]

/** Group repos by status. A repo can be in several groups (e.g. changed AND needs push); "clean" is exclusive. */
export function groupByStatus(repos: DiscoveredRepo[], sums: Record<string, RepoSummary | undefined>): { key: StatusGroup; label: string; repos: DiscoveredRepo[] }[] {
  const g = new Map<StatusGroup, DiscoveredRepo[]>(STATUS_GROUPS.map((x) => [x.key, []]))
  for (const r of repos) {
    const s = sums[r.path]
    if (!r.initialized || s?.error || r.kind === 'bare') { g.get(r.kind === 'bare' && !s?.error ? 'clean' : 'other')!.push(r); continue }
    if (!s) continue
    let any = false
    if ((s.conflicts ?? 0) > 0 || s.operation) { g.get('conflict')!.push(r); any = true }
    if (s.changes - (s.conflicts ?? 0) > 0) { g.get('changed')!.push(r); any = true }
    if (s.ahead > 0) { g.get('push')!.push(r); any = true }
    if (s.behind > 0) { g.get('pull')!.push(r); any = true }
    if (!any) g.get('clean')!.push(r)
  }
  return STATUS_GROUPS.map((x) => ({ ...x, repos: g.get(x.key)! })).filter((x) => x.repos.length)
}

/** Repos located at or below a folder path (for dashboards scoped to a tree node). */
export function reposUnder(repos: DiscoveredRepo[], folder: string, root: string): DiscoveredRepo[] {
  const f = sep(folder).replace(/\/+$/, '')
  if (f === sep(root).replace(/\/+$/, '')) return repos
  return repos.filter((r) => { const p = sep(r.path); return p === f || p.startsWith(f + '/') || (r.mainRepo && (sep(r.mainRepo) === f || sep(r.mainRepo).startsWith(f + '/'))) })
}

/** Migrate a legacy flat repo list into a manual project rooted at the deepest common folder. */
export function projectFromList(paths: string[], name?: string): Project {
  const parts = paths.map((p) => sep(p).split('/'))
  let common: string[] = parts[0]?.slice(0, -1) ?? []
  for (const p of parts) { let i = 0; while (i < common.length && i < p.length - 1 && common[i] === p[i]) i++; common = common.slice(0, i) }
  const root = common.join('/') || '/'
  return {
    id: `p-${Date.now().toString(36)}`, name: name ?? (common[common.length - 1] || '工作区'), root, manual: true, hidden: [],
    repos: paths.map((p) => ({ path: p, rel: sep(p).slice(root.length).replace(/^\/+/, ''), kind: 'normal' as const, initialized: true }))
  }
}
