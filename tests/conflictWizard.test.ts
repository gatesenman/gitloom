/**
 * Conflict-resolution wizard — pure helpers for 日常 Git · 变更.
 */
import { describe, it, expect } from 'vitest'
import type { FileChange, RepoStatus } from '../src/shared/types'
import {
  ABORT_LABEL, CONTINUE_LABEL, OP_LABEL_ZH, WIZARD_HINT,
  abortConfirmMessage, abortLabel, canAbortOp, canContinueOp,
  conflictFileRows, continueLabel, opLabelZh, shouldShowConflictWizard,
  wizardHeadline, wizardSubline
} from '../src/renderer/src/lib/conflictWizard'

const f = (path: string): FileChange => ({
  path, index: 'U', worktree: 'U', conflicted: true, untracked: false
})

const st = (x: Partial<RepoStatus> = {}): Pick<RepoStatus, 'operation' | 'conflicted'> => ({
  operation: null, conflicted: [], ...x
})

describe('shouldShowConflictWizard', () => {
  it('shows for conflicted files and/or in-progress ops', () => {
    expect(shouldShowConflictWizard(null)).toBe(false)
    expect(shouldShowConflictWizard(st())).toBe(false)
    expect(shouldShowConflictWizard(st({ conflicted: [f('a.ts')] }))).toBe(true)
    expect(shouldShowConflictWizard(st({ operation: 'MERGING' }))).toBe(true)
    expect(shouldShowConflictWizard(st({ operation: 'REBASING', conflicted: [f('a.ts')] }))).toBe(true)
  })
})

describe('Chinese copy for beginners', () => {
  it('headline / subline / hint are plain Chinese', () => {
    expect(wizardHeadline(st({ conflicted: [f('a.ts')], operation: 'MERGING' }))).toBe('有冲突要先处理')
    expect(wizardSubline(st({ conflicted: [f('a.ts'), f('b.ts')], operation: 'MERGING' }))).toMatch(/2 个文件/)
    expect(wizardHeadline(st({ operation: 'REBASING', conflicted: [] }))).toMatch(/可以继续/)
    expect(WIZARD_HINT).toMatch(/有冲突|打开文件|继续|中止/)
    expect(OP_LABEL_ZH.MERGING).toBe('正在合并')
    expect(CONTINUE_LABEL.REBASING).toBe('继续变基')
    expect(ABORT_LABEL.MERGING).toBe('中止合并')
    expect(opLabelZh('CHERRY-PICKING')).toMatch(/拣选/)
    expect(continueLabel('MERGING')).toBe('继续合并')
    expect(abortLabel('REBASING')).toBe('中止变基')
  })
  it('abort confirm warns that unresolved changes are discarded', () => {
    const c = abortConfirmMessage('MERGING')
    expect(c.title).toBe('中止合并')
    expect(c.message).toMatch(/丢掉|开始前/)
    expect(c.okText).toBe('中止合并')
  })
})

describe('continue / abort gates', () => {
  it('continue only when op present, not bisect, and zero conflicts', () => {
    expect(canContinueOp(st({ operation: 'MERGING', conflicted: [f('a.ts')] }))).toBe(false)
    expect(canContinueOp(st({ operation: 'MERGING', conflicted: [] }))).toBe(true)
    expect(canContinueOp(st({ operation: 'BISECTING', conflicted: [] }))).toBe(false)
    expect(canContinueOp(st({ operation: null, conflicted: [] }))).toBe(false)
    expect(canAbortOp(st({ operation: 'REBASING' }))).toBe(true)
    expect(canAbortOp(st({ operation: null }))).toBe(false)
  })
})

describe('conflictFileRows', () => {
  it('maps conflicted files to checklist rows', () => {
    const rows = conflictFileRows([f('src/a.ts'), f('b.md')])
    expect(rows).toEqual([
      { path: 'src/a.ts', statusLabel: '未解决', code: 'U' },
      { path: 'b.md', statusLabel: '未解决', code: 'U' }
    ])
  })
})
