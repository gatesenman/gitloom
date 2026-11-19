/** 工作区卫生：冲突未解决、大量未暂存等 */
import { createHash } from 'crypto'
import type { Finding } from '../../shared/health'

function fid(...p: string[]): string {
  return 'hyg-' + createHash('sha1').update(p.join('|')).digest('hex').slice(0, 12)
}

export interface HygieneInput {
  conflicted: string[]
  staged: string[]
  unstaged: string[]
  untracked?: string[]
  operation?: string | null
  detached?: boolean
  repo?: string
}

export function hygieneFindings(input: HygieneInput): Finding[] {
  const out: Finding[] = []
  const repo = input.repo
  if (input.conflicted.length) {
    for (const f of input.conflicted.slice(0, 30)) {
      out.push({
        id: fid('conflict', f),
        severity: 'critical',
        category: 'hygiene',
        title: `冲突未解决：${f}`,
        detail: '工作区仍有合并冲突标记，需先解决再提交。',
        evidence: { path: f, line: 1 },
        fix: '打开该文件解决冲突后 git add；或中止合并/变基。',
        verify: 'git status 中不再出现 unmerged paths。',
        source: 'builtin',
        confidence: 'high',
        status: 'open',
        repo
      })
    }
  }
  if (input.operation) {
    out.push({
      id: fid('op', input.operation),
      severity: 'high',
      category: 'hygiene',
      title: `进行中的 Git 操作：${input.operation}`,
      detail: '仓库处于 merge/rebase/cherry-pick 等中间态。',
      evidence: {},
      fix: '完成或中止该操作后再做其它提交。',
      source: 'builtin',
      confidence: 'high',
      status: 'open',
      repo
    })
  }
  if (input.detached) {
    out.push({
      id: fid('detached'),
      severity: 'medium',
      category: 'hygiene',
      title: '处于游离 HEAD',
      detail: '当前不在任何分支上，新提交容易丢失。',
      evidence: {},
      fix: '创建或切换到分支：git switch -c <name>',
      source: 'builtin',
      confidence: 'high',
      status: 'open',
      repo
    })
  }
  const unstagedN = input.unstaged.length + (input.untracked?.length ?? 0)
  if (unstagedN >= 30) {
    out.push({
      id: fid('many-unstaged', String(unstagedN)),
      severity: unstagedN >= 80 ? 'medium' : 'low',
      category: 'hygiene',
      title: `大量未暂存改动（${unstagedN} 个文件）`,
      detail: '建议分批暂存与提交，避免一次变更过大。',
      evidence: { path: input.unstaged[0], line: 1 },
      fix: '按功能拆分暂存，或储藏部分改动。',
      source: 'builtin',
      confidence: 'high',
      status: 'open',
      repo
    })
  }
  if (input.staged.length >= 50) {
    out.push({
      id: fid('many-staged', String(input.staged.length)),
      severity: 'low',
      category: 'hygiene',
      title: `暂存区文件较多（${input.staged.length}）`,
      detail: '一次提交包含过多文件时审查困难。',
      evidence: {},
      fix: '考虑拆成多个逻辑提交。',
      source: 'builtin',
      confidence: 'medium',
      status: 'open',
      repo
    })
  }
  return out
}
