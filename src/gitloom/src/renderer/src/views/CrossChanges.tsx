// Cross-repo changes: changed files of many repos in one grouped list, per-repo stage/commit with AI messages.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileChange, RepoStatus } from '@shared/types'
import { app, errMsg, git } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { DiffPane } from '../components/DiffPane'
import { Empty, Resizer, Skeleton, Spinner, StatusBadge, pool, useMenu, useToast, usePersistentState } from '../components/ui'
import { RepoKindIcon } from '../components/RepoBits'
import { reposUnder } from '../lib/tree'

type Area = 'staged' | 'unstaged' | 'conflicted'
type Sel = { repo: string; path: string; area: Area; origPath?: string } | null
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

export default function CrossChanges() {
  const ctx = useApp()
  const { project, projectRepos, summaries, scope, refreshSummaries, setActive, setView, settings } = ctx
  const toast = useToast()
  const menu = useMenu()
  const [statuses, setStatuses] = useState<Record<string, RepoStatus>>({})
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<Sel>(null)
  const [msgs, setMsgs] = useState<Record<string, string>>({})
  const [ai, setAi] = useState<Record<string, boolean>>({})
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [leftW, setLeftW] = usePersistentState('gitloom.cross.leftW', 440)
  const root = project?.root ?? ''

  const candidates = useMemo(() => {
    const hidden = new Set(project?.hidden ?? [])
    return reposUnder(projectRepos, scope ?? root, root).filter((r) => r.initialized && r.kind !== 'bare' && !hidden.has(r.path))
  }, [projectRepos, scope, root, project?.hidden])
  // only query repos that look dirty (or whose summary is unknown) — cheap with 200+ repos
  const dirtyKey = candidates.filter((r) => !summaries[r.path] || summaries[r.path].changes > 0).map((r) => r.path).join('|')

  const loadOne = useCallback(async (repo: string) => {
    try { const st = await git.status(repo); setStatuses((s) => ({ ...s, [repo]: st })) }
    catch { setStatuses((s) => { const n = { ...s }; delete n[repo]; return n }) }
  }, [])
  const loadAll = useCallback(async () => {
    const list = dirtyKey ? dirtyKey.split('|') : []
    const out: Record<string, RepoStatus> = {}
    await pool(list, settings?.concurrency ?? 6, async (r) => { try { out[r] = await git.status(r) } catch { /* skip */ } })
    setStatuses(out)
    setLoading(false)
  }, [dirtyKey, settings?.concurrency])
  useEffect(() => { void loadAll() }, [loadAll])

  // untracked entries that are themselves discovered repos (nested / bare) are managed in their own group — hide them from the parent
  const nestedRoots = useMemo(() => projectRepos.map((r) => r.path.replace(/\\/g, '/')), [projectRepos])
  const hideNested = useCallback((repo: string, st?: RepoStatus): { st?: RepoStatus; hidden: number } => {
    if (!st) return { st, hidden: 0 }
    const base = repo.replace(/\\/g, '/')
    const inner = nestedRoots.filter((p) => p !== base && p.startsWith(base + '/'))
    if (!inner.length) return { st, hidden: 0 }
    const isNested = (f: FileChange) => { const abs = `${base}/${f.path.replace(/\/$/, '')}`; return inner.some((p) => abs === p || abs.startsWith(p + '/')) }
    const unstaged = st.unstaged.filter((f) => !(f.untracked && isNested(f)))
    return { st: { ...st, unstaged }, hidden: st.unstaged.length - unstaged.length }
  }, [nestedRoots])
  const groups = useMemo(() => candidates.map((r) => { const h = hideNested(r.path, statuses[r.path]); return { repo: r, st: h.st, hidden: h.hidden } }).filter((g) => g.st && g.st.staged.length + g.st.unstaged.length + g.st.conflicted.length > 0), [candidates, statuses])
  useEffect(() => { if (!sel && groups[0]) { const g = groups[0]; const f = g.st!.conflicted[0] ?? g.st!.unstaged[0] ?? g.st!.staged[0]; setSel({ repo: g.repo.path, path: f.path, area: g.st!.conflicted[0] ? 'conflicted' : g.st!.unstaged[0] ? 'unstaged' : 'staged', origPath: f.origPath }) } }, [groups, sel])

  const after = (repo: string) => { void loadOne(repo); void refreshSummaries([repo]) }
  // optimistic stage/unstage: move the row immediately, then reconcile with git
  const move = (repo: string, f: FileChange, from: Area, to: Area) => setStatuses((s) => {
    const st = s[repo]
    if (!st) return s
    const n = { ...st, [from]: st[from].filter((x) => x.path !== f.path) } as RepoStatus
    if (!n[to].some((x) => x.path === f.path)) n[to] = [...n[to], { ...f, index: to === 'staged' ? (f.untracked ? 'A' : f.worktree === ' ' ? f.index : f.worktree) : ' ', worktree: to === 'unstaged' ? (f.untracked ? '?' : f.index) : ' ' } as FileChange]
    return { ...s, [repo]: n }
  })
  const stage = async (repo: string, files: FileChange[], from: Area) => { files.forEach((f) => move(repo, f, from, 'staged')); try { await git.stage(repo, files.map((f) => f.path)) } catch (e) { toast('err', errMsg(e)) } after(repo) }
  const unstage = async (repo: string, files: FileChange[]) => { files.forEach((f) => move(repo, f, 'staged', 'unstaged')); try { await git.unstage(repo, files.map((f) => f.path)) } catch (e) { toast('err', errMsg(e)) } after(repo) }

  const genAI = async (repo: string) => {
    const st = statuses[repo]
    if (!st?.staged.length) { toast('info', `${base(repo)}：暂存区为空，请先暂存要提交的改动`); return false }
    setAi((a) => ({ ...a, [repo]: true }))
    try { const m = await app.ai('commitMessage', repo); setMsgs((x) => ({ ...x, [repo]: m.trim() })); return true }
    catch (e) { toast('err', `${base(repo)}：AI 生成失败：${errMsg(e)}`); return false }
    finally { setAi((a) => ({ ...a, [repo]: false })) }
  }
  const genAll = async () => {
    const list = groups.filter((g) => g.st!.staged.length).map((g) => g.repo.path)
    if (!list.length) { toast('info', '没有已暂存改动的仓库'); return }
    await pool(list, 2, genAI)
    toast('ok', `已为 ${list.length} 个仓库生成提交信息`)
  }
  const commit = async (repo: string) => {
    const m = (msgs[repo] ?? '').trim()
    if (!m) return
    try {
      const sha = await git.commit(repo, m, {})
      setMsgs((x) => ({ ...x, [repo]: '' }))
      toast('ok', `${base(repo)}：已提交 ${String(sha).slice(0, 7)}`, { label: '撤销提交', onClick: async () => { await git.reset(repo, 'HEAD~1', 'soft'); setMsgs((x) => ({ ...x, [repo]: m })); after(repo); toast('info', `${base(repo)}：已撤销提交（改动保留在暂存区）`) } })
    } catch (e) { toast('err', `${base(repo)}：提交失败：${errMsg(e)}`) }
    after(repo)
  }
  const commitAll = async () => {
    const list = groups.filter((g) => g.st!.staged.length && (msgs[g.repo.path] ?? '').trim()).map((g) => g.repo.path)
    for (const r of list) await commit(r)
  }

  const totals = groups.reduce((a, g) => ({ files: a.files + g.st!.staged.length + g.st!.unstaged.length + g.st!.conflicted.length, staged: a.staged + g.st!.staged.length }), { files: 0, staged: 0 })
  const ready = groups.filter((g) => g.st!.staged.length && (msgs[g.repo.path] ?? '').trim()).length
  if (!project) return <Empty icon="changes" title="还没有项目" />
  if (loading) return <Skeleton rows={10} />

  const fileRow = (repo: string, f: FileChange, area: Area) => {
    if (filter && !f.path.toLowerCase().includes(filter.toLowerCase())) return null
    const on = sel?.repo === repo && sel.path === f.path && sel.area === area
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''
    return (
      <div key={`${area}:${f.path}`} className={`xf-row ${on ? 'active' : ''}`} onClick={() => setSel({ repo, path: f.path, area, origPath: f.origPath })}
        onDoubleClick={() => (area === 'staged' ? unstage(repo, [f]) : stage(repo, [f], area))}
        onContextMenu={(e) => menu(e, [
          area === 'staged' ? { label: '取消暂存', icon: 'minus', onClick: () => unstage(repo, [f]) } : { label: area === 'conflicted' ? '标记为已解决' : '暂存', icon: 'plus', onClick: () => stage(repo, [f], area) },
          { label: '在仓库中打开', icon: 'external', onClick: () => { setActive(repo); setView('changes') } },
          { label: '在编辑器中打开', icon: 'code', onClick: () => window.api.openInEditor(`${repo}/${f.path}`) }
        ])}>
        <StatusBadge code={area === 'conflicted' ? 'U' : area === 'staged' ? f.index : f.worktree} />
        <span className="xf-path"><span className="xf-dir">{dir}</span>{f.path.slice(dir.length)}</span>
        <button className="icon-btn xs" title={area === 'staged' ? '取消暂存' : '暂存'} aria-label={area === 'staged' ? '取消暂存' : '暂存'} onClick={(e) => { e.stopPropagation(); if (area === 'staged') void unstage(repo, [f]); else void stage(repo, [f], area) }}><Icon name={area === 'staged' ? 'minus' : 'plus'} size={13} /></button>
      </div>
    )
  }

  return (
    <div className="split cross">
      <div className="pane-left" style={{ width: leftW }}>
        <div className="xc-toolbar">
          <div className="xc-sum"><b>{groups.length}</b> 个仓库 · <b>{totals.files}</b> 个文件 · 已暂存 <b>{totals.staged}</b></div>
          <div className="flex1" />
          <button className="icon-btn xs" title="刷新" aria-label="刷新" onClick={() => { setLoading(true); void refreshSummaries(candidates.map((r) => r.path)).then(loadAll) }}><Icon name="refresh" size={14} /></button>
        </div>
        <div className="xc-toolbar">
          <div className="side-search"><Icon name="search" size={13} /><input placeholder="筛选文件…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
          <button className="btn btn-sm" onClick={() => groups.forEach((g) => { const fs = g.st!.unstaged; if (fs.length) void stage(g.repo.path, fs, 'unstaged') })} title="暂存所有仓库的所有未暂存改动"><Icon name="plus" size={13} />全部暂存</button>
          <button className="btn btn-sm btn-ai" onClick={genAll} disabled={!totals.staged} title="AI 为每个已暂存的仓库分别生成提交信息"><Icon name="ai" size={13} />AI 全部生成</button>
          <button className="btn btn-sm btn-primary" onClick={commitAll} disabled={!ready} title="依次提交所有已填写信息且有暂存改动的仓库"><Icon name="commit" size={13} />提交 {ready || ''}</button>
        </div>
        <div className="xc-list">
          {!groups.length && <Empty icon="check" title="所有仓库都很干净">{candidates.length} 个仓库没有未提交的改动。</Empty>}
          {groups.map(({ repo: r, st, hidden }) => {
            const s = st!
            const open = !closed.has(r.path)
            const busy = !!ai[r.path]
            return (
              <div key={r.path} className="xg">
                <div className="xg-head" onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(r.path)) n.delete(r.path); else n.add(r.path); return n })}>
                  <Icon name="chevron" size={12} className={`chev ${open ? 'open' : ''}`} />
                  <RepoKindIcon repo={r} />
                  <b>{base(r.path)}</b>
                  <span className="xg-rel">{r.rel}</span>
                  <span className="xg-branch"><Icon name="branch" size={11} />{s.detached ? `(${s.headSha?.slice(0, 7)})` : s.branch}</span>
                  <div className="flex1" />
                  {hidden > 0 && <span className="kind-tag" title="父仓库把这些嵌套仓库 / 裸仓库目录视为未跟踪；它们在各自的分组中管理。建议在父仓库 .gitignore 中忽略。">隐藏 {hidden} 个嵌套路径</span>}
                  <span className="xg-count" title="已暂存 / 全部">{s.staged.length}/{s.staged.length + s.unstaged.length + s.conflicted.length}</span>
                  <button className="icon-btn xs" title="暂存此仓库全部改动" aria-label="暂存全部" onClick={(e) => { e.stopPropagation(); void stage(r.path, [...s.unstaged], 'unstaged') }}><Icon name="plus" size={13} /></button>
                  <button className="icon-btn xs" title="在仓库视图中打开" aria-label="打开仓库" onClick={(e) => { e.stopPropagation(); setActive(r.path); setView('changes') }}><Icon name="external" size={13} /></button>
                </div>
                {open && <>
                  {s.conflicted.map((f) => fileRow(r.path, f, 'conflicted'))}
                  {s.staged.map((f) => fileRow(r.path, f, 'staged'))}
                  {s.unstaged.map((f) => fileRow(r.path, f, 'unstaged'))}
                  <div className="xg-commit">
                    <textarea rows={2} placeholder={`提交信息 · ${base(r.path)}（${s.staged.length} 个已暂存）`} value={msgs[r.path] ?? ''} onChange={(e) => setMsgs((x) => ({ ...x, [r.path]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void commit(r.path) } }} aria-label={`${base(r.path)} 提交信息`} />
                    <div className="xg-actions">
                      <button className="btn btn-sm" disabled={busy || !s.staged.length} onClick={() => genAI(r.path)} title="根据该仓库暂存区生成提交信息">{busy ? <Spinner size={11} /> : <Icon name="ai" size={13} />}AI 生成</button>
                      <div className="flex1" />
                      <button className="btn btn-sm btn-primary" disabled={!s.staged.length || !(msgs[r.path] ?? '').trim()} onClick={() => commit(r.path)}><Icon name="commit" size={13} />提交到 {s.branch ?? 'HEAD'}</button>
                    </div>
                  </div>
                </>}
              </div>
            )
          })}
        </div>
      </div>
      <Resizer onResize={(d) => setLeftW((w) => Math.max(320, Math.min(820, w + d)))} />
      <div className="pane-right">
        {sel && statuses[sel.repo] ? (() => {
          const st = statuses[sel.repo]
          const f = [...st.conflicted, ...st.unstaged, ...st.staged].find((x) => x.path === sel.path)
          if (f?.submodule) return <Empty icon="repo-submodule" title="子模块指针变更">子模块的 SHA 指针变化请在「子模块」视图中管理；此处不展示文件级 diff。</Empty>
          return <DiffPane repo={sel.repo} file={sel.path} origPath={sel.origPath} source={{ kind: sel.area === 'staged' ? 'staged' : 'unstaged' }}
            header={<span className="xc-diffrepo"><RepoKindIcon repo={projectRepos.find((r) => r.path === sel.repo)} size={12} />{base(sel.repo)}</span>} />
        })() : <Empty icon="diff" title="选择一个文件查看差异" />}
      </div>
    </div>
  )
}
