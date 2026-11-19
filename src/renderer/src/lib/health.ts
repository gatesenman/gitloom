// 0.6.1 体检: deterministic per-repo health check from the workspace summary (no network, no AI).
import type { RepoSummary } from '@shared/types'
export interface HealthIssue { level: '高' | '中' | '低'; text: string }
export interface Health { score: number; grade: 'good' | 'warn' | 'bad' | 'na'; label: string; issues: HealthIssue[] }
const DAY = 86400
export function repoHealth(s: RepoSummary | undefined, now = Date.now() / 1000): Health {
  if (!s) return { score: 0, grade: 'na', label: '—', issues: [] }
  if (s.error) return { score: 0, grade: 'bad', label: '读取失败', issues: [{ level: '高', text: `无法读取仓库状态：${s.error}` }] }
  const iss: HealthIssue[] = []
  if (s.conflicts) iss.push({ level: '高', text: `${s.conflicts} 个文件有冲突未解决` })
  if (s.operation) iss.push({ level: '高', text: `有进行中的操作（${s.operation}）未完成` })
  if (s.detached) iss.push({ level: '中', text: '处于游离 HEAD，不在任何分支上，新提交容易丢失' })
  if (s.behind) iss.push({ level: '中', text: `落后远程 ${s.behind} 个提交，建议拉取` })
  if (s.ahead) iss.push({ level: s.ahead > 10 ? '中' : '低', text: `有 ${s.ahead} 个提交还没推送` })
  if (!s.detached && s.branch && s.upstream === null && !s.bare) iss.push({ level: '低', text: '当前分支没有关联远程分支（未推送过）' })
  if (s.changes) iss.push({ level: s.changes > 50 ? '中' : '低', text: `有 ${s.changes} 个未提交的改动` })
  if (s.dirtySubmodules) iss.push({ level: '低', text: `${s.dirtySubmodules} 个子模块有改动` })
  if (s.lastCommit && now - s.lastCommit.date > 180 * DAY) iss.push({ level: '低', text: `最近一次提交在 ${Math.floor((now - s.lastCommit.date) / DAY)} 天前` })
  const pen = { 高: 35, 中: 15, 低: 5 } as const
  const score = Math.max(0, 100 - iss.reduce((n, i) => n + pen[i.level], 0))
  const grade = score >= 85 ? 'good' : score >= 60 ? 'warn' : 'bad'
  return { score, grade, label: grade === 'good' ? '健康' : grade === 'warn' ? '注意' : '需处理', issues: iss }
}
export const healthTip = (h: Health) => h.grade === 'na' ? '还没读取到状态' : `体检 ${h.score} 分（${h.label}）${h.issues.length ? '\n' + h.issues.map((i) => `· [${i.level}] ${i.text}`).join('\n') : '\n没有发现问题'}`
