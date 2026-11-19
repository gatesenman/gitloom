import React, { useEffect, useState } from 'react'
import type { BranchInfo, WorktreeInfo } from '@shared/types'
import { app, errMsg, git } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Empty, Skeleton, Spinner, useDialog, useToast } from '../components/ui'

export default function WorktreesView() {
  const { active, run, tick, addRepos, setActive, repos, setView, removeRepo } = useApp()
  const repo = active!
  const dialog = useDialog()
  const toast = useToast()
  const [wts, setWts] = useState<WorktreeInfo[] | null>(null)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [sums, setSums] = useState<Record<string, { changes: number; branch: string | null }>>({})

  const load = async () => {
    try {
      const list = await git.worktrees(repo)
      setWts(list)
      setBranches(await git.branches(repo))
      const s = await Promise.all(list.map((w) => git.summary(w.path).catch(() => null)))
      setSums(Object.fromEntries(s.filter(Boolean).map((x) => [x!.path, { changes: x!.changes, branch: x!.branch }])))
    } catch (e) { toast('err', errMsg(e)); setWts([]) }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [repo, tick % 6 === 0 ? tick : 0])

  const create = async () => {
    const main = wts?.[0]?.path ?? repo
    const parent = main.replace(/[\\/][^\\/]+$/, '')
    const base = main.split(/[\\/]/).pop()
    const locals = branches.filter((b) => !b.remote && !wts?.some((w) => w.branch === b.name))
    const r = await dialog({
      title: '新建工作树', message: '工作树让你在不同目录同时检出多个分支，无需来回切换或储藏。',
      fields: [
        { name: 'mode', label: '分支', type: 'select', value: 'new', options: [{ value: 'new', label: '新建分支' }, { value: 'existing', label: '使用已有分支' }, { value: 'detach', label: '分离 HEAD（临时实验）' }] },
        { name: 'newBranch', label: '新分支名（新建分支时）', placeholder: 'feature/xxx' },
        { name: 'branch', label: '已有分支 / 起点', type: 'select', value: locals[0]?.name ?? 'HEAD', options: [{ value: 'HEAD', label: 'HEAD（当前提交）' }, ...branches.map((b) => ({ value: b.name, label: b.name }))] },
        { name: 'path', label: '目录（留空自动生成）', placeholder: `${parent}/${base}-<分支名>` },
        { name: 'open', label: '创建后添加到工作区并打开', type: 'checkbox', value: true }
      ],
      okText: '创建工作树'
    })
    if (!r) return
    const mode = String(r.mode)
    const nb = String(r.newBranch || '').trim()
    const br = String(r.branch)
    if (mode === 'new' && !nb) { toast('err', '请填写新分支名'); return }
    const slug = (mode === 'new' ? nb : br).replace(/[^\w.-]+/g, '-')
    const dir = String(r.path || '').trim() || `${parent}/${base}-${slug}`
    const opts = mode === 'new' ? { newBranch: nb, base: br === 'HEAD' ? undefined : br } : mode === 'detach' ? { detach: true, branch: br } : { branch: br }
    const ok = await run('创建工作树', async () => { await git.addWorktree(repo, dir, opts); return true }, `已创建工作树 ${dir}`)
    if (ok) { await load(); if (r.open) { await addRepos([dir]) } }
  }

  const remove = async (w: WorktreeInfo) => {
    const dirty = (sums[w.path]?.changes ?? 0) > 0
    const r = await dialog({
      title: '移除工作树', danger: true, okText: '移除',
      message: <>将删除目录 <code>{w.path}</code>（分支 {w.branch ?? '无'} 会保留）。{dirty && <b className="err"> 该工作树有 {sums[w.path].changes} 个未提交的改动！</b>}</>,
      fields: [{ name: 'force', label: '强制移除（丢弃未提交改动 / 锁定）', type: 'checkbox', value: false }, { name: 'delBranch', label: `同时删除分支 ${w.branch ?? ''}`, type: 'checkbox', value: false }]
    })
    if (!r) return
    const ok = await run('移除工作树', async () => { await git.removeWorktree(repo, w.path, !!r.force); return true }, '已移除工作树')
    if (ok && repos.includes(w.path)) await removeRepo(w.path)
    if (ok && r.delBranch && w.branch) await run('删除分支', () => git.deleteBranch(repo, w.branch!, !!r.force))
    await load()
  }

  return (
    <div className="page">
      <div className="pane-toolbar">
        <b>工作树</b><span className="muted">{wts ? `${wts.length} 个` : ''}</span>
        <div className="flex1" />
        <button className="btn" onClick={() => run('清理', () => git.pruneWorktrees(repo), '已清理失效的工作树记录').then(load)}><Icon name="refresh" size={14} />清理失效（prune）</button>
        <button className="btn btn-primary" onClick={create}><Icon name="plus" size={14} />新建工作树</button>
      </div>
      <div className="cards">
        {!wts ? <Skeleton rows={4} variant="cards" /> : !wts.length ? <Empty icon="worktree" title="没有其它工作树">“想同时打开 main 和 feature 两个分支”时，新建一个工作树即可，不必来回切换。</Empty> : wts.map((w) => {
          const s = sums[w.path]
          const inWs = repos.includes(w.path)
          return (
            <div key={w.path} className={`card wt-card ${w.isCurrent ? 'current' : ''}`}>
              <div className="wt-top">
                <Icon name={w.isMain ? 'repo' : 'worktree'} size={18} />
                <div className="wt-title">
                  <div className="wt-branch">{w.branch ?? (w.detached ? `分离 HEAD @ ${w.head?.slice(0, 7)}` : w.bare ? '裸仓库' : '—')}</div>
                  <div className="wt-path" title={w.path}>{w.path}</div>
                </div>
                <div className="wt-tags">
                  {w.isMain && <span className="tag">主工作树</span>}
                  {w.isCurrent && <span className="tag tag-accent">当前</span>}
                  {w.locked && <span className="tag tag-warn" title={w.lockReason}>已锁定</span>}
                  {w.prunable && <span className="tag tag-err">目录已丢失</span>}
                  {s && s.changes > 0 && <span className="tag tag-warn">{s.changes} 个改动</span>}
                  {s && s.changes === 0 && <span className="tag tag-ok">干净</span>}
                </div>
              </div>
              <div className="wt-actions">
                <button className="btn btn-sm btn-primary" disabled={w.prunable || w.bare} onClick={async () => { if (!inWs) await addRepos([w.path]); else setActive(w.path); setView('changes') }}><Icon name="external" size={13} />{inWs ? '切换到此' : '在 GitLoom 中打开'}</button>
                <button className="btn btn-sm" disabled={w.prunable} onClick={() => window.api.openInEditor(w.path)}><Icon name="code" size={13} />VS Code</button>
                <button className="btn btn-sm" disabled={w.prunable} onClick={() => window.api.openTerminal(w.path)}><Icon name="terminal" size={13} />终端</button>
                <button className="btn btn-sm" disabled={w.prunable} onClick={() => window.api.openPath(w.path)}><Icon name="folder" size={13} /></button>
                <div className="flex1" />
                {!w.isMain && <button className="btn btn-sm" onClick={() => run(w.locked ? '解锁' : '锁定', () => git.lockWorktree(repo, w.path, !w.locked, w.locked ? undefined : '由 GitLoom 锁定')).then(load)}><Icon name={w.locked ? 'unlock' : 'lock'} size={13} />{w.locked ? '解锁' : '锁定'}</button>}
                {!w.isMain && <button className="btn btn-sm btn-ghost-danger" onClick={() => remove(w)}><Icon name="trash" size={13} />移除</button>}
              </div>
            </div>
          )
        })}
      </div>
      <div className="hint pad">工作树共享同一个对象库与分支；每个分支同一时间只能被一个工作树检出。适合并行开发、代码评审、跑长时间测试或交给 AI 智能体在独立目录中工作。</div>
    </div>
  )
}
