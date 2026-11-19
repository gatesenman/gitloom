// Workspace dashboard: all repos under the selected project/folder with status, multi-select and
// concurrent bulk actions (fetch / pull --ff-only / push / switch / branch / stash / custom command).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { repoHealth, healthTip } from '../lib/health'
import type { DiscoveredRepo, RepoSummary } from '@shared/types'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Empty, Resizer, Spinner, relTime, useDialog, useMenu, useToast, usePersistentState } from '../components/ui'
import { KIND_LABEL, RepoKindIcon, StatusBadges, repoMenu, repoTitle } from '../components/RepoBits'
import { fuzzyScore, reposUnder } from '../lib/tree'
import { DASH_FILTERS, cardAccent, dashFilterCounts, hasNoUpstream, isOverviewClean, quickSyncTargets, shortSha, shortUpstream, summarizeBulkResults, todayTodos, type DashFilter } from '../lib/dashOverview'
import { OP_LABEL, isDangerous, runBulk, undoBulk, type BulkOp, type BulkParams, type BulkResult } from '../ops/bulk'
import { app, git, health } from '../api'
import { highestSeverity, SEVERITY_LABELS, type FindingSeverity, type HealthReport } from '@shared/health'

const FILTERS = DASH_FILTERS
type Filter = DashFilter
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

interface BulkRun { op: BulkOp; label: string; repos: string[]; results: Record<string, BulkResult>; started: number; finished?: number; signal: { cancelled: boolean } }

export default function Dashboard() {
  const ctx = useApp()
  const { project, projectRepos, summaries, scope, setScope, setActive, setView, settings, refreshSummaries, pinned } = ctx
  const dialog = useDialog()
  const toast = useToast()
  const menu = useMenu()
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [layout, setLayout] = usePersistentState<'table' | 'cards'>('gitloom.dash.layout', 'table')
  const [logH, setLogH] = usePersistentState('gitloom.dash.logH', 220)
  const [bulk, setBulk] = useState<BulkRun | null>(null)
  const [onlyFailed, setOnlyFailed] = useState(false)
  const lastClick = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(500)
  const ROW_H = settings?.density === 'compact' ? 32 : 40

  const root = project?.root ?? ''
  const scoped = useMemo(() => {
    const hidden = new Set(project?.hidden ?? [])
    return reposUnder(projectRepos, scope ?? root, root).filter((r) => !hidden.has(r.path))
  }, [projectRepos, scope, root, project?.hidden])
  const counts = useMemo(() => dashFilterCounts(scoped, summaries), [scoped, summaries])
  const shown = useMemo(() => {
    // Prefer shared applyDashFilter for chip parity; keep fuzzyScore for multi-token UX
    const f = FILTERS.find((x) => x.id === filter)!
    let list = scoped.filter((r) => f.test(summaries[r.path], r))
    if (q.trim()) list = list.filter((r) => fuzzyScore(q, `${base(r.path)} ${r.rel} ${summaries[r.path]?.branch ?? ''}`) >= 0)
    return list
  }, [scoped, filter, q, summaries])
  const actionable = shown.filter((r) => r.initialized)
  // one-click sync targets (whole scope, independent of the current filter chip)
  const quick = useMemo(() => quickSyncTargets(scoped, summaries), [scoped, summaries])
  const todos = useMemo(() => todayTodos(scoped, summaries, { includeDirty: true }), [scoped, summaries])
  const targets = sel.size ? actionable.filter((r) => sel.has(r.path)) : actionable

  useEffect(() => { setSel(new Set()) }, [scope, project?.id])
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [layout])

  // ---------------------------------------------------------------- bulk execution
  const startingRef = useRef(false)
  const startBulkRef = useRef<(op: BulkOp, params: BulkParams, list: DiscoveredRepo[], slowMs?: number) => Promise<void>>(async () => undefined)
  const start = useCallback(async (op: BulkOp, params: BulkParams, list: DiscoveredRepo[], slowMs?: number) => {
    if (startingRef.current) return            // double-click on 全部拉取 / 推送 → one bulk run
    startingRef.current = true
    try { await startBulkRef.current(op, params, list, slowMs) } finally { startingRef.current = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const startBulk = useCallback(async (op: BulkOp, params: BulkParams, list: DiscoveredRepo[], slowMs?: number) => {
    const repos = list.filter((r) => r.initialized && (op === 'fetch' || op === 'command' || r.kind !== 'bare')).map((r) => r.path)
    if (!repos.length) { toast('info', '没有可执行的仓库'); return }
    const run: BulkRun = { op, label: OP_LABEL[op] + (op === 'command' ? `：${params.command}` : params.branch ? `：${params.branch}` : ''), repos, results: {}, started: Date.now(), signal: { cancelled: false } }
    setBulk(run); setOnlyFailed(false)
    let pending: Record<string, BulkResult> = {}
    let raf = 0
    const flush = () => { raf = 0; const p = pending; pending = {}; setBulk((b) => (b && b.started === run.started ? { ...b, results: { ...b.results, ...p } } : b)) }
    const results = await runBulk(op, repos, params, summaries, {
      concurrency: settings?.concurrency ?? 6, signal: run.signal, slowMs,
      onUpdate: (repo, r) => { pending[repo] = r; if (!raf) raf = requestAnimationFrame(flush) }
    })
    cancelAnimationFrame(raf); flush()
    setBulk((b) => (b && b.started === run.started ? { ...b, results, finished: Date.now() } : b))
    void refreshSummaries(repos)
    void ctx.refresh()
    const vals = Object.values(results)
    const ok = vals.filter((r) => r.state === 'ok').length, err = vals.filter((r) => r.state === 'err').length, skip = vals.filter((r) => r.state === 'skip').length
    const undoable = vals.some((r) => r.state === 'ok' && r.undo)
    toast(err ? 'err' : 'ok', `${OP_LABEL[op]}完成：成功 ${ok}${skip ? ` · 跳过 ${skip}` : ''}${err ? ` · 失败 ${err}` : ''}`, undoable ? { label: '撤销', onClick: async () => { const n = await undoBulk(results); toast('ok', `已撤销 ${n} 个仓库`); void refreshSummaries(repos); void ctx.refresh() } } : undefined)
  }, [summaries, settings?.concurrency, refreshSummaries, toast, ctx])
  startBulkRef.current = startBulk

  const ask = async (op: BulkOp) => {
    const n = targets.length
    const who = sel.size ? `已选的 ${n} 个仓库` : `当前列表中的全部 ${n} 个仓库`
    if (op === 'fetch' || op === 'pull') return start(op, {}, targets)
    if (op === 'push') {
      const r = await dialog({ title: `推送 ${n} 个仓库`, message: <>将对{who}执行 <code>git push</code>。没有待推送提交或分离 HEAD 的仓库会被跳过。</>, fields: [{ name: 'up', label: '没有上游分支时自动设置上游（git push -u origin 当前分支）', type: 'checkbox', value: false }], okText: '推送' })
      if (r) return start('push', { setUpstream: !!r.up }, targets)
      return
    }
    if (op === 'switch') {
      const r = await dialog({ title: `在 ${n} 个仓库中切换分支`, message: <>对{who}执行 checkout。存在本地分支则切换；仅存在远程分支则创建跟踪分支。有冲突的未提交改动时 git 会拒绝切换（不会丢失数据）。完成后可一键撤销。</>, fields: [{ name: 'b', label: '分支名', placeholder: 'main / develop / feature/x' }, { name: 'c', label: '不存在时新建该分支', type: 'checkbox', value: false }], okText: '切换' })
      if (r?.b) return start('switch', { branch: String(r.b).trim(), createIfMissing: !!r.c }, targets)
      return
    }
    if (op === 'branch') {
      const r = await dialog({ title: `在 ${n} 个仓库中新建分支`, message: <>基于各仓库当前 HEAD 创建并切换到新分支（已存在则跳过）。可撤销（切回原分支）。</>, fields: [{ name: 'b', label: '新分支名', placeholder: 'feature/cross-repo-change' }], okText: '创建' })
      if (r?.b) return start('branch', { branch: String(r.b).trim() }, targets)
      return
    }
    if (op === 'stash') {
      const r = await dialog({ title: `储藏 ${n} 个仓库的改动`, message: <>没有改动或存在冲突的仓库会被跳过。完成后可一键撤销（stash pop）。</>, fields: [{ name: 'm', label: '储藏说明', value: `GitLoom 批量储藏 ${new Date().toLocaleString('zh-CN', { hour12: false })}` }, { name: 'u', label: '包含未跟踪文件', type: 'checkbox', value: true }], okText: '储藏' })
      if (r) return start('stash', { message: String(r.m), untracked: !!r.u }, targets)
      return
    }
    if (op === 'command') {
      const r = await dialog({ title: `在 ${n} 个仓库中运行 git 命令`, message: <>命令不经过 shell 执行，不支持管道与多条命令。常用：<code>git status -sb</code>、<code>git log -1 --oneline</code>、<code>git remote -v</code>。</>, fields: [{ name: 'c', label: '命令', placeholder: 'git status -sb', value: 'git status -sb' }], okText: '下一步' })
      if (!r?.c) return
      const cmd = String(r.c).trim().replace(/^(?!git\s)/, 'git ')
      if (isDangerous(cmd) && !(await dialog({ title: '危险命令', message: <>“<code>{cmd}</code>”可能改写历史或丢弃改动，并将在 <b>{n}</b> 个仓库中执行。确定继续吗？</>, danger: true, okText: `在 ${n} 个仓库执行` }))) return
      return start('command', { command: cmd }, targets)
    }
  }

  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as string
      if (d === 'fetch-all') void start('fetch', {}, actionable)
      if (d === 'fetch-all-slow') void start('fetch', {}, actionable, 700)
      if (d === 'status-all') void start('command', { command: 'git status -sb' }, actionable)
    }
    window.addEventListener('gitloom:dashboard', h)
    return () => window.removeEventListener('gitloom:dashboard', h)
  }, [start, actionable])
  // (demo/screenshot) bulk runs can be triggered via the navigate bridge — see Shell

  // ---------------------------------------------------------------- selection
  const toggleSel = (i: number, e: React.MouseEvent) => {
    const r = shown[i]
    if (!r.initialized) return
    const n = new Set(sel)
    if (e.shiftKey && lastClick.current !== null) {
      const [a, b] = [Math.min(lastClick.current, i), Math.max(lastClick.current, i)]
      for (let k = a; k <= b; k++) if (shown[k].initialized) n.add(shown[k].path)
    } else if (n.has(r.path)) n.delete(r.path); else n.add(r.path)
    lastClick.current = i
    setSel(n)
  }
  const allSel = actionable.length > 0 && actionable.every((r) => sel.has(r.path))
  const open = (r: DiscoveredRepo) => { if (!r.initialized) return; setActive(r.path); setView(r.kind === 'bare' ? 'history' : 'changes') }
  const actx = { run: ctx.run, togglePin: ctx.togglePin, pinned, hideRepo: ctx.hideRepo, rescan: ctx.rescan, toast, unhideRepo: ctx.unhideRepo, refreshSummaries }
  const gitApi = { fetch: (p: string) => git.fetch(p), pull: (p: string) => git.pull(p), push: (p: string) => git.push(p), raw: (p: string, c: string) => app.gitRaw(p, c) }

  if (!project) return <Empty icon="dashboard" title="还没有项目">在左侧添加一个项目文件夹，GitLoom 会递归发现其中所有仓库。</Empty>
  const scopeRel = scope && scope !== root ? scope.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').length + 1) : ''
  const running = bulk && !bulk.finished
  const res = bulk?.results ?? {}
  const done = bulk ? Object.values(res).filter((r) => r.state === 'ok' || r.state === 'err' || r.state === 'skip').length : 0
  const bulkSummary = bulk ? summarizeBulkResults(res, { label: '批量同步', finished: !!bulk.finished }) : null
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_H) - 6)
  const endRow = Math.min(shown.length, Math.ceil((scrollTop + viewH) / ROW_H) + 6)

  return (
    <div className="dash">
      <div className="dash-head">
        <div className="dash-title">
          <Icon name="dashboard" size={18} />
          <h2>{scopeRel ? scopeRel.split('/').pop() : project.name}</h2>
          {scopeRel && <span className="crumbs-mini">
            <button className="link" onClick={() => setScope(null)}>{project.name}</button>
            {scopeRel.split('/').filter(Boolean).map((seg, i, arr) => <React.Fragment key={i}><span>/</span><button className="link" onClick={() => setScope(`${root.replace(/[\\/]+$/, '')}/${arr.slice(0, i + 1).join('/')}`)}>{seg}</button></React.Fragment>)}
          </span>}
          <div className="flex1" />
          <div className="side-search dash-search"><Icon name="search" size={13} /><input placeholder="筛选仓库…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="筛选概览" /></div>
          <div className="seg seg-sm">
            <button className={layout === 'table' ? 'on' : ''} onClick={() => setLayout('table')} title="表格"><Icon name="list" size={13} />表格</button>
            <button className={layout === 'cards' ? 'on' : ''} onClick={() => setLayout('cards')} title="卡片"><Icon name="stack" size={13} />卡片</button>
          </div>
          <button className="icon-btn" title="刷新状态" aria-label="刷新状态" onClick={() => refreshSummaries(scoped.filter((r) => r.initialized).map((r) => r.path))}><Icon name="refresh" size={15} /></button>
        </div>
        {todos.length > 0 && (
          <div className="dash-todos" data-testid="dash-todos">
            <div className="dash-todos-head">
              <Icon name="clock" size={14} />
              <b>今日待办</b>
              <span className="muted small">{todos.length} 项需要留意</span>
            </div>
            <div className="dash-todos-strip">
              {todos.map((t) => (
                <button
                  key={`${t.kind}:${t.path}`}
                  type="button"
                  className={`todo-card todo-${t.kind}`}
                  data-testid={`todo-${t.kind}-${base(t.path)}`}
                  title={t.detail}
                  onClick={() => { setActive(t.path); setView(t.view) }}
                >
                  <span className="todo-kind">{t.label}</span>
                  <b className="todo-name">{t.name}</b>
                  <small className="todo-detail">{t.detail}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        {(quick.behind.length > 0 || quick.ahead.length > 0) && (
          <div className="dash-quick" data-testid="dash-quick">
            <span className="muted small">一键同步：</span>
            <button className="btn btn-sm quick-btn" data-testid="quick-pull" disabled={!!running || !quick.behind.length} title={`对 ${quick.behind.length} 个落后于上游的仓库执行 git pull --ff-only（不会产生合并提交；分叉的仓库会给出处理建议）`} onClick={() => start('pull', {}, quick.behind)}>
              <Icon name="pull" size={14} />全部拉取<b>{quick.behind.length}</b><small>个落后</small></button>
            <button className="btn btn-sm quick-btn" data-testid="quick-push" disabled={!!running || !quick.ahead.length} title={`对 ${quick.ahead.length} 个领先于上游的仓库执行 git push`} onClick={() => start('push', {}, quick.ahead)}>
              <Icon name="push" size={14} />推送所有领先的<b>{quick.ahead.length}</b></button>
            {quick.noUpstream > 0 && <span className="muted small" title="这些分支还没有关联远程分支，推送时需要设置上游（批量推送对话框里可勾选）">另有 {quick.noUpstream} 个分支没有上游</span>}
          </div>
        )}
        <div className="stat-chips">
          {FILTERS.map((f) => (
            <button key={f.id} className={`stat-chip sc-${f.id} ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)} disabled={f.id !== 'all' && !counts[f.id]}>
              <b>{counts[f.id]}</b><span>{f.label}</span>
            </button>
          ))}
        </div>
        <div className="bulk-bar">
          <label className="chk" title="全选当前列表"><input type="checkbox" checked={allSel} ref={(el) => { if (el) el.indeterminate = sel.size > 0 && !allSel }} onChange={() => setSel(allSel ? new Set() : new Set(actionable.map((r) => r.path)))} aria-label="全选" /></label>
          <span className="bulk-target">{sel.size ? <>已选 <b>{targets.length}</b> 个</> : <>全部 <b>{actionable.length}</b> 个</>}</span>
          <span className="top-sep" />
          <button className="btn btn-sm" disabled={!!running || !targets.length} onClick={() => ask('fetch')}><Icon name="fetch" size={14} />抓取</button>
          <button className="btn btn-sm" disabled={!!running || !targets.length} onClick={() => ask('pull')} title="git pull --ff-only（不会产生合并提交）"><Icon name="pull" size={14} />拉取<small>仅快进</small></button>
          <button className="btn btn-sm" disabled={!!running || !targets.length} onClick={() => ask('push')}><Icon name="push" size={14} />推送</button>
          <button className="btn btn-sm" disabled={!!running || !targets.length} onClick={() => ask('switch')}><Icon name="branch" size={14} />切换分支</button>
          <button className="btn btn-sm" disabled={!!running || !targets.length} onClick={() => ask('branch')}><Icon name="plus" size={14} />新建分支</button>
          <button className="btn btn-sm" disabled={!!running || !targets.length} onClick={() => ask('stash')}><Icon name="stash" size={14} />储藏</button>
          <button className="btn btn-sm" disabled={!!running || !targets.length} onClick={() => ask('command')}><Icon name="terminal" size={14} />运行命令…</button>
          {sel.size > 0 && <button className="btn btn-sm btn-ghost" onClick={() => setSel(new Set())}>清除选择</button>}
        </div>
      </div>

      {!shown.length ? (
        <Empty icon={filter === 'all' && !q ? 'scan' : 'check'} title={filter === 'all' && !q ? '这里还没有仓库' : '没有符合条件的仓库'}
          actions={filter !== 'all' || q ? <button className="btn btn-sm" onClick={() => { setFilter('all'); setQ('') }}>清除筛选</button> : <button className="btn btn-sm btn-primary" onClick={() => ctx.rescan(scope ?? undefined)}><Icon name="scan" size={14} />扫描此文件夹</button>}>
          {filter === 'all' && !q ? '可以重新扫描，或调整设置中的扫描深度与忽略列表。' : '试试其它筛选条件。'}
        </Empty>
      ) : layout === 'table' ? (
        <div className="dash-table">
          <div className="dt-head">
            <span className="c-chk" />
            <span className="c-name">仓库</span><span className="c-branch">分支</span><span className="c-status">状态</span><span className="c-health" title="体检：工作区状态评分 + 最近一次体检报告最高严重级别色点；点击进入质量把关">体检</span><span className="c-last">最近提交</span>
            <span className="c-res">{bulk ? OP_LABEL[bulk.op] : '结果'}</span><span className="c-act" />
          </div>
          <div className="dt-body" ref={listRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            <div style={{ height: shown.length * ROW_H, position: 'relative' }}>
              {shown.slice(startRow, endRow).map((r, k) => {
                const i = startRow + k
                const s = summaries[r.path]
                const br = res[r.path]
                return (
                  <div key={r.path} className={`dt-row ${sel.has(r.path) ? 'sel' : ''} ${!r.initialized ? 'uninit' : ''}`} style={{ top: i * ROW_H, height: ROW_H }}
                    onClick={(e) => toggleSel(i, e)} onDoubleClick={() => open(r)} onContextMenu={(e) => menu(e, repoMenu(r, root, actx, gitApi))} title={repoTitle(r, s)}>
                    <span className="c-chk"><input type="checkbox" checked={sel.has(r.path)} disabled={!r.initialized} onChange={() => undefined} aria-label={`选择 ${base(r.path)}`} /></span>
                    <span className="c-name"><RepoKindIcon repo={r} /><span className="dn"><b>{base(r.path)}</b><small>{r.outside ? `项目外 · ${r.path}` : r.rel || '（项目根）'}</small></span>{r.kind !== 'normal' && <span className={`kind-tag k-${r.kind}`}>{KIND_LABEL[r.kind]}</span>}</span>
                    <span className="c-branch">{s?.branch ? <><Icon name="branch" size={12} />{s.branch}</> : <span className="muted">{r.initialized ? '…' : '—'}</span>}{s?.upstream && <small className="muted"> → {s.upstream}</small>}</span>
                    <span className="c-status">{isOverviewClean(s, r)
                      ? <><span className="clean"><Icon name="check" size={12} />干净</span>{hasNoUpstream(s) && <span className="bdg bdg-muted bdg-noup" title="没有上游分支：这个分支还没推送过，或没有关联远程分支">无上游</span>}</>
                      : <StatusBadges sum={s} repo={r} />}</span>
                    <HealthCell s={s} path={r.path} />
                    <span className="c-last">{s?.lastCommit ? <><span className="lc-sub">{s.lastCommit.subject}</span><small>{relTime(s.lastCommit.date)}{shortSha(s.lastCommit.sha) ? ` · ${shortSha(s.lastCommit.sha)}` : ''} · {s.lastCommit.author}</small></> : <span className="muted">—</span>}</span>
                    <span className={`c-res r-${br?.state ?? 'none'}`} title={br?.message}>
                      {br?.state === 'running' && <><Spinner size={11} />执行中</>}
                      {br?.state === 'queued' && <><Icon name="clock" size={12} />排队</>}
                      {br?.state === 'ok' && <><Icon name="ok" size={13} />{br.message ?? '完成'}</>}
                      {br?.state === 'skip' && <><Icon name="minus" size={13} />{br.message}</>}
                      {br?.state === 'err' && <><Icon name="error" size={13} />{br.message}</>}
                    </span>
                    <span className="c-act">
                      <button className="icon-btn xs" title="打开仓库" aria-label="打开仓库" disabled={!r.initialized} onClick={(e) => { e.stopPropagation(); open(r) }}><Icon name="external" size={13} /></button>
                      <button className="icon-btn xs" title="更多" aria-label="更多" onClick={(e) => { e.stopPropagation(); menu(e, repoMenu(r, root, actx, gitApi)) }}><Icon name="more" size={13} /></button>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="dash-cards" ref={listRef}>
          {shown.map((r, i) => {
            const s = summaries[r.path]
            const br = res[r.path]
            const accent = cardAccent(s, r)
            const up = shortUpstream(s?.upstream)
            const sha = shortSha(s?.lastCommit?.sha)
            const kindChip = r.outside ? '项目外' : (r.kind !== 'normal' ? KIND_LABEL[r.kind] : null)
            return (
              <div key={r.path}
                className={`dcard is-${accent} ${sel.has(r.path) ? 'sel' : ''} ${!r.initialized ? 'uninit' : ''}`}
                onClick={(e) => toggleSel(i, e)} onDoubleClick={() => open(r)}
                onContextMenu={(e) => menu(e, repoMenu(r, root, actx, gitApi))}
                title={repoTitle(r, s)} data-testid="dcard">
                <div className="dc-head">
                  <span className="dc-chk">
                    <input type="checkbox" checked={sel.has(r.path)} disabled={!r.initialized} onChange={() => undefined} tabIndex={-1} aria-label={`选择 ${base(r.path)}`} />
                  </span>
                  <RepoKindIcon repo={r} size={16} />
                  <b className="dc-name">{base(r.path)}</b>
                  {kindChip && <span className={`kind-tag k-${r.outside ? 'outside' : r.kind}`}>{kindChip}</span>}
                  <div className="flex1" />
                  <span className="dc-health"><HealthCell s={s} path={r.path} /></span>
                  {r.initialized && (
                    <span className="dc-qa" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="icon-btn xs" title="打开仓库" aria-label="打开仓库" onClick={() => open(r)}><Icon name="external" size={13} /></button>
                      {r.kind !== 'bare' && (
                        <button type="button" className="icon-btn xs" title="抓取" aria-label="抓取" disabled={!!running}
                          onClick={() => { void gitApi.fetch(r.path).then(() => void refreshSummaries([r.path])) }}>
                          <Icon name="fetch" size={13} />
                        </button>
                      )}
                    </span>
                  )}
                </div>
                <div className="dc-status">
                  {isOverviewClean(s, r)
                    ? <><span className="clean"><Icon name="check" size={12} />干净</span>{hasNoUpstream(s) && <span className="bdg bdg-muted bdg-noup" title="没有上游分支：这个分支还没推送过，或没有关联远程分支">无上游</span>}</>
                    : <StatusBadges sum={s} repo={r} />}
                </div>
                <div className="dc-sync">
                  <span className="dc-branch"><Icon name="branch" size={12} />{s?.branch ?? (r.initialized ? '…' : '—')}</span>
                  {(s?.ahead ?? 0) > 0 && <span className="dc-ab" title={`领先 ${s!.ahead}（待推送）`}>↑{s!.ahead}</span>}
                  {(s?.behind ?? 0) > 0 && <span className="dc-ab" title={`落后 ${s!.behind}（待拉取）`}>↓{s!.behind}</span>}
                  {up && <span className="dc-up" title={`上游：${up}`}>→ {up}</span>}
                </div>
                <div className="dc-commit">
                  {s?.lastCommit ? (
                    <>
                      <span className="dc-sub">{s.lastCommit.subject}</span>
                      <span className="dc-ctime">{relTime(s.lastCommit.date)}{sha ? <> · <code>{sha}</code></> : null}</span>
                    </>
                  ) : <span className="muted">—</span>}
                </div>
                <div className="dc-foot">
                  <span className="dc-path">{r.outside ? r.path : (r.rel || '（项目根）')}</span>
                  {br && <span className={`dc-res r-${br.state}`}>{br.state === 'running' ? <Spinner size={11} /> : null}{br.message ?? br.state}</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {bulk && bulkSummary && (
        <div className={`bulk-log tone-${bulkSummary.tone}`} style={{ height: logH }} data-testid="bulk-sync-summary">
          <Resizer vertical onResize={(d) => setLogH((h) => Math.max(120, Math.min(560, h - d)))} />
          <div className="bl-head">
            {running ? <Spinner size={12} /> : <Icon name={bulkSummary.tone === 'err' ? 'error' : bulkSummary.tone === 'ok' ? 'ok' : 'warn'} size={14} />}
            <b data-testid="bulk-sync-title">{running ? bulk.label : '批量同步结果'}</b>{!running && <span className="muted small"> · {bulk.label}</span>}
            <span className="muted" data-testid="bulk-sync-counts">{done}/{bulk.repos.length} · {bulkSummary.countsLine}{bulk.finished ? ` · 用时 ${((bulk.finished - bulk.started) / 1000).toFixed(1)}s` : ''}</span>
            <div className="progress"><i style={{ width: `${(done / Math.max(1, bulk.repos.length)) * 100}%` }} /></div>
            <label className="chk"><input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />仅显示失败</label>
            {running && <button className="btn btn-sm btn-ghost-danger" onClick={() => { bulk.signal.cancelled = true; toast('info', '正在取消剩余任务…') }}><Icon name="stop" size={13} />取消剩余</button>}
            {!running && <button className="icon-btn xs" title="关闭结果" aria-label="关闭结果" data-testid="bulk-sync-close" onClick={() => setBulk(null)}><Icon name="x" size={13} /></button>}
          </div>
          {!running && (
            <div className="bl-summary-chips" data-testid="bulk-sync-chips">
              <span className="bchip ok">成功 {bulkSummary.ok}</span>
              <span className="bchip err">失败 {bulkSummary.err}</span>
              <span className="bchip skip">跳过 {bulkSummary.skip}</span>
            </div>
          )}
          <div className="bl-body">
            {bulk.repos.filter((p) => !onlyFailed || res[p]?.state === 'err').map((p) => {
              const r = res[p]
              const rel = projectRepos.find((x) => x.path === p)?.rel || base(p)
              return (
                <div key={p} className={`bl-line r-${r?.state ?? 'queued'}`} data-testid={`bulk-line-${base(p)}`}>
                  <span className="bl-ic">{r?.state === 'running' ? <Spinner size={10} /> : <Icon name={r?.state === 'ok' ? 'ok' : r?.state === 'err' ? 'error' : r?.state === 'skip' ? 'minus' : 'clock'} size={12} />}</span>
                  <span className="bl-repo">{rel}</span>
                  <span className="bl-msg" title={r?.detail ?? r?.message}>{r?.message ?? (r?.state === 'running' ? '执行中…' : '排队中')}</span>
                  {r?.state === 'err' && <button className="btn btn-xs" title="打开这个仓库处理" onClick={() => { ctx.setActive(p); ctx.setView('changes') }}>去处理</button>}
                  {r?.ms !== undefined && <span className="bl-ms">{r.ms}ms</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function HealthCell({ s, path }: { s: import('@shared/types').RepoSummary | undefined; path: string }) {
  const { setActive, setView } = useApp()
  const h = repoHealth(s)
  const [sev, setSev] = useState<FindingSeverity | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    setSev(undefined)
    void health.latest(path).then((r: HealthReport | null) => {
      if (!alive) return
      if (!r) { setSev(null); return }
      setSev(highestSeverity(r.findings.filter((f) => f.status === 'open')))
    }).catch(() => { if (alive) setSev(null) })
    return () => { alive = false }
  }, [path])
  const tip = [
    healthTip(h),
    sev ? `最近体检最高：${SEVERITY_LABELS[sev]}（点进质量把关看报告）` : sev === null ? '尚无体检报告（点进质量把关可一键体检）' : ''
  ].filter(Boolean).join('\n')
  const dot = sev === 'critical' || sev === 'high' ? 'bad' : sev === 'medium' ? 'warn' : sev === 'low' || sev === 'info' ? 'good' : h.grade
  const open = (e: React.MouseEvent) => {
    e.stopPropagation()
    setActive(path)
    setView('quality')
  }
  return (
    <button type="button" className={`c-health hl-${dot} health-cell-btn`} title={tip} data-testid="health" onClick={open}>
      <span className={`health-dot hd-${sev ?? 'na'}`} aria-hidden />
      {h.grade === 'na' ? <span className="muted">—</span> : <><b>{h.score}</b><small>{h.label}</small></>}
    </button>
  )
}
