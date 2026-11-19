// Overview (工作区·概览) filter chips + clean predicate — shared so unit tests match the Dashboard UI.
import type { DiscoveredRepo, RepoSummary } from '@shared/types'

export type DashFilter = 'all' | 'changed' | 'push' | 'pull' | 'conflict' | 'detached' | 'error'

export interface DashFilterDef {
  id: DashFilter
  label: string
  test: (s?: RepoSummary, r?: DiscoveredRepo) => boolean
}

/** Stat chips on the multi-repo overview. Counts must match the filtered table. */
export const DASH_FILTERS: DashFilterDef[] = [
  { id: 'all', label: '全部', test: () => true },
  { id: 'changed', label: '有改动', test: (s) => !!s && s.changes > 0 },
  { id: 'push', label: '需要推送', test: (s) => !!s && s.ahead > 0 },
  { id: 'pull', label: '需要拉取', test: (s) => !!s && s.behind > 0 },
  // conflict chip = merge/rebase/cherry-pick in progress OR conflicted files (matches sidebar groupByStatus)
  { id: 'conflict', label: '冲突', test: (s) => !!s && ((s.conflicts ?? 0) > 0 || !!s.operation) },
  // submodules are detached by design — exclude them from the chip (matches StatusBadges / tree.repoAgg)
  { id: 'detached', label: '分离 HEAD', test: (s, r) => !!s?.detached && r?.kind !== 'submodule' },
  { id: 'error', label: '不可用', test: (s, r) => !!s?.error || r?.initialized === false }
]

/** True when the status column should render the green「干净」label (not StatusBadges). */
export function isOverviewClean(s?: RepoSummary, r?: DiscoveredRepo): boolean {
  if (!s || s.error || !r?.initialized) return false
  if ((s.conflicts ?? 0) > 0 || s.operation) return false
  if (s.detached && r.kind !== 'submodule') return false
  return !s.changes && !s.ahead && !s.behind && !(s.dirtySubmodules)
}

/** Informational「无上游」badge — does not make the repo dirty, but must still render next to 干净. */
export function hasNoUpstream(s?: RepoSummary): boolean {
  return !!s && !s.detached && !!s.branch && s.upstream === null && !s.bare && !s.isWorktree
}

export function dashFilterCounts(
  repos: DiscoveredRepo[],
  summaries: Record<string, RepoSummary | undefined>
): Record<DashFilter, number> {
  const out = {} as Record<DashFilter, number>
  for (const f of DASH_FILTERS) out[f.id] = repos.filter((r) => f.test(summaries[r.path], r)).length
  return out
}

export function applyDashFilter(
  repos: DiscoveredRepo[],
  summaries: Record<string, RepoSummary | undefined>,
  filter: DashFilter,
  q = ''
): DiscoveredRepo[] {
  const f = DASH_FILTERS.find((x) => x.id === filter) ?? DASH_FILTERS[0]
  let list = repos.filter((r) => f.test(summaries[r.path], r))
  const needle = q.trim().toLowerCase()
  if (needle) {
    list = list.filter((r) => {
      const base = r.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || r.path
      const hay = `${base} ${r.rel} ${summaries[r.path]?.branch ?? ''}`.toLowerCase()
      return hay.includes(needle) || needle.split(/\s+/).every((t) => hay.includes(t))
    })
  }
  return list
}

/** Quick-sync targets for 一键同步 (independent of the active chip). */
export function quickSyncTargets(
  repos: DiscoveredRepo[],
  summaries: Record<string, RepoSummary | undefined>
): { behind: DiscoveredRepo[]; ahead: DiscoveredRepo[]; noUpstream: number } {
  const live = repos.filter((r) => r.initialized && r.kind !== 'bare')
  const sum = (r: DiscoveredRepo) => summaries[r.path]
  return {
    behind: live.filter((r) => { const x = sum(r); return !!x?.upstream && !x.detached && x.behind > 0 }),
    ahead: live.filter((r) => { const x = sum(r); return !!x?.upstream && !x.detached && x.ahead > 0 }),
    noUpstream: live.filter((r) => { const x = sum(r); return !!x && !x.upstream && !x.detached && !!x.branch && !x.isWorktree }).length
  }
}

/** Left-border / card accent severity for dashboard cards (conflict > dirty > sync > clean). */
export type CardAccent = 'conflict' | 'dirty' | 'detached' | 'sync' | 'clean' | 'error' | 'uninit'

export function cardAccent(s?: RepoSummary, r?: DiscoveredRepo): CardAccent {
  if (!r?.initialized) return 'uninit'
  if (!s || s.error) return 'error'
  if ((s.conflicts ?? 0) > 0 || s.operation) return 'conflict'
  if (s.changes > 0 || (s.dirtySubmodules ?? 0) > 0) return 'dirty'
  if (s.detached && r.kind !== 'submodule') return 'detached'
  if (s.ahead > 0 || s.behind > 0) return 'sync'
  return 'clean'
}

/** Short upstream label for card sync meta (e.g. origin/main → origin/main, keeps remote/branch). */
export function shortUpstream(upstream: string | null | undefined): string | null {
  if (!upstream) return null
  const t = upstream.trim()
  return t || null
}

/** 7-char short hash from a commit sha when present. */
export function shortSha(sha: string | null | undefined): string | null {
  if (!sha) return null
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

// ── 今日待办 + 批量同步结果摘要 ──────────────────────────────────────────────

export type TodoKind = 'conflict' | 'push' | 'behind' | 'dirty'

export interface TodayTodo {
  path: string
  name: string
  kind: TodoKind
  /** Short chip label, e.g. 有冲突 / 未推送 */
  label: string
  /** One-line detail for title/tooltip */
  detail: string
  /** View to open when clicked */
  view: 'changes' | 'history'
}

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/**
 * Repos that need attention today — ordered conflict → push → behind → dirty.
 * One card per repo (highest-priority kind wins). Optional dirty is off by default
 * so the strip stays focused; pass includeDirty to also surface uncommitted work.
 */
export function todayTodos(
  repos: DiscoveredRepo[],
  summaries: Record<string, RepoSummary | undefined>,
  opts: { includeDirty?: boolean } = {}
): TodayTodo[] {
  const includeDirty = opts.includeDirty === true
  const out: TodayTodo[] = []
  for (const r of repos) {
    if (!r.initialized || r.kind === 'bare') continue
    const s = summaries[r.path]
    if (!s || s.error) continue
    const name = baseName(r.path)
    if ((s.conflicts ?? 0) > 0 || s.operation) {
      const n = s.conflicts ?? 0
      out.push({
        path: r.path, name, kind: 'conflict', label: '有冲突',
        detail: s.operation
          ? (n ? `${s.operation} · ${n} 个冲突文件` : `${s.operation} · 可继续`)
          : `${n} 个冲突文件`,
        view: 'changes'
      })
      continue
    }
    if (s.ahead > 0 && s.upstream && !s.detached) {
      out.push({
        path: r.path, name, kind: 'push', label: '未推送',
        detail: `领先上游 ${s.ahead} 个提交`,
        view: 'changes'
      })
      continue
    }
    if (s.behind > 0 && s.upstream && !s.detached) {
      out.push({
        path: r.path, name, kind: 'behind', label: '落后上游',
        detail: `落后上游 ${s.behind} 个提交`,
        view: 'changes'
      })
      continue
    }
    if (includeDirty && s.changes > 0) {
      out.push({
        path: r.path, name, kind: 'dirty', label: '有未提交',
        detail: `${s.changes} 个改动文件`,
        view: 'changes'
      })
    }
  }
  const rank: Record<TodoKind, number> = { conflict: 0, push: 1, behind: 2, dirty: 3 }
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name, 'zh'))
}

export interface BulkResultLike {
  state: 'queued' | 'running' | 'ok' | 'skip' | 'err' | string
  message?: string
}

export interface BulkSummary {
  ok: number
  err: number
  skip: number
  pending: number
  total: number
  /** e.g. 成功 3 · 失败 1 · 跳过 2 */
  countsLine: string
  /** e.g. 批量同步结果 */
  title: string
  /** Per-repo one-liners (path → message), errors first */
  lines: { path: string; state: string; message: string }[]
  /** Overall tone for the panel */
  tone: 'ok' | 'err' | 'mixed' | 'running'
}

/** Aggregate bulk fetch/pull/push (etc.) results for the summary panel. */
export function summarizeBulkResults(
  results: Record<string, BulkResultLike | undefined>,
  opts: { label?: string; finished?: boolean } = {}
): BulkSummary {
  const entries = Object.entries(results).filter(([, r]) => !!r) as [string, BulkResultLike][]
  let ok = 0, err = 0, skip = 0, pending = 0
  for (const [, r] of entries) {
    if (r.state === 'ok') ok++
    else if (r.state === 'err') err++
    else if (r.state === 'skip') skip++
    else pending++
  }
  const total = entries.length
  const parts: string[] = []
  if (ok) parts.push(`成功 ${ok}`)
  if (err) parts.push(`失败 ${err}`)
  if (skip) parts.push(`跳过 ${skip}`)
  if (pending) parts.push(`进行中 ${pending}`)
  const countsLine = parts.join(' · ') || '尚无结果'
  const lines = entries
    .map(([path, r]) => ({
      path,
      state: r.state,
      message: r.message || (r.state === 'ok' ? '完成' : r.state === 'err' ? '失败' : r.state === 'skip' ? '已跳过' : r.state === 'running' ? '执行中…' : '排队中')
    }))
    .sort((a, b) => {
      const rank = (s: string) => (s === 'err' ? 0 : s === 'running' || s === 'queued' ? 1 : s === 'ok' ? 2 : 3)
      return rank(a.state) - rank(b.state) || a.path.localeCompare(b.path)
    })
  const finished = opts.finished !== false && pending === 0
  const tone: BulkSummary['tone'] =
    !finished || pending > 0 ? 'running' : err === 0 ? 'ok' : ok > 0 || skip > 0 ? 'mixed' : 'err'
  return {
    ok, err, skip, pending, total,
    countsLine,
    title: opts.label ? `${opts.label}结果` : '批量同步结果',
    lines,
    tone
  }
}
