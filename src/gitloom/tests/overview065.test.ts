/**
 * 0.6.5-hotfix.x — multi-repo overview (工作区·概览 / 日常 Git secondary 概览) correctness.
 * Covers chip counts vs fixture status, filters, clean/detached/no-upstream labeling,
 * bulk skip preflight, health scoring without crash, and module-boundary (日常无 viz).
 */
import { describe, it, expect } from 'vitest'
import type { DiscoveredRepo, RepoSummary } from '../src/shared/types'
import {
  DASH_FILTERS, applyDashFilter, cardAccent, dashFilterCounts, hasNoUpstream, isOverviewClean, quickSyncTargets, shortSha, shortUpstream
} from '../src/renderer/src/lib/dashOverview'
import { repoHealth, healthTip } from '../src/renderer/src/lib/health'
import { bulkSkip, isDangerous, OP_LABEL } from '../src/renderer/src/lib/bulkLogic'
import { ADVANCED, MODULES, moduleOf, PRIMARY, BRANCH_SECTIONS, visibleAdvanced, viewTabStrip } from '../src/renderer/src/lib/nav'
import { needsAttention } from '../src/renderer/src/lib/tree'

const R = (path: string, extra: Partial<DiscoveredRepo> = {}): DiscoveredRepo => ({
  path, rel: path.replace(/^\/p\/?/, ''), kind: 'normal', initialized: true, ...extra
})
const S = (path: string, x: Partial<RepoSummary> = {}): RepoSummary => ({
  path, name: path.split('/').pop()!, branch: 'main', changes: 0, ahead: 0, behind: 0, isWorktree: false, upstream: 'origin/main', ...x
})

/** Fixture mirroring a small EVER-BUDDY-like overview: 8 repos with mixed statuses. */
const repos: DiscoveredRepo[] = [
  R('/p', { rel: '', kind: 'normal' }),
  R('/p/clean-a'),
  R('/p/dirty', { rel: 'dirty' }),
  R('/p/ahead', { rel: 'ahead' }),
  R('/p/behind', { rel: 'behind' }),
  R('/p/conflict', { rel: 'conflict' }),
  R('/p/detached', { rel: 'detached' }),
  R('/p/noup', { rel: 'noup' }),
  R('/p/op-only', { rel: 'op-only' }),                 // REBASING, no file conflicts
  R('/p/sub-det', { rel: 'sub-det', kind: 'submodule' }), // detached by design
  R('/p/broken', { rel: 'broken', initialized: false, kind: 'submodule' }),
  R('/p/err', { rel: 'err' })
]
const sums: Record<string, RepoSummary | undefined> = {
  '/p': S('/p'),
  '/p/clean-a': S('/p/clean-a'),
  '/p/dirty': S('/p/dirty', { changes: 56, branch: 'feat/authz-closed' }),
  '/p/ahead': S('/p/ahead', { ahead: 2 }),
  '/p/behind': S('/p/behind', { behind: 1 }),
  '/p/conflict': S('/p/conflict', { changes: 3, conflicts: 2, operation: 'MERGING' }),
  '/p/detached': S('/p/detached', { detached: true, branch: '(f46b687)', upstream: null }),
  '/p/noup': S('/p/noup', { upstream: null, branch: 'feature/local' }),
  '/p/op-only': S('/p/op-only', { operation: 'REBASING', changes: 0, conflicts: 0 }),
  '/p/sub-det': S('/p/sub-det', { detached: true, branch: '(abc1234)', upstream: null }),
  '/p/err': S('/p/err', { error: 'not a git repository' })
}

describe('overview chip counts vs fixture status', () => {
  it('counts match FILTERS tests (chips ≡ table filters)', () => {
    const c = dashFilterCounts(repos, sums)
    expect(c.all).toBe(repos.length)
    expect(c.changed).toBe(2)          // dirty + conflict
    expect(c.push).toBe(1)             // ahead
    expect(c.pull).toBe(1)             // behind
    expect(c.conflict).toBe(2)         // conflict (MERGING) + op-only (REBASING)
    expect(c.detached).toBe(1)         // only /p/detached — submodule excluded
    expect(c.error).toBe(2)            // broken (uninit) + err
  })
  it('filter chip narrows the table to matching repos only', () => {
    expect(applyDashFilter(repos, sums, 'changed').map((r) => r.rel).sort()).toEqual(['conflict', 'dirty'])
    expect(applyDashFilter(repos, sums, 'detached').map((r) => r.path)).toEqual(['/p/detached'])
    expect(applyDashFilter(repos, sums, 'conflict').map((r) => r.rel).sort()).toEqual(['conflict', 'op-only'])
    // branch / name filter (概览 search covers 名称/路径/分支)
    expect(applyDashFilter(repos, sums, 'all', 'authz').map((r) => r.rel)).toEqual(['dirty'])
    expect(applyDashFilter(repos, sums, 'all', 'noup').map((r) => r.rel)).toEqual(['noup'])
    expect(applyDashFilter(repos, sums, 'push').every((r) => (sums[r.path]?.ahead ?? 0) > 0)).toBe(true)
  })
  it('DASH_FILTERS labels stay plain Chinese and cover the screenshot chips', () => {
    expect(DASH_FILTERS.map((f) => f.label)).toEqual(['全部', '有改动', '需要推送', '需要拉取', '冲突', '分离 HEAD', '不可用'])
  })
})

describe('clean / detached / no-upstream labeling', () => {
  it('isOverviewClean is false for operation-in-progress even with zero file changes (P0)', () => {
    expect(isOverviewClean(sums['/p/op-only'], repos.find((r) => r.path === '/p/op-only'))).toBe(false)
    expect(isOverviewClean(sums['/p/conflict'], repos.find((r) => r.path === '/p/conflict'))).toBe(false)
    expect(isOverviewClean(sums['/p/detached'], repos.find((r) => r.path === '/p/detached'))).toBe(false)
    expect(isOverviewClean(sums['/p/dirty'], repos.find((r) => r.path === '/p/dirty'))).toBe(false)
    expect(isOverviewClean(sums['/p/clean-a'], repos.find((r) => r.path === '/p/clean-a'))).toBe(true)
    expect(isOverviewClean(sums['/p/noup'], repos.find((r) => r.path === '/p/noup'))).toBe(true) // no upstream ≠ dirty
    // P0: clean + no-upstream must still surface 无上游 (Dashboard renders badge beside 干净)
    expect(hasNoUpstream(sums['/p/noup'])).toBe(true)
    expect(hasNoUpstream(sums['/p/clean-a'])).toBe(false) // has upstream
    expect(hasNoUpstream(sums['/p/detached'])).toBe(false)

  })
  it('detached submodule is excluded from 分离 HEAD chip but still not “干净” if other flags', () => {
    const sub = repos.find((r) => r.path === '/p/sub-det')!
    expect(DASH_FILTERS.find((f) => f.id === 'detached')!.test(sums['/p/sub-det'], sub)).toBe(false)
    // submodule detached alone with no changes → clean (design: submodule pin)
    expect(isOverviewClean(sums['/p/sub-det'], sub)).toBe(true)
  })
  it('quickSyncTargets exclude detached and count no-upstream separately', () => {
    const q = quickSyncTargets(repos, sums)
    expect(q.ahead.map((r) => r.rel)).toEqual(['ahead'])
    expect(q.behind.map((r) => r.rel)).toEqual(['behind'])
    expect(q.noUpstream).toBe(1) // noup only (detached/sub excluded)
  })
  it('needsAttention includes in-progress operation', () => {
    expect(needsAttention(sums['/p/op-only'])).toBe(true)
    expect(needsAttention(sums['/p/clean-a'])).toBe(false)
  })
})

describe('bulk skip + result recording semantics', () => {
  it('pull/push skip detached and no-upstream; stash skips clean/conflict', () => {
    const det = sums['/p/detached']
    const noup = sums['/p/noup']
    const clean = sums['/p/clean-a']
    const conf = sums['/p/conflict']
    const ahead = sums['/p/ahead']
    expect(bulkSkip('pull', det)?.message).toMatch(/分离 HEAD|上游/)
    expect(bulkSkip('push', det)?.message).toMatch(/分离 HEAD/)
    expect(bulkSkip('pull', noup)?.message).toMatch(/上游/)
    expect(bulkSkip('push', noup)?.message).toMatch(/上游/)
    expect(bulkSkip('push', noup, { setUpstream: true })).toBeNull()
    expect(bulkSkip('push', clean)?.message).toMatch(/没有待推送/)
    expect(bulkSkip('push', ahead)).toBeNull()
    expect(bulkSkip('stash', clean)?.message).toMatch(/没有改动/)
    expect(bulkSkip('stash', conf)?.message).toMatch(/冲突/)
    expect(bulkSkip('fetch', det)).toBeNull()
  })
  it('OP_LABEL covers every bulk toolbar op with plain Chinese', () => {
    expect(OP_LABEL).toMatchObject({
      fetch: '抓取', pull: expect.stringContaining('拉取'), push: '推送',
      switch: '切换分支', branch: '新建分支', stash: '储藏', command: '运行命令'
    })
    expect(isDangerous('git reset --hard')).toBe(true)
    expect(isDangerous('git status -sb')).toBe(false)
  })
})

describe('health cell render without crash', () => {
  it('scores every fixture summary; tip is non-empty; na for missing', () => {
    for (const r of repos) {
      const h = repoHealth(sums[r.path])
      expect(h).toMatchObject({ score: expect.any(Number), grade: expect.stringMatching(/good|warn|bad|na/), label: expect.any(String) })
      expect(() => healthTip(h)).not.toThrow()
      expect(healthTip(h).length).toBeGreaterThan(0)
    }
    expect(repoHealth(undefined).grade).toBe('na')
    expect(repoHealth(sums['/p/detached']).issues.some((i) => /游离|分离|HEAD/.test(i.text))).toBe(true)
    expect(repoHealth(sums['/p/op-only']).grade).not.toBe('good')
  })
})


describe('dashboard card accent + meta helpers', () => {
  it('cardAccent severity: conflict > dirty > detached > sync > clean', () => {
    const find = (p: string) => repos.find((r) => r.path === p)!
    expect(cardAccent(sums['/p/conflict'], find('/p/conflict'))).toBe('conflict')
    expect(cardAccent(sums['/p/op-only'], find('/p/op-only'))).toBe('conflict')
    expect(cardAccent(sums['/p/dirty'], find('/p/dirty'))).toBe('dirty')
    expect(cardAccent(sums['/p/detached'], find('/p/detached'))).toBe('detached')
    expect(cardAccent(sums['/p/ahead'], find('/p/ahead'))).toBe('sync')
    expect(cardAccent(sums['/p/behind'], find('/p/behind'))).toBe('sync')
    expect(cardAccent(sums['/p/clean-a'], find('/p/clean-a'))).toBe('clean')
    expect(cardAccent(sums['/p/noup'], find('/p/noup'))).toBe('clean') // no upstream ≠ dirty accent
    expect(cardAccent(sums['/p/err'], find('/p/err'))).toBe('error')
    expect(cardAccent(undefined, find('/p/broken'))).toBe('uninit')
    // submodule detached alone stays clean accent
    expect(cardAccent(sums['/p/sub-det'], find('/p/sub-det'))).toBe('clean')
  })
  it('shortSha / shortUpstream helpers', () => {
    expect(shortSha('abcdef0123456789')).toBe('abcdef0')
    expect(shortSha('abc')).toBe('abc')
    expect(shortSha(null)).toBeNull()
    expect(shortUpstream('origin/main')).toBe('origin/main')
    expect(shortUpstream('  ')).toBeNull()
    expect(shortUpstream(null)).toBeNull()
  })
})

describe('module-boundary: 日常 Git 无可视化主入口; 工作区 strip ≠ 日常', () => {
  it('ADVANCED / daily MODULE views exclude viz; 看懂改动 owns viz+summary', () => {
    expect(ADVANCED.some((a) => a.id === 'viz')).toBe(false)
    expect(MODULES.find((m) => m.id === 'daily')!.views).not.toContain('viz')
    expect(moduleOf('viz')?.id).toBe('understand')
    expect(moduleOf('dashboard')?.id).toBe('workspace')
    expect(moduleOf('allchanges')?.id).toBe('workspace')
    // secondary tabs reachable from 日常: primary + branch extras + advanced — no viz
    const dailyTabs = [...PRIMARY.map((p) => p.id), ...BRANCH_SECTIONS.map((b) => b.id), ...visibleAdvanced({ submoduleCount: 3 }).map((a) => a.id)]
    expect(dailyTabs).not.toContain('viz')
    expect(dailyTabs).toEqual(expect.arrayContaining(['changes', 'history', 'branches', 'stash', 'worktrees', 'rebase', 'bisect', 'tools', 'forge', 'ai']))
  })
  it('on dashboard, viewTabStrip is workspace (概览/跨仓变更/仓库与扫描) — not 二分查错/AI助手', () => {
    expect(viewTabStrip('dashboard')).toBe('workspace')
    expect(viewTabStrip('repos')).toBe('workspace')
    expect(MODULES.find((m) => m.id === 'workspace')!.views).toEqual(['dashboard', 'allchanges', 'repos'])
    expect(viewTabStrip('bisect')).toBe('daily')
    expect(viewTabStrip('ai')).toBe('daily')
  })
  it('看懂改动 secondary strip is understand (改动摘要|可视化), not daily/workspace', () => {
    expect(viewTabStrip('summary')).toBe('understand')
    expect(viewTabStrip('viz')).toBe('understand')
    expect(MODULES.find((m) => m.id === 'understand')!.views).toEqual(['summary', 'viz'])
  })
})
