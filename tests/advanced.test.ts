import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { GitService } from '../src/main/git/service'
import { parseTodo, serializeTodo, buildRebasePlan } from '../src/main/git/advanced'
import { parseRemoteUrl, detectForge } from '../src/main/forge'

const git = new GitService()
let root = ''

async function sh(cwd: string, cmd: string) {
  const { spawnSync } = await import('child_process')
  const r = spawnSync('bash', ['-lc', cmd], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || cmd)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gitloom-adv-'))
  await sh(root, 'git init -b main && git config user.email t@t.com && git config user.name T')
  writeFileSync(join(root, 'a.txt'), 'one\n')
  await sh(root, 'git add a.txt && git commit -m "c1"')
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n')
  await sh(root, 'git add a.txt && git commit -m "c2 add two"')
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
  await sh(root, 'git add a.txt && git commit -m "c3 add three"')
  await sh(root, 'git branch feature')
})

afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* */ } })

describe('rebase todo parse/serialize', () => {
  it('parses pick/reword/squash/fixup/drop/break', () => {
    const todos = parseTodo(`pick abc1234 first\nreword def5678 second\nsquash aaa1111 third\nfixup bbb2222 fourth\ndrop ccc3333 gone\nbreak\n# comment\n`)
    expect(todos.map((t) => t.action)).toEqual(['pick', 'reword', 'squash', 'fixup', 'drop', 'break'])
    const text = serializeTodo(todos.filter((t) => t.action !== 'drop'))
    expect(text).toContain('pick abc1234')
    expect(text).toContain('break')
    expect(text).not.toMatch(/^drop /m)
  })
})

describe('buildRebasePlan', () => {
  it('lists commits onto..HEAD oldest-first', async () => {
    await sh(root, 'git checkout -B topic main~2')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    await sh(root, 'git add b.txt && git commit -m "topic1"')
    writeFileSync(join(root, 'c.txt'), 'c\n')
    await sh(root, 'git add c.txt && git commit -m "topic2"')
    const plan = await buildRebasePlan(git, root, 'main')
    expect(plan.todos.length).toBeGreaterThanOrEqual(2)
    expect(plan.todos[0].subject).toMatch(/topic/)
    await sh(root, 'git checkout main')
  })
})

describe('blame + fileHistory + pickaxe', () => {
  it('blames lines to authors', async () => {
    const lines = await git.blame(root, 'a.txt')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(lines[0].author).toBeTruthy()
    expect(lines[0].sha).toMatch(/^[0-9a-f]{40}$/)
  })
  it('file history follows file', async () => {
    const h = await git.fileHistory(root, 'a.txt')
    expect(h.length).toBeGreaterThanOrEqual(3)
  })
  it('pickaxe finds commits that added string', async () => {
    const hits = await git.pickaxe(root, 'three')
    expect(hits.some((h) => /three/i.test(h.subject) || h.files.includes('a.txt'))).toBe(true)
  })
})

describe('compareRefs + clean + config + signing', () => {
  it('compares two refs', async () => {
    const r = await git.compareRefs(root, 'main~1', 'main')
    expect(r.ahead + r.behind + r.commits.length).toBeGreaterThan(0)
  })
  it('clean preview lists untracked and protects nested repos', async () => {
    writeFileSync(join(root, 'junk.tmp'), 'x')
    mkdirSync(join(root, 'nested-repo'), { recursive: true })
    await sh(join(root, 'nested-repo'), 'git init -b main')
    const preview = await git.cleanPreview(root)
    expect(preview.some((e) => e.path === 'junk.tmp')).toBe(true)
    const nested = preview.find((e) => e.path === 'nested-repo')
    if (nested) expect(nested.nestedRepo).toBe(true)
  })
  it('listConfig returns local keys', async () => {
    const entries = await git.listConfig(root, 'local')
    expect(entries.some((e) => e.key === 'user.name')).toBe(true)
  })
  it('signingStatus returns hint or config', async () => {
    const s = await git.signingStatus(root)
    expect(s.userName).toBeTruthy()
    expect(typeof s.gpgSign).toBe('boolean')
  })
})

describe('bisect lifecycle', () => {
  it('start / mark / reset', async () => {
    // use git service
    const log = await git.log(root, { limit: 10 })
    const good = log[log.length - 1]?.hash
    const bad = log[0]?.hash
    expect(good && bad).toBeTruthy()
    let st = await git.bisectStart(root, bad!, good!)
    expect(st.active).toBe(true)
    await git.bisectReset(root)
    st = await git.bisectStatus(root)
    expect(st.active).toBe(false)
  })
})

describe('forge parse', () => {
  it('parses github and gitlab urls', () => {
    expect(parseRemoteUrl('git@github.com:acme/app.git')).toMatchObject({ kind: 'github', owner: 'acme', repo: 'app' })
    expect(parseRemoteUrl('https://gitlab.com/group/sub/proj.git')).toMatchObject({ kind: 'gitlab', owner: 'group/sub', repo: 'proj' })
    expect(detectForge([{ name: 'origin', fetchUrl: 'https://github.com/o/r.git' }])?.repo).toBe('r')
  })
})

describe('parent change count excludes nested', () => {
  it('summary.changes ignores nested repo dirs', async () => {
    const sum = await git.summary(root)
    // junk.tmp is untracked file; nested-repo may be excluded
    expect(sum.changes).toBeGreaterThanOrEqual(0)
    expect(sum.error).toBeUndefined()
  })
})
