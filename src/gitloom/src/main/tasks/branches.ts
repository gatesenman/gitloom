// 陈旧本地分支清理建议: facts are computed deterministically with git; this module NEVER deletes anything.
import type { Tools } from './tools'

export interface BranchFacts { repo: string; name: string; lastCommit: number; upstream: string | null; onRemote: boolean; merged: boolean; unpushed: number; main: string }
export interface BranchAdvice extends BranchFacts { suggest: 'delete' | 'keep'; reason: string }
const DAY = 86400

/** pure rule: delete only when merged into main AND no unpushed commits; otherwise keep with a reason */
export function classifyBranch(f: BranchFacts): BranchAdvice {
  if (f.unpushed > 0) return { ...f, suggest: 'keep', reason: `有 ${f.unpushed} 个提交只在本地（没推送到任何远程），删除会丢失` }
  if (!f.merged) return { ...f, suggest: 'keep', reason: `还没合并进 ${f.main}` }
  return { ...f, suggest: 'delete', reason: `已合并进 ${f.main}，且没有未推送的提交` }
}
/** stale = no commit for ≥ days AND never pushed (no upstream, tip not on any remote branch) */
export const isStale = (f: Pick<BranchFacts, 'lastCommit' | 'upstream' | 'onRemote' | 'name' | 'main'>, now: number, days = 30) =>
  f.name !== f.main && now - f.lastCommit >= days * DAY && !f.upstream && !f.onRemote

export async function mainBranch(t: Tools, repo: string): Promise<string> {
  const head = (await t.git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim()
  const local = (await t.git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout.split('\n').filter(Boolean)
  if (head && local.includes(head.replace(/^origin\//, ''))) return head.replace(/^origin\//, '')
  return local.find((b) => b === 'main') ?? local.find((b) => b === 'master') ?? local.find((b) => b === 'develop') ?? local[0] ?? 'main'
}
export async function branchFacts(t: Tools, repo: string): Promise<BranchFacts[]> {
  const main = await mainBranch(t, repo)
  const raw = (await t.git(repo, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)', 'refs/heads'])).stdout
  const remotes = (await t.git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])).stdout.split('\n').filter(Boolean)
  const out: BranchFacts[] = []
  for (const line of raw.split('\n').filter(Boolean)) {
    const [name, ts, up] = line.split('\t')
    // pushed at some point = a remote branch with the same name exists (or an upstream is configured)
    const onRemote = remotes.some((r) => r.endsWith(`/${name}`))
    const merged = name === main ? true : (await t.git(repo, ['merge-base', '--is-ancestor', `refs/heads/${name}`, `refs/heads/${main}`])).ok
    const unpushed = Number((await t.git(repo, ['rev-list', '--count', `refs/heads/${name}`, '--not', '--remotes'])).stdout.trim() || 0)
    out.push({ repo, name, lastCommit: Number(ts), upstream: up || null, onRemote, merged, unpushed, main })
  }
  return out
}
export function branchesMarkdown(list: BranchAdvice[], now: number, multiRepo: boolean): string {
  if (!list.length) return '## 本地很干净，没什么要清的\n\n没有超过 30 天未动、且从未推送的本地分支。'
  const del = list.filter((b) => b.suggest === 'delete')
  const keep = list.filter((b) => b.suggest === 'keep')
  const row = (b: BranchAdvice) => `- ${multiRepo ? `${b.repo.split(/[\\/]/).pop()} / ` : ''}\`${b.name}\` · 最后提交 ${new Date(b.lastCommit * 1000).toLocaleDateString('zh-CN')}（${Math.floor((now - b.lastCommit) / DAY)} 天前）· 已合并进 ${b.main}：${b.merged ? '是' : '否'} · 未推送提交：${b.unpushed ? `有 ${b.unpushed} 个` : '无'} — ${b.reason}`
  const table = (xs: BranchAdvice[]) => xs.map(row).join('\n')
  return [`## ${list.length} 个分支超过 30 天没动，其中 ${del.length} 个建议删除`, '',
    `### 建议删除（${del.length}）`, del.length ? table(del) : '无', '',
    `### 建议保留（${keep.length}）`, keep.length ? table(keep) : '无', '',
    '只给建议，GitLoom 不会删除任何分支。确认后可在「分支」页手动删除。'].join('\n')
}
