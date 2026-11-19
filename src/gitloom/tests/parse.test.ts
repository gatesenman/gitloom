import { describe, it, expect } from 'vitest'
import { buildHunkPatch, parseBranches, parseDiff, parseLog, parseStatusV2, parseWorktrees, splitArgs, langFromPath } from '../src/main/git/parse'

describe('parsers', () => {
  it('parses porcelain v2 status', () => {
    const out = [
      '# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
      '1 .M N... 100644 100644 100644 aaa bbb src/b file.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts', 'old.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? untracked.txt', ''
    ].join('\0')
    const st = parseStatusV2(out)
    expect(st.branch).toBe('main')
    expect(st.ahead).toBe(2); expect(st.behind).toBe(1)
    expect(st.staged.map((f) => f.path)).toEqual(['src/a.ts', 'new.ts'])
    expect(st.staged[1].origPath).toBe('old.ts')
    expect(st.unstaged.map((f) => f.path)).toEqual(['src/b file.ts', 'untracked.txt'])
    expect(st.conflicted[0].path).toBe('conflict.txt')
  })

  it('parses log with refs', () => {
    const rec = ['h1', 'h1s', 'p1 p2', 'A', 'a@x', '1700000000', 'HEAD -> main, origin/main, tag: v1', 'msg', 'N'].join('\x1f') + '\x1e\n'
    const [c] = parseLog(rec)
    expect(c.parents).toEqual(['p1', 'p2'])
    expect(c.refs).toContain('tag: v1')
    expect(c.signature).toBe('N')
  })

  it('parses branches and filters origin/HEAD', () => {
    const out = ['refs/heads/main\x1fmain\x1fsha\x1forigin/main\x1f[ahead 1, behind 3]\x1f*\x1f1\x1fs',
      'refs/remotes/origin/HEAD\x1forigin/HEAD\x1fsha\x1f\x1f\x1f \x1f1\x1fs'].join('\n')
    const b = parseBranches(out)
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ current: true, ahead: 1, behind: 3, upstream: 'origin/main' })
  })

  it('parses worktrees', () => {
    const out = 'worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r-wt\nHEAD bbb\ndetached\nlocked busy\n\n'
    const w = parseWorktrees(out, '/r-wt')
    expect(w).toHaveLength(2)
    expect(w[0]).toMatchObject({ isMain: true, branch: 'main' })
    expect(w[1]).toMatchObject({ detached: true, locked: true, lockReason: 'busy', isCurrent: true })
  })

  it('builds partial hunk patches', () => {
    const diff = 'diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n'
    const [fd] = parseDiff(diff)
    expect(fd.hunks).toHaveLength(1)
    const full = buildHunkPatch(fd, 0)!
    expect(full).toContain('@@ -1,3 +1,3 @@')
    // select only the "+B" line (index 2) for forward apply: "-b" becomes context
    const partial = buildHunkPatch(fd, 0, new Set([2]))!
    expect(partial).toContain('@@ -1,3 +1,4 @@')
    expect(partial).toContain(' b\n+B')
    // reverse: select only "-b" (index 1): "+B" becomes context
    const rev = buildHunkPatch(fd, 0, new Set([1]), true)!
    expect(rev).toContain('@@ -1,4 +1,3 @@')
    expect(buildHunkPatch(fd, 0, new Set([0]))).toBeNull()
  })

  it('splits args and detects languages', () => {
    expect(splitArgs('git commit -m "hello world"')).toEqual(['git', 'commit', '-m', 'hello world'])
    expect(langFromPath('a/b.tsx')).toBe('typescript')
  })
})
