/** Conflict-resolution wizard helpers — pure, shared by Changes UI + unit tests. */
import type { FileChange, RepoStatus } from '@shared/types'

/** Git operation keys as reported by status.operation */
export type GitOp = 'MERGING' | 'REBASING' | 'CHERRY-PICKING' | 'REVERTING' | 'BISECTING' | string

export const OP_LABEL_ZH: Record<string, string> = {
  MERGING: '正在合并',
  REBASING: '正在变基',
  'CHERRY-PICKING': '正在拣选（cherry-pick）',
  REVERTING: '正在还原',
  BISECTING: '正在二分查找（bisect）'
}

export const CONTINUE_LABEL: Record<string, string> = {
  MERGING: '继续合并',
  REBASING: '继续变基',
  'CHERRY-PICKING': '继续拣选',
  REVERTING: '继续还原'
}

export const ABORT_LABEL: Record<string, string> = {
  MERGING: '中止合并',
  REBASING: '中止变基',
  'CHERRY-PICKING': '中止拣选',
  REVERTING: '中止还原',
  BISECTING: '结束二分'
}

/** True when the wizard should surface (in-progress op and/or conflicted files). */
export function shouldShowConflictWizard(st: Pick<RepoStatus, 'operation' | 'conflicted'> | null | undefined): boolean {
  if (!st) return false
  return !!st.operation || (st.conflicted?.length ?? 0) > 0
}

export function opLabelZh(op: string | null | undefined): string {
  if (!op) return '有冲突'
  return OP_LABEL_ZH[op] ?? op
}

export function continueLabel(op: string | null | undefined): string {
  if (!op) return '继续'
  return CONTINUE_LABEL[op] ?? '继续'
}

export function abortLabel(op: string | null | undefined): string {
  if (!op) return '中止'
  return ABORT_LABEL[op] ?? '中止'
}

/** Plain Chinese headline for beginners. */
export function wizardHeadline(st: Pick<RepoStatus, 'operation' | 'conflicted'>): string {
  const n = st.conflicted?.length ?? 0
  if (n > 0) return '有冲突要先处理'
  if (st.operation) return `${opLabelZh(st.operation)} — 冲突已全部解决，可以继续`
  return '有冲突要先处理'
}

export function wizardSubline(st: Pick<RepoStatus, 'operation' | 'conflicted'>): string {
  const n = st.conflicted?.length ?? 0
  const op = st.operation ? opLabelZh(st.operation) : null
  if (n > 0 && op) return `${op} · ${n} 个文件还没解决`
  if (n > 0) return `${n} 个文件还没解决`
  if (op) return `${op} · 冲突已全部解决`
  return ''
}

/** Short beginner tip under the banner. */
export const WIZARD_HINT =
  '同一处代码被两边都改了。打开文件选保留哪一边，或点「采用我方 / 对方」；全部解决后点「继续」。不想合了就「中止」。'

export interface ConflictFileRow {
  path: string
  statusLabel: string
  /** Index/worktree-style code for badge */
  code: string
}

export function conflictFileRows(files: FileChange[]): ConflictFileRow[] {
  return files.map((f) => ({
    path: f.path,
    statusLabel: '未解决',
    code: 'U'
  }))
}

/** Continue is allowed only when there is an op (not bisect) and no remaining conflicts. */
export function canContinueOp(st: Pick<RepoStatus, 'operation' | 'conflicted'>): boolean {
  if (!st.operation || st.operation === 'BISECTING') return false
  return (st.conflicted?.length ?? 0) === 0
}

export function canAbortOp(st: Pick<RepoStatus, 'operation'>): boolean {
  return !!st.operation
}

export function abortConfirmMessage(op: string | null | undefined): { title: string; message: string; okText: string } {
  const label = abortLabel(op)
  return {
    title: label,
    message: `确定${label}吗？未解决的冲突改动会丢掉，仓库回到操作开始前的状态。`,
    okText: label
  }
}
