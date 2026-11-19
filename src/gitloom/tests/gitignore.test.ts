import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { parseIgnoreContent, parseCheckIgnoreVerbose, explainIgnore } from '../src/main/git/gitignore'
import { GitService } from '../src/main/git/service'
import { tmpRepo, write, commitAll } from './helpers'

describe('gitignore parse', () => {
  it('parses patterns, comments, negation', () => {
    const lines = parseIgnoreContent('# keep\ndist/\n!dist/keep.txt\n\n*.log\n')
    expect(lines.find((l) => l.comment)?.raw).toMatch(/# keep/)
    expect(lines.find((l) => l.pattern === 'dist/')?.negated).toBeFalsy()
    expect(lines.find((l) => l.pattern === 'dist/keep.txt')?.negated).toBe(true)
    expect(lines.some((l) => l.blank)).toBe(true)
  })

  it('parseCheckIgnoreVerbose + explain', () => {
    const p = parseCheckIgnoreVerbose('.gitignore:2:dist/\tdist/a.js')
    expect(p).toMatchObject({ ignored: true, source: '.gitignore', line: 2, pattern: 'dist/', path: 'dist/a.js' })
    expect(explainIgnore(p)).toMatch(/会被忽略/)
    expect(explainIgnore({ ignored: false })).toMatch(/不会被忽略/)
  })
})

describe('GitService ignore helpers', () => {
  let repo: string
  const git = new GitService()
  beforeAll(() => {
    repo = tmpRepo('gitignore-')
    write(repo, '.gitignore', 'dist/\n*.tmp\n')
    write(repo, 'src/a.ts', 'export const a = 1\n')
    commitAll(repo, 'init')
    mkdirSync(join(repo, 'dist'), { recursive: true })
    writeFileSync(join(repo, 'dist/x.js'), '1\n')
  })
  afterAll(() => { try { rmSync(repo, { recursive: true, force: true }) } catch { /* */ } })

  it('listIgnoreSources + checkIgnorePath + write', async () => {
    const sources = await git.listIgnoreSources(repo)
    expect(sources.some((s) => s.path === '.gitignore')).toBe(true)
    const hit = await git.checkIgnorePath(repo, 'dist/x.js')
    expect(hit.ignored).toBe(true)
    expect(hit.explain).toMatch(/忽略/)
    const keep = await git.checkIgnorePath(repo, 'src/a.ts')
    expect(keep.ignored).toBe(false)
    await git.writeIgnoreFile(repo, 'dist/\n*.tmp\n.env\n', '.gitignore')
    const text = await git.readIgnoreFile(repo)
    expect(text).toContain('.env')
  })
})
