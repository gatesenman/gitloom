import { describe, it, expect } from 'vitest'
import { MODULES, SCOPES, moduleOf, scopeOf, ADVANCED, PRIMARY, BRANCH_SECTIONS, viewTabStrip, crumbViewLabel, type View } from '../src/renderer/src/lib/nav'

describe('0.6.0 six modules', () => {
  it('has the six modules in order, each with plain Chinese label and tooltip', () => {
    expect(MODULES.map((m) => m.label)).toEqual(['日常 Git', '工作区', '看懂改动', '架构与知识', '质量把关', '自动化'])
    for (const m of MODULES) { expect(m.tip.length).toBeGreaterThan(8); expect(m.views).toContain(m.home) }
  })
  it('every existing view belongs to exactly one module (nothing unreachable)', () => {
    const all: View[] = ['changes', 'history', 'graph', 'branches', 'tags', 'worktrees', 'stash', 'hooks', 'ai', 'dashboard', 'allchanges', 'repos', 'rebase', 'bisect', 'tools', 'submodules', 'forge', 'blame', 'viz', 'knowledge', 'quality', 'automation', 'aitasks', 'summary', 'architecture', 'architecture-graph']
    for (const v of all) expect(MODULES.filter((m) => m.views.includes(v)).length, v).toBe(1)
    for (const v of [...PRIMARY.flatMap((p) => p.match), ...ADVANCED.map((a) => a.id), ...BRANCH_SECTIONS.map((b) => b.id)]) expect(moduleOf(v), v).toBeTruthy()
  })
  it('maps views per §6: viz→看懂改动, hooks→自动化, dashboard→工作区; daily has no viz', () => {
    expect(moduleOf('viz')?.label).toBe('看懂改动')
    expect(MODULES.find((m) => m.id === 'daily')!.views).not.toContain('viz')
    expect(ADVANCED.some((a) => a.id === 'viz')).toBe(false)
    expect(moduleOf('hooks')?.label).toBe('自动化')
    expect(moduleOf('allchanges')?.label).toBe('工作区')
    expect(moduleOf('rebase')?.label).toBe('日常 Git')
  })
  it('0.6.3: architecture + architecture-graph stay in 架构与知识; quality home is self-contained', () => {
    expect(moduleOf('architecture')?.id).toBe('knowledge')
    expect(moduleOf('architecture-graph')?.id).toBe('knowledge')
    expect(moduleOf('summary')?.id).toBe('understand')
    expect(moduleOf('quality')?.id).toBe('quality')
    expect(MODULES.find((m) => m.id === 'knowledge')!.views).toEqual(expect.arrayContaining(['knowledge', 'architecture', 'architecture-graph']))
    expect(MODULES.find((m) => m.id === 'knowledge')!.views).not.toContain('viz')
  })
  it('scope switch: 当前仓库 / 整个项目 / 仓库组', () => {
    expect(SCOPES.map((s) => s.label)).toEqual(['当前仓库', '整个项目', '仓库组'])
    expect(scopeOf('changes', null)).toBe('repo')
    expect(scopeOf('dashboard', null)).toBe('project')
    expect(scopeOf('dashboard', '/p/libs')).toBe('group')
  })
  it('scope tips stay Chinese and explain 仓库组 for the inline/picker hint (not a right rail)', () => {
    for (const s of SCOPES) {
      expect(s.tip.length).toBeGreaterThan(4)
      expect(s.tip).not.toMatch(/[A-Za-z]{8,}/) // keep plain Chinese UX copy
    }
    const group = SCOPES.find((s) => s.id === 'group')!
    expect(group.tip).toMatch(/文件夹/)
    expect(group.tip).toMatch(/一组仓库/)
  })
})

describe('0.6.5 boundary tips', () => {
  it('Understand=diff-only, Knowledge=HEAD-only, no mutual jump copy', () => {
    const u = MODULES.find((m) => m.id === 'understand')!
    const k = MODULES.find((m) => m.id === 'knowledge')!
    expect(u.tip).toMatch(/某次改动/)
    expect(u.tip).toMatch(/互不跳转|不跳转/)
    expect(k.tip).toMatch(/当前现状|HEAD/)
    expect(k.tip).toMatch(/不服务某次 diff|不跳进/)
    expect(k.home).toBe('knowledge')
    expect(u.views).toEqual(['summary', 'viz'])
  })
})

describe('0.6.6 automation three zones', () => {
  it('automation views include events/hooks/tasks; strip is automation', () => {
    const m = MODULES.find((x) => x.id === 'automation')!
    expect(m.views).toEqual(expect.arrayContaining(['automation', 'hooks', 'aitasks']))
    expect(m.home).toBe('automation')
    expect(moduleOf('aitasks')?.id).toBe('automation')
    expect(viewTabStrip('automation')).toBe('automation')
    expect(viewTabStrip('hooks')).toBe('automation')
    expect(viewTabStrip('aitasks')).toBe('automation')
    expect(m.tip).toMatch(/事件触发|定时任务/)
  })
})

describe('viewTabStrip: workspace vs daily secondary tabs (no mix)', () => {
  it('workspace views → only workspace strip; daily → only daily; automation → automation; hubs → null', () => {
    expect(viewTabStrip('dashboard')).toBe('workspace')
    expect(viewTabStrip('allchanges')).toBe('workspace')
    expect(viewTabStrip('repos')).toBe('workspace')
    expect(viewTabStrip('changes')).toBe('daily')
    expect(viewTabStrip('history')).toBe('daily')
    expect(viewTabStrip('bisect')).toBe('daily')
    expect(viewTabStrip('ai')).toBe('daily')
    expect(viewTabStrip('rebase')).toBe('daily')
    expect(viewTabStrip('knowledge')).toBeNull()
    expect(viewTabStrip('quality')).toBeNull()
    expect(viewTabStrip('automation')).toBe('automation')
    expect(viewTabStrip('hooks')).toBe('automation')
    expect(viewTabStrip('aitasks')).toBe('automation')
    expect(viewTabStrip('summary')).toBe('understand')
    expect(viewTabStrip('viz')).toBe('understand')
  })
  it('understand strip is 改动摘要 + 可视化 (not daily/workspace)', () => {
    expect(viewTabStrip('summary')).toBe('understand')
    expect(viewTabStrip('viz')).toBe('understand')
    const u = MODULES.find((m) => m.id === 'understand')!
    expect(u.views).toEqual(['summary', 'viz'])
    expect(u.home).toBe('summary')
    expect(viewTabStrip('dashboard')).not.toBe('understand')
    expect(viewTabStrip('changes')).not.toBe('understand')
  })
  it('workspace strip is exactly 概览 + 跨仓变更 + 仓库与扫描 (not 二分查错/AI助手)', () => {
    const ws = MODULES.find((m) => m.id === 'workspace')!
    expect(ws.views).toEqual(['dashboard', 'allchanges', 'repos'])
    expect(ws.tip).toMatch(/概览/)
    expect(ws.tip).toMatch(/跨仓变更/)
    expect(ws.tip).toMatch(/仓库与扫描/)
    expect(ws.views).not.toContain('bisect')
    expect(ws.views).not.toContain('ai')
    expect(ws.views).not.toContain('changes')
    expect(ws.views).not.toContain('history')
    const dailyIds = [...PRIMARY.map((p) => p.id), ...BRANCH_SECTIONS.map((b) => b.id), ...ADVANCED.map((a) => a.id)]
    for (const id of dailyIds) expect(viewTabStrip(id as View)).toBe('daily')
    // no label overlap with daily secondaries
    const dailyLabels = [...PRIMARY.map((p) => p.label), ...BRANCH_SECTIONS.map((b) => b.label), ...ADVANCED.map((a) => a.short)]
    for (const label of ['概览', '跨仓变更', '仓库与扫描']) expect(dailyLabels).not.toContain(label)
  })
})


describe('0.6.12 crumbViewLabel (sticky breadcrumb fix)', () => {
  it('workspace secondary tabs keep 概览 / 跨仓变更 / 仓库与扫描', () => {
    expect(crumbViewLabel('dashboard')).toBe('概览')
    expect(crumbViewLabel('allchanges')).toBe('跨仓变更')
    expect(crumbViewLabel('repos')).toBe('仓库与扫描')
  })
  it('non-workspace modules never fall back to 概览', () => {
    expect(crumbViewLabel('knowledge')).toBe('架构与知识')
    expect(crumbViewLabel('quality')).toBe('质量把关')
    expect(crumbViewLabel('automation')).toBe('事件触发')
    expect(crumbViewLabel('hooks')).toBe('钩子')
    expect(crumbViewLabel('aitasks')).toBe('定时任务')
    expect(crumbViewLabel('summary')).toBe('改动摘要')
    expect(crumbViewLabel('viz')).toBe('可视化')
    expect(crumbViewLabel('settings')).toBe('设置')
  })
  it('everyday daily-Git tabs omit a view crumb (repo+branch already shown)', () => {
    expect(crumbViewLabel('changes')).toBeNull()
    expect(crumbViewLabel('history')).toBeNull()
    expect(crumbViewLabel('branches')).toBeNull()
    expect(crumbViewLabel('ai')).toBeNull()
  })
})
