import { describe, expect, test } from 'vitest'
import type { DiscoveredRepo, RepoSummary } from '../src/shared/types'
import { aggregate, allIds, ancestorsOf, buildTree, filterTree, findNode, flatten, fuzzyScore, groupByStatus, needsAttention, filterTreeWhere, projectFromList, reposUnder, OUTSIDE_ID } from '../src/renderer/src/lib/tree'

const R = (rel: string, extra: Partial<DiscoveredRepo> = {}): DiscoveredRepo => ({ path: rel ? `/p/${rel}` : '/p', rel, kind: rel ? 'nested' : 'normal', initialized: true, ...extra })
const S = (path: string, x: Partial<RepoSummary> = {}): RepoSummary => ({ path, name: path.split('/').pop()!, branch: 'main', changes: 0, ahead: 0, behind: 0, isWorktree: false, ...x })
const repos: DiscoveredRepo[] = [
  R(''), R('apps/web'), R('apps/api'), R('libs/ui/components'), R('libs/a/b/c/d'), R('apps/web/packages/x'),
  R('modules/extra', { kind: 'submodule', initialized: false }), R('../out/wt', { kind: 'worktree', outside: true, mainRepo: '/p/apps/web' }),
  R('../elsewhere/wt2', { kind: 'worktree', outside: true, mainRepo: '/nope' })
]
const project = { root: '/p', name: 'mono', repos, hidden: [] as string[] }

describe('buildTree', () => {
  const t = buildTree(project)
  test('root project node carries the root repo', () => { expect(t.type).toBe('project'); expect(t.repo?.rel).toBe('') })
  test('mirrors folders and keeps nested repos under their repo node', () => {
    const web = findNode(t, '/p/apps/web')!
    expect(web.type).toBe('repo')
    // packages/x compacts? packages is a folder with a single repo child (not a folder) → not compacted
    expect(web.children.map((c) => c.name)).toContain('packages')
    expect(findNode(t, '/p/apps/web/packages/x')?.type).toBe('repo')
  })
  test('compacts single-child folder chains (libs/a/b/c) but not folders holding repos', () => {
    const libs = t.children.find((c) => c.name.startsWith('libs'))!
    const names = libs.children.map((c) => c.name).sort()
    expect(names).toEqual(['a/b/c', 'ui'])
    expect(libs.children.find((c) => c.name === 'a/b/c')!.children[0].name).toBe('d')
  })
  test('outside worktree hangs under its main repo; orphan goes to a group', () => {
    expect(findNode(t, '/p/apps/web')!.children.some((c) => c.repo?.rel === '../out/wt')).toBe(true)
    const g = t.children.find((c) => c.id === OUTSIDE_ID)!
    expect(g.type).toBe('group')
    expect(g.children[0].repo?.rel).toBe('../elsewhere/wt2')
    expect(t.children[t.children.length - 1].id).toBe(OUTSIDE_ID)
  })
  test('hidden repos are removed', () => {
    const h = buildTree({ ...project, hidden: ['/p/apps/api'] })
    expect(findNode(h, '/p/apps/api')).toBeNull()
  })
  test('compact can be disabled', () => {
    const n = buildTree(project, { compact: false })
    expect(findNode(n, '/p/libs/a')?.name).toBe('a')
  })
})

describe('aggregate', () => {
  const sums: Record<string, RepoSummary> = {
    '/p': S('/p', { changes: 1, dirtySubmodules: 1 }),
    '/p/apps/web': S('/p/apps/web', { changes: 3, ahead: 2 }),
    '/p/apps/web/packages/x': S('/p/apps/web/packages/x', { behind: 4, detached: true }),
    '/p/libs/ui/components': S('/p/libs/ui/components', { changes: 1, conflicts: 1, operation: 'MERGING' }),
    '/p/apps/api': S('/p/apps/api', { error: 'boom' })
  }
  const t = aggregate(buildTree(project), sums)
  test('rolls changed files, ahead/behind, conflicts and flags to parents', () => {
    const apps = findNode(t, '/p/apps')!
    expect(apps.agg.changed).toBe(3)
    expect(apps.agg.ahead).toBe(2)
    expect(apps.agg.behind).toBe(4)
    expect(apps.agg.detached).toBe(1)
    expect(apps.agg.errors).toBe(1)
    expect(apps.agg.dirty).toBe(1)
    expect(apps.agg.needPull).toBe(1)
    expect(t.agg.conflicts).toBe(1)
    expect(t.agg.dirtySub).toBe(1)
    expect(t.agg.uninit).toBe(1)
    expect(t.agg.repos).toBe(repos.length)
  })
  test('repo node includes its nested repos', () => {
    const web = findNode(t, '/p/apps/web')!
    expect(web.agg.behind).toBe(4)
    expect(web.agg.repos).toBe(3) // web + packages/x + outside worktree
  })
})

describe('flatten / filter / helpers', () => {
  const t = aggregate(buildTree(project), {})
  test('flatten honors expanded set', () => {
    expect(flatten(t, new Set()).length).toBe(1)
    const rows = flatten(t, new Set([t.id]))
    expect(rows.length).toBe(1 + t.children.length)
    expect(rows[1].depth).toBe(1)
    expect(flatten(t, new Set(allIds(t))).length).toBeGreaterThan(rows.length)
  })
  test('fuzzy scoring prefers contiguous and boundary matches', () => {
    expect(fuzzyScore('web', 'apps/web')).toBeGreaterThan(fuzzyScore('web', 'awesome-ebook'))
    expect(fuzzyScore('awb', 'apps/web')).toBeGreaterThan(0)
    expect(fuzzyScore('zzz', 'apps/web')).toBe(-1)
    expect(fuzzyScore('apps comp', 'libs/ui/components')).toBe(-1)
    expect(fuzzyScore('ui comp', 'libs/ui/components')).toBeGreaterThan(0)
  })
  test('filterTree keeps matches and their ancestors', () => {
    const { visible } = filterTree(t, 'comp')
    expect(visible.has('/p/libs/ui/components')).toBe(true)
    expect(visible.has('/p/libs/ui')).toBe(true)
    expect(visible.has('/p')).toBe(true)
    expect(visible.has('/p/apps/web')).toBe(false)
    const rows = flatten(t, new Set(), { visible, forceExpand: true })
    expect(rows.map((r) => r.node.id)).toContain('/p/libs/ui/components')
  })
  test('filter by branch name', () => {
    const { visible } = filterTree(t, 'hotfix-x', { '/p/apps/api': S('/p/apps/api', { branch: 'hotfix-x' }) })
    expect(visible.has('/p/apps/api')).toBe(true)
  })
  test('ancestorsOf', () => { expect(ancestorsOf(t, '/p/libs/ui/components')).toEqual(['/p', '/p/libs', '/p/libs/ui']) })
  test('reposUnder scopes by folder (and includes outside worktrees of repos inside)', () => {
    const r = reposUnder(repos, '/p/apps', '/p').map((x) => x.rel)
    expect(r).toEqual(expect.arrayContaining(['apps/web', 'apps/api', 'apps/web/packages/x', '../out/wt']))
    expect(r).not.toContain('libs/ui/components')
    expect(reposUnder(repos, '/p', '/p').length).toBe(repos.length)
  })
})

describe('groupByStatus', () => {
  test('multi-membership and exclusive clean', () => {
    const sums = {
      '/p/apps/web': S('/p/apps/web', { changes: 2, ahead: 1 }),
      '/p/apps/api': S('/p/apps/api', { behind: 1 }),
      '/p/libs/ui/components': S('/p/libs/ui/components', { changes: 1, conflicts: 1 }),
      '/p': S('/p')
    }
    const g = Object.fromEntries(groupByStatus(repos, sums).map((x) => [x.key, x.repos.map((r) => r.rel)]))
    expect(g.changed).toEqual(['apps/web'])
    expect(g.push).toEqual(['apps/web'])
    expect(g.pull).toEqual(['apps/api'])
    expect(g.conflict).toEqual(['libs/ui/components'])
    expect(g.clean).toEqual([''])
    expect(g.other).toEqual(['modules/extra'])
  })
})

describe('projectFromList', () => {
  test('migrates a flat list to a manual project rooted at the common parent', () => {
    const p = projectFromList(['/w/a/webapp', '/w/a/api', '/w/b/x'])
    expect(p.root).toBe('/w')
    expect(p.manual).toBe(true)
    expect(p.repos.map((r) => r.rel)).toEqual(['a/webapp', 'a/api', 'b/x'])
  })
  test('single repo', () => { const p = projectFromList(['/w/a/webapp']); expect(p.root).toBe('/w/a'); expect(p.repos[0].rel).toBe('webapp') })
})

describe('只看有改动 filter', () => {
  test('needsAttention covers changes / conflicts / operation / ahead / behind, not errors or clean', () => {
    expect(needsAttention(S('/a'))).toBe(false)
    expect(needsAttention(undefined)).toBe(false)
    expect(needsAttention(S('/a', { changes: 2 }))).toBe(true)
    expect(needsAttention(S('/a', { conflicts: 1 }))).toBe(true)
    expect(needsAttention(S('/a', { operation: 'REBASING' }))).toBe(true)
    expect(needsAttention(S('/a', { ahead: 1 }))).toBe(true)
    expect(needsAttention(S('/a', { behind: 3 }))).toBe(true)
    expect(needsAttention(S('/a', { changes: 2, error: 'x' }))).toBe(false)
  })
  test('filterTreeWhere keeps matches plus ancestors only', () => {
    const t = buildTree(project)
    const sums: Record<string, RepoSummary> = { '/p/apps/web/packages/x': S('/p/apps/web/packages/x', { changes: 1 }) }
    const v = filterTreeWhere(t, (n) => !!n.repo && needsAttention(sums[n.repo.path]))
    expect(v.has('/p/apps/web/packages/x')).toBe(true)
    expect(v.has('/p/apps/web')).toBe(true)
    expect(v.has('/p/apps/api')).toBe(false)
  })
})
