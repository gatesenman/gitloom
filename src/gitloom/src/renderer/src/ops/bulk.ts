// Bulk operations across many repositories: safe defaults, concurrency-limited, per-repo results, undo data.
import type { RepoSummary } from '@shared/types'
import { app, errMsg, git } from '../api'
import { pool } from '../components/ui'
import { pullSummary, shortGitError } from '../lib/gitErrors'
import { OP_LABEL, isDangerous, bulkSkip, type BulkOp, type BulkParams } from '../lib/bulkLogic'

export type { BulkOp, BulkParams }
export { OP_LABEL, isDangerous, bulkSkip }

export interface BulkResult { state: 'queued' | 'running' | 'ok' | 'skip' | 'err'; message?: string; /** raw git output for errors (tooltip) */ detail?: string; ms?: number; undo?: { kind: 'checkout' | 'stashpop'; ref?: string } }

async function one(op: BulkOp, repo: string, p: BulkParams, sum?: RepoSummary): Promise<BulkResult> {
  const skipped = bulkSkip(op, sum, p)
  if (skipped && (op === 'pull' || op === 'push' || op === 'stash')) return skipped
  switch (op) {
    case 'fetch': { const out = await git.fetch(repo); return { state: 'ok', message: out.trim().split('\n').filter(Boolean).slice(-2).join(' · ') || '已是最新' } }
    case 'pull': {
      const out = await git.pull(repo, false, true)
      return { state: 'ok', message: pullSummary(out, sum?.behind ?? 0), detail: out.trim() || undefined }
    }
    case 'push': {
      const out = await git.push(repo, { setUpstream: !sum?.upstream })
      return { state: 'ok', message: sum?.upstream ? `已推送 ${sum.ahead} 个提交到 ${sum.upstream}` : `已推送并关联上游 origin/${sum?.branch ?? ''}`, detail: out.trim() || undefined }
    }
    case 'switch': {
      const b = p.branch!
      const branches = await git.branches(repo)
      const local = branches.find((x) => !x.remote && x.name === b)
      if (local?.current) return { state: 'skip', message: '已在该分支' }
      const prev = sum?.detached ? undefined : sum?.branch ?? undefined
      if (local) { await git.checkout(repo, b); return { state: 'ok', message: `已切换到 ${b}`, undo: prev ? { kind: 'checkout', ref: prev } : undefined } }
      const remote = branches.find((x) => x.remote && x.name.replace(/^[^/]+\//, '') === b)
      if (remote) { await git.checkout(repo, remote.name); return { state: 'ok', message: `已从 ${remote.name} 创建并切换`, undo: prev ? { kind: 'checkout', ref: prev } : undefined } }
      if (p.createIfMissing) { await git.createBranch(repo, b); return { state: 'ok', message: `已新建并切换到 ${b}`, undo: prev ? { kind: 'checkout', ref: prev } : undefined } }
      return { state: 'skip', message: '不存在该分支' }
    }
    case 'branch': {
      const b = p.branch!
      const exists = (await git.branches(repo)).some((x) => !x.remote && x.name === b)
      if (exists) return { state: 'skip', message: '分支已存在' }
      const prev = sum?.detached ? undefined : sum?.branch ?? undefined
      await git.createBranch(repo, b)
      return { state: 'ok', message: `已创建并切换到 ${b}`, undo: prev ? { kind: 'checkout', ref: prev } : undefined }
    }
    case 'stash': {
      await git.stashPush(repo, p.message || 'GitLoom 批量储藏', { includeUntracked: p.untracked !== false })
      return { state: 'ok', message: '已储藏', undo: { kind: 'stashpop' } }
    }
    case 'command': {
      const r = await app.gitRaw(repo, p.command!)
      return { state: r.ok ? 'ok' : 'err', message: r.output.trim() || (r.ok ? '完成' : '失败') }
    }
  }
}

/** Run `op` on all repos (concurrency-limited); `onUpdate` receives per-repo state transitions. */
export async function runBulk(op: BulkOp, repos: string[], params: BulkParams, sums: Record<string, RepoSummary | undefined>, opts: { concurrency: number; signal: { cancelled: boolean }; onUpdate: (repo: string, r: BulkResult) => void; slowMs?: number }): Promise<Record<string, BulkResult>> {
  const results: Record<string, BulkResult> = {}
  for (const r of repos) { results[r] = { state: 'queued' }; opts.onUpdate(r, results[r]) }
  await pool(repos, opts.concurrency, async (repo: string) => {
    const t = Date.now()
    opts.onUpdate(repo, (results[repo] = { state: 'running' }))
    if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs))
    try { results[repo] = { ...(await one(op, repo, params, sums[repo])), ms: Date.now() - t } }
    catch (e) { const raw = errMsg(e); results[repo] = { state: 'err', message: shortGitError(raw), detail: raw, ms: Date.now() - t } }
    opts.onUpdate(repo, results[repo])
  }, opts.signal)
  for (const r of repos) if (results[r].state === 'queued') { results[r] = { state: 'skip', message: '已取消' }; opts.onUpdate(r, results[r]) }
  return results
}

/** Revert a bulk op where it is safe (switch back / pop the stash just created). */
export async function undoBulk(results: Record<string, BulkResult>): Promise<number> {
  let n = 0
  for (const [repo, r] of Object.entries(results)) {
    if (r.state !== 'ok' || !r.undo) continue
    try {
      if (r.undo.kind === 'checkout' && r.undo.ref) await git.checkout(repo, r.undo.ref)
      if (r.undo.kind === 'stashpop') await git.stashApply(repo, 0, true)
      n++
    } catch { /* leave as is */ }
  }
  return n
}
