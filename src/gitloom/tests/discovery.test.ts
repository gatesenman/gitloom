import { beforeAll, describe, expect, test } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { DEFAULT_IGNORE, classifyRepos, depthOf, ignoreMatcher, mergeRaws, parseGitmodules, probeRepo, scanFolder } from '../src/main/git/discovery'
import { GitService } from '../src/main/git/service'
import { ProjectManager } from '../src/main/projects'
import type { DiscoveredRepo, ScanProgress } from '../src/shared/types'

const ROOT = mkdtempSync(path.join(tmpdir(), 'gitloom-disc-'))
const P = path.join(ROOT, 'mono')
let repos: DiscoveredRepo[] = []
const by = (rel: string) => repos.find((r) => r.rel === rel)!

beforeAll(async () => {
  execFileSync('bash', [path.join(__dirname, '../scripts/make-complex-fixture.sh'), ROOT], { stdio: 'ignore' })
  const res = await scanFolder(P, { maxDepth: 6, ignore: DEFAULT_IGNORE })
  repos = classifyRepos(P, res.raws)
}, 60000)

describe('parseGitmodules / ignoreMatcher', () => {
  test('parses sections, paths, urls', () => {
    const m = parseGitmodules('[submodule "a"]\n\tpath = libs/a\n\turl = ../a.git\n[core]\n x = 1\n[submodule "b c"]\n path = b/\n')
    expect(m).toEqual([{ name: 'a', path: 'libs/a', url: '../a.git' }, { name: 'b c', path: 'b' }])
  })
  test('ignore matcher supports names and globs', () => {
    const m = ignoreMatcher(['node_modules', '*.egg-info', 'build/'])
    expect(m('node_modules')).toBe(true)
    expect(m('foo.egg-info')).toBe(true)
    expect(m('build')).toBe(true)
    expect(m('src')).toBe(false)
  })
  test('depthOf', () => { expect(depthOf('/a', '/a')).toBe(0); expect(depthOf('/a', '/a/b/c')).toBe(2) })
})

describe('scan of the complex fixture', () => {
  test('finds ≥25 repos including root, nested at depths 1-5', () => {
    expect(repos.length).toBeGreaterThanOrEqual(25)
    expect(by('').kind).toBe('normal')
    for (const rel of ['apps/web', 'apps/mobile/ios/native', 'libs/a/b/c/d', 'experiments/2024/q3/ml/model', 'packages/sdk/python']) {
      expect(by(rel)?.kind).toBe('nested')
      expect(by(rel).parent).toBe(path.resolve(P))
    }
  })
  test('skips repos inside ignored folders (node_modules)', () => {
    expect(repos.some((r) => r.rel.includes('node_modules'))).toBe(false)
  })
  test('symlink loop does not hang or duplicate; symlinked repo deduplicated', () => {
    expect(repos.filter((r) => r.rel.includes('loop')).length).toBe(0)
    expect(repos.filter((r) => r.rel === 'libs/core' || r.rel === 'links/core-link').length).toBe(1)
    expect(new Set(repos.map((r) => r.path)).size).toBe(repos.length)
  })
  test('submodules: initialized, nested (inside ignored vendor/), and uninitialized', () => {
    const shared = by('modules/shared')
    expect(shared.kind).toBe('submodule')
    expect(shared.initialized).toBe(true)
    expect(shared.parent).toBe(path.resolve(P))
    expect(shared.submodule?.name).toBe('modules/shared')
    const deep = by('modules/shared/vendor/deep')
    expect(deep.kind).toBe('submodule')
    expect(deep.initialized).toBe(true)
    expect(deep.parent).toBe(shared.path)
    const extra = by('modules/extra')
    expect(extra.kind).toBe('submodule')
    expect(extra.initialized).toBe(false)
  })
  test('worktrees inside and outside the project link to their main repo', () => {
    const inside = by('worktrees/web-inside')
    expect(inside.kind).toBe('worktree')
    expect(inside.mainRepo).toBe(by('apps/web').path)
    expect(inside.outside).toBeFalsy()
    const out = repos.find((r) => r.outside)!
    expect(out.kind).toBe('worktree')
    expect(out.rel).toBe('../outside/web-hotfix')
    expect(out.mainRepo).toBe(by('apps/web').path)
  })
  test('bare repository is detected and not descended', () => {
    expect(by('infra/mirror.git').kind).toBe('bare')
    expect(repos.some((r) => r.rel.startsWith('infra/mirror.git/'))).toBe(false)
  })
  test('maxDepth limits the walk', async () => {
    const res = await scanFolder(P, { maxDepth: 2, ignore: DEFAULT_IGNORE })
    const rels = classifyRepos(P, res.raws).map((r) => r.rel)
    expect(rels).toContain('apps/web')
    expect(rels).not.toContain('apps/mobile/ios/native')
    expect(rels).not.toContain('libs/a/b/c/d')
  })
  test('cancel stops the scan early and reports cancelled', async () => {
    const signal = { aborted: false }
    const res = await scanFolder(P, { maxDepth: 6, ignore: DEFAULT_IGNORE }, { signal, onProgress: () => { signal.aborted = true } })
    expect(res.cancelled).toBe(true)
    expect(res.raws.length).toBeLessThan(repos.length)
  })
  test('progress callback reports dirs and found counts', async () => {
    const seen: number[] = []
    await scanFolder(P, { maxDepth: 6, ignore: DEFAULT_IGNORE }, { onProgress: (p) => seen.push(p.found) })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(24)
  })
})

describe('probe + merge', () => {
  test('probeRepo identifies worktree gitfile with main repo', async () => {
    const r = await probeRepo(path.join(P, 'worktrees/web-inside'))
    expect(r?.git).toBe('worktree')
    expect(r?.mainRepo).toBe(path.join(P, 'apps/web'))
  })
  test('probeRepo returns null for plain folders', async () => { expect(await probeRepo(path.join(P, 'apps'))).toBeNull() })
  test('mergeRaws replaces only the rescanned subtree', () => {
    const prev = [{ path: '/p', git: 'dir' as const }, { path: '/p/a', git: 'dir' as const }, { path: '/p/a/x', git: 'dir' as const }, { path: '/p/b', git: 'dir' as const }]
    const next = [{ path: '/p/a', git: 'dir' as const }, { path: '/p/a/y', git: 'dir' as const }]
    expect(mergeRaws(prev, '/p/a', next).map((r) => r.path)).toEqual(['/p', '/p/a', '/p/a/y', '/p/b'])
  })
  test('classify: nested repo inside a nested repo gets the closest parent', () => {
    const c = classifyRepos('/r', [{ path: '/r', git: 'dir' }, { path: '/r/a', git: 'dir' }, { path: '/r/a/b/c', git: 'dir' }])
    expect(c.find((x) => x.rel === 'a/b/c')!.parent).toBe('/r/a')
  })
})

describe('service integration', () => {
  const git = new GitService()
  test('parentTracking: ignored / untracked / gitlink', async () => {
    expect(await git.parentTracking(P, path.join(P, 'services/auth'))).toBe('ignored')
    expect(await git.parentTracking(P, path.join(P, 'tools/local/scratch'))).toBe('ignored')
    expect(await git.parentTracking(P, path.join(P, 'apps/web'))).toBe('untracked')
    expect(await git.parentTracking(P, path.join(P, 'third_party/zlib'))).toBe('gitlink')
  })
  test('summaries: ahead/behind, conflict, detached, dirty, dirty submodule, bare', async () => {
    const list = await git.summaries(['apps/web', 'apps/api', 'libs/ui/components', 'services/auth', 'services/billing', '', 'infra/mirror.git'].map((r) => path.join(P, r)), 4)
    const [web, api, comp, auth, billing, root, bare] = list
    expect(web.ahead).toBe(2)
    expect(api.behind).toBe(1)
    expect(comp.conflicts).toBe(1)
    expect(comp.operation).toBe('MERGING')
    expect(auth.detached).toBe(true)
    expect(billing.changes).toBe(2)
    expect(root.dirtySubmodules).toBe(1)
    expect(bare.bare).toBe(true)
    expect(bare.branch).toBe('main')
    expect(web.lastCommit?.subject).toBe('feat(web): b')
  })
  test('ProjectManager: full scan emits progress + nested tracking, incremental rescan picks up new repo', async () => {
    const events: ScanProgress[] = []
    const pm = new ProjectManager(git, (ch, p) => { if (ch === 'scan:progress') events.push(p as ScanProgress) }, () => ({ maxDepth: 6, ignore: DEFAULT_IGNORE, concurrency: 4, watch: false }))
    const all = await pm.scan('s1', P)
    expect(events.at(-1)?.done).toBe(true)
    expect(events.at(-1)?.repos?.length).toBe(all.length)
    expect(all.find((r) => r.rel === 'services/auth')?.parentTracking).toBe('ignored')
    // add a repo below apps/ and rescan only that folder
    execFileSync('git', ['init', '-q', path.join(P, 'apps/new-app')])
    const after = await pm.scan('s2', P, path.join(P, 'apps'))
    expect(after.length).toBe(all.length + 1)
    expect(after.find((r) => r.rel === 'apps/new-app')?.kind).toBe('nested')
    rmSync(path.join(P, 'apps/new-app'), { recursive: true, force: true })
    const removed = await pm.scan('s3', P, path.join(P, 'apps'))
    expect(removed.length).toBe(all.length)
  })
  test('ProjectManager: fs watcher detects a new repo (debounced)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gitloom-watch-'))
    mkdirSync(path.join(dir, 'a'))
    const updates: { repos: DiscoveredRepo[] }[] = []
    const pm = new ProjectManager(git, (ch, p) => { if (ch === 'project:updated') updates.push(p as { repos: DiscoveredRepo[] }) }, () => ({ maxDepth: 4, ignore: DEFAULT_IGNORE, concurrency: 2, watch: true }))
    await pm.scan('w1', dir)
    execFileSync('git', ['init', '-q', path.join(dir, 'a', 'repo')])
    const end = Date.now() + 8000
    while (Date.now() < end && !updates.some((u) => u.repos.some((r) => r.rel === 'a/repo'))) await new Promise((r) => setTimeout(r, 100))
    pm.dispose()
    expect(updates.some((u) => u.repos.some((r) => r.rel === 'a/repo'))).toBe(true)
  }, 15000)
  test('symlink loop alone terminates', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gitloom-loop-'))
    mkdirSync(path.join(dir, 'x/y'), { recursive: true })
    symlinkSync('../..', path.join(dir, 'x/y/up'))
    writeFileSync(path.join(dir, 'x/f'), '')
    const res = await scanFolder(dir, { maxDepth: 20, ignore: [] })
    expect(res.visited).toBe(3)
  })
})
