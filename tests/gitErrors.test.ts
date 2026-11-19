import { describe, it, expect } from 'vitest'
import { explainGitError, shortGitError } from '../src/renderer/src/lib/gitErrors'

describe('explainGitError', () => {
  const cases: [string, string, string | undefined][] = [
    ["remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/a/b.git/'", 'auth', 'openRemotes'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth', 'openRemotes'],
    ["fatal: unable to access 'https://127.0.0.1:9/x.git/': Failed to connect to 127.0.0.1 port 9", 'network', 'retry'],
    ["fatal: Could not resolve host: gitlab.example.com", 'network', 'retry'],
    ['fatal: The current branch feature/sms has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n    git push --set-upstream origin feature/sms', 'noUpstream', 'pushSetUpstream'],
    ['There is no tracking information for the current branch.', 'noUpstream', 'pushSetUpstream'],
    ['fatal: You are not currently on a branch.', 'detached', 'newBranch'],
    ['hint: Diverging branches can\'t be fast-forwarded, you need to either merge or rebase.\nfatal: Not possible to fast-forward, aborting.', 'diverged', 'pullRebase'],
    [" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'origin'", 'nonFastForward', 'pullRebase'],
    ['CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.', 'conflict', 'openChanges'],
    ['error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\nPlease commit your changes or stash them before you merge.', 'dirty', 'stash'],
    ["fatal: Unable to create '/r/.git/index.lock': File exists.", 'lock', 'retry'],
    ['remote: Repository not found.\nfatal: repository \'https://github.com/x/y.git/\' not found', 'notFound', 'openRemotes']
  ]
  for (const [raw, kind, fix] of cases) it(`${kind}: ${raw.slice(0, 40)}`, () => {
    const e = explainGitError(raw)!
    expect(e.kind).toBe(kind)
    expect(e.fix).toBe(fix)
    expect(e.title).toMatch(/[\u4e00-\u9fa5]/)
    if (fix) expect(e.fixLabel).toBeTruthy()
  })
  it('returns null for unknown errors and shortGitError falls back to the fatal line', () => {
    expect(explainGitError('something odd')).toBeNull()
    expect(shortGitError('warning: x\nfatal: bad object HEAD')).toBe('bad object HEAD')
    expect(shortGitError('fatal: Not possible to fast-forward, aborting.')).toMatch(/分叉/)
  })
})

import { pullSummary } from '../src/renderer/src/lib/gitErrors'
describe('bulk pull summary', () => {
  it('summarises git pull output in Chinese', () => {
    expect(pullSummary('Already up to date.\n', 0)).toBe('已是最新')
    expect(pullSummary('Updating a..b\nFast-forward\n R.txt | 1 +\n 1 file changed, 1 insertion(+)\n create mode 100644 R.txt\n', 1)).toBe('已快进 1 个提交 · 1 个文件（+1 −0）')
    expect(pullSummary('Fast-forward\n 3 files changed, 10 insertions(+), 2 deletions(-)\n', 4)).toBe('已快进 4 个提交 · 3 个文件（+10 −2）')
  })
})
