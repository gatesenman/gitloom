// Pure bulk-op helpers (safe to import from node/vitest tsconfig — no React/api).
import type { RepoSummary } from '@shared/types'

export type BulkOp = 'fetch' | 'pull' | 'push' | 'switch' | 'branch' | 'stash' | 'command'
export interface BulkParams { branch?: string; createIfMissing?: boolean; message?: string; untracked?: boolean; command?: string; setUpstream?: boolean }
export interface BulkSkipResult { state: 'skip'; message: string }

export const OP_LABEL: Record<BulkOp, string> = {
  fetch: '抓取', pull: '拉取（仅快进）', push: '推送', switch: '切换分支',
  branch: '新建分支', stash: '储藏', command: '运行命令'
}

/** Commands that rewrite history or discard data need an extra confirmation. */
export function isDangerous(cmd: string): boolean {
  return /\b(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*(--force|-f\b)|branch\s+-D|checkout\s+--\s|restore\b|rebase\b|filter-branch|update-ref\s+-d|reflog\s+expire|gc\s+--prune|stash\s+(drop|clear))/.test(cmd)
}

/** Pure preflight: return a skip result when the op should not run, else null. */
export function bulkSkip(op: BulkOp, sum: RepoSummary | undefined, p: BulkParams = {}): BulkSkipResult | null {
  if (op === 'pull') {
    if (!sum?.upstream) return { state: 'skip', message: '没有上游分支' }
    if (sum.detached) return { state: 'skip', message: '分离 HEAD' }
  }
  if (op === 'push') {
    if (sum?.detached) return { state: 'skip', message: '分离 HEAD' }
    if (!sum?.upstream && !p.setUpstream) return { state: 'skip', message: '没有上游分支（可勾选“自动设置上游”）' }
    if (sum?.upstream && !sum.ahead) return { state: 'skip', message: '没有待推送的提交' }
  }
  if (op === 'stash') {
    if (!sum?.changes) return { state: 'skip', message: '没有改动' }
    if (sum.conflicts) return { state: 'skip', message: '存在冲突' }
  }
  return null
}
