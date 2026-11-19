import { describe, it, expect } from 'vitest'
import {
  buildReleaseNotesDraft, plainSubject, parseLsRemoteTags, mergeTagPresence
} from '../src/renderer/src/lib/releaseNotes'
import { parseLsRemoteTags as parseMain } from '../src/main/git/parse'

describe('0.6.9 标签与发布 helpers', () => {
  it('plainSubject maps conventional commits', () => {
    expect(plainSubject('feat(auth): add login')).toBe('新功能：add login')
    expect(plainSubject('fix: crash on empty')).toBe('修复：crash on empty')
    expect(plainSubject('随便写一句')).toBe('随便写一句')
  })

  it('buildReleaseNotesDraft is Chinese markdown', () => {
    const md = buildReleaseNotesDraft({
      tagName: 'v1.2.0',
      sinceLabel: '自 v1.1.0 以来',
      repoName: 'demo',
      commits: [
        { short: 'abc1234', subject: 'feat: 加导出', author: 'A' },
        { short: 'def5678', subject: 'fix: 修空指针' }
      ]
    })
    expect(md).toMatch(/# v1\.2\.0 发布说明/)
    expect(md).toMatch(/新功能：加导出/)
    expect(md).toMatch(/修复：修空指针/)
    expect(md).toMatch(/升级提示/)
  })

  it('parseLsRemoteTags prefers peeled sha', () => {
    const out = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v1^{}',
      'cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v2'
    ].join('\n')
    expect(parseLsRemoteTags(out)).toEqual([
      { name: 'v1', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      { name: 'v2', sha: 'cccccccccccccccccccccccccccccccccccccccc' }
    ])
    expect(parseMain(out)).toEqual(parseLsRemoteTags(out))
  })

  it('mergeTagPresence local/remote/both', () => {
    const m = mergeTagPresence(
      [{ name: 'a', sha: '1' }, { name: 'b', sha: '2' }],
      [{ name: 'b', sha: '2' }, { name: 'c', sha: '3' }]
    )
    expect(m.find((x) => x.name === 'a')!.presence).toBe('local')
    expect(m.find((x) => x.name === 'b')!.presence).toBe('both')
    expect(m.find((x) => x.name === 'c')!.presence).toBe('remote')
  })
})
