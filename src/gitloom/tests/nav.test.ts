import { describe, it, expect } from 'vitest'
import { PRIMARY, ADVANCED, BRANCH_SECTIONS, STORIES, advancedOf, isAdvanced, primaryOf, visibleAdvanced, storyOf, introKey } from '../src/renderer/src/lib/nav'

describe('navigation model (v0.4.1)', () => {
  it('keeps only a small set of everyday tabs, each with tooltip and user story', () => {
    expect(PRIMARY.map((p) => p.label)).toEqual(['变更', '历史', '分支'])
    for (const p of PRIMARY) { expect(p.tip.length).toBeGreaterThan(4); expect(p.story.length).toBeGreaterThan(15) }
  })
  it('merges 分支图 into 历史; 储藏/工作树 are flat peers (not nested under 分支 highlight)', () => {
    expect(primaryOf('graph')?.id).toBe('history')
    expect(primaryOf('stash')).toBeUndefined()
    expect(primaryOf('worktrees')).toBeUndefined()
    expect(BRANCH_SECTIONS.map((b) => b.label)).toEqual(['分支与标签', '标签与发布', '储藏', '工作树'])
    expect(primaryOf('rebase')).toBeUndefined()
  })
  it('ADVANCED lists 整理提交 / 二分查错 / 文件追溯 / 子模块 / PR 与 Issue / AI 助手 (flat tabs, no 更多)', () => {
    expect(ADVANCED.map((a) => a.label)).toEqual(['整理提交（变基）', '二分查错', '文件追溯', '子模块', 'PR 与 Issue', 'AI 助手'])
    expect(ADVANCED.some((a) => a.id === 'viz')).toBe(false)
    for (const a of ADVANCED) { expect(a.icon).toBeTruthy(); expect(a.desc.length).toBeGreaterThan(8); expect(isAdvanced(a.id)).toBe(true) }
    expect(advancedOf('tools')?.label).toBe('文件追溯')
  })
  it('no feature is deleted: hooks moved to 设置, everything else in flat tabs', () => {
    expect(isAdvanced('hooks')).toBe(false)
    expect(storyOf('hooks')).toBeTruthy()
    const reachable = new Set([...PRIMARY.flatMap((p) => p.match), ...BRANCH_SECTIONS.map((b) => b.id), ...ADVANCED.map((a) => a.id), 'hooks', 'dashboard', 'allchanges', 'repos', 'settings', 'viz', 'summary'])
    for (const v of ['changes', 'history', 'graph', 'branches', 'tags', 'stash', 'worktrees', 'rebase', 'bisect', 'tools', 'submodules', 'forge', 'hooks', 'ai'] as const) expect(reachable.has(v)).toBe(true)
    expect(isAdvanced('viz')).toBe(false)
  })
  it('never shows raw "Forge" or the vague "工具" as a name', () => {
    for (const a of [...ADVANCED, ...PRIMARY, ...STORIES]) { expect(a.label).not.toMatch(/Forge/); expect(a.label).not.toBe('工具') }
  })
  it('lists 子模块 only when the repo has submodules', () => {
    expect(visibleAdvanced({ submoduleCount: 0 }).some((a) => a.id === 'submodules')).toBe(false)
    expect(visibleAdvanced({ submoduleCount: null }).some((a) => a.id === 'submodules')).toBe(false)
    expect(visibleAdvanced({ submoduleCount: 3 }).some((a) => a.id === 'submodules')).toBe(true)
    expect(visibleAdvanced({ submoduleCount: 0 })).toHaveLength(ADVANCED.length - 1)
  })
  it('every non-everyday view has a plain-Chinese user story for its intro', () => {
    for (const id of ['rebase', 'bisect', 'tools', 'submodules', 'forge', 'ai', 'hooks', 'stash', 'worktrees'] as const) {
      const s = storyOf(id)
      expect(s, id).toBeTruthy()
      expect(s!.story.length).toBeGreaterThan(20)
    }
    expect(storyOf('bisect')!.story).toContain('上周还好好的，今天坏了，中间有 200 个提交')
    expect(introKey('bisect')).toBe('gitloom.intro.bisect')
  })
})
