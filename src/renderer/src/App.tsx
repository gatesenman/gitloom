import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { MenuProvider, UIProvider, useDialog, useMenu, Spinner, Kbd, MOD, anchorOf, type MenuItem } from './components/ui'
import { Icon } from './components/Icon'
import { AppProvider, useApp, type View } from './state'
import { errMsg, git } from './api'
import logo from './assets/logo.svg'
import ChangesView from './views/ChangesView'
import HistoryView from './views/HistoryView'
import BranchesView from './views/BranchesView'
import TagsReleaseView from './views/TagsReleaseView'
import WorktreesView from './views/WorktreesView'
import StashView from './views/StashView'
import AIView from './views/AIView'
import SettingsView from './views/SettingsView'
import RebaseView from './views/RebaseView'
import BisectView from './views/BisectView'
import ToolsView from './views/ToolsView'
import SubmodulesView from './views/SubmodulesView'
import ForgeView from './views/ForgeView'
import Dashboard from './views/Dashboard'
import CrossChanges from './views/CrossChanges'
import WorkspaceReposView from './views/WorkspaceReposView'
import CommandLog from './components/CommandLog'
import Welcome from './views/Welcome'
import { ProjectSidebar } from './components/ProjectSidebar'
import { CommandPalette } from './components/CommandPalette'
import { RepoKindIcon, StatusBadges } from './components/RepoBits'
import { AdvancedTabs, ViewIntro } from './components/NavBits'
import { PRIMARY, isAdvanced, MODULES, SCOPES, moduleOf, scopeOf, viewTabStrip, isWorkspaceView, crumbViewLabel } from './lib/nav'
/** Hubs are route-level lazy: opening 自动化 must not pull Knowledge/Quality/xyflow/health. */
const KnowledgeView = lazy(() => import('./views/ModuleHubs').then((m) => ({ default: m.KnowledgeView })))
const QualityView = lazy(() => import('./views/ModuleHubs').then((m) => ({ default: m.QualityView })))
const AutomationView = lazy(() => import('./views/AutomationHub'))
const SummaryView = lazy(() => import('./views/UnderstandViews').then((m) => ({ default: m.SummaryView })))
const ArchitectureView = lazy(() => import('./views/UnderstandViews').then((m) => ({ default: m.ArchitectureView })))
const VizView = lazy(() => import('./views/VizView'))

function ViewFallback({ label }: { label: string }) {
  return (
    <div className="us-loading" data-testid="view-loading" role="status" aria-live="polite">
      <Spinner size={14} /><span>加载{label}…</span>
    </div>
  )
}

/** Keep hub modules mounted once visited so leaving 质量把关 does not sync-tear a huge tree. */
function KeepHub({ active, label, children }: { active: boolean; label: string; children: React.ReactNode }) {
  const [seen, setSeen] = useState(active)
  useEffect(() => { if (active) setSeen(true) }, [active])
  if (!seen) return null
  return (
    <div hidden={!active} style={{ display: active ? undefined : 'none' }} aria-hidden={!active} data-hub-keep={label}>
      <Suspense fallback={<ViewFallback label={label} />}>{children}</Suspense>
    </div>
  )
}

/** Everyday repo tabs (Mod+1..3); advanced + 储藏/工作树 are flat peers via AdvancedTabs. */
export const NAV = PRIMARY
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const emit = (name: string, detail: string) => window.dispatchEvent(new CustomEvent(name, { detail }))

export default function Root() {
  return (
    <UIProvider>
      <MenuProvider>
        <AppProvider>
          <Shell />
        </AppProvider>
      </MenuProvider>
    </UIProvider>
  )
}

/** a render error in one view used to blank the whole window (there was no boundary at all); now it is contained and retryable */
class ViewBoundary extends React.Component<{ children: React.ReactNode; resetKey?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('[view crashed]', error, info.componentStack) }
  componentDidUpdate(prev: Readonly<{ resetKey?: string }>) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="view-crash" role="alert" data-testid="view-crash">
        <Icon name="error" size={28} />
        <b>这个页面出错了</b>
        <p>其他页面和仓库不受影响。可以重试；如果反复出现，请把下面的信息反馈给我们。</p>
        <code>{String(this.state.error.message).slice(0, 300)}</code>
        <button className="btn btn-primary" onClick={() => this.setState({ error: null })}><Icon name="refresh" size={14} />重试</button>
      </div>
    )
  }
}

function Shell() {
  const { theme, settings, saveSettings, active, view, setView, status, project, scan, setSidebarMode, setScope, addProject } = useApp()
  const [showLog, setShowLog] = useState(false)
  const [palette, setPalette] = useState<null | 'commands' | 'repos'>(null)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('gitloom.sidebar') === 'collapsed')
  const toggleSidebar = useCallback(() => setCollapsed((c) => { localStorage.setItem('gitloom.sidebar', c ? 'open' : 'collapsed'); return !c }), [])

  /** 0.6.14: idle-prefetch AutomationHub so first open is warm; KeepHub / other hub lazy untouched. */
  useEffect(() => {
    if (!settings) return
    let cancelled = false
    let ricId: number | undefined
    let timeoutId: number | undefined
    const kick = () => { if (!cancelled) void import('./views/AutomationHub') }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    if (typeof w.requestIdleCallback === 'function') {
      ricId = w.requestIdleCallback(kick, { timeout: 4000 })
    } else {
      timeoutId = window.setTimeout(kick, 1200)
    }
    return () => {
      cancelled = true
      if (ricId != null) w.cancelIdleCallback?.(ricId)
      if (timeoutId != null) window.clearTimeout(timeoutId)
    }
  }, [settings])
  useEffect(() => { const h = () => setShowLog(true); window.addEventListener('gitloom:showlog', h); return () => window.removeEventListener('gitloom:showlog', h) }, [])
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => { document.documentElement.dataset.density = settings?.density ?? 'comfortable' }, [settings?.density])
  useEffect(() => {
    if (settings) document.documentElement.style.setProperty('--code-size', `${settings.fontSize}px`)
  }, [settings])
  useEffect(() => window.api.onNavigate(({ view: v, theme: t, select, tab, density }: { view: string; theme?: string; select?: string; tab?: string; density?: string }) => {
    if ((t || density) && settings) void saveSettings({ ...settings, ...(t ? { theme: t as 'dark' | 'light' } : {}), ...(density ? { density: density as 'compact' | 'comfortable' } : {}) })
    if (select) sessionStorage.setItem('gitloom.select', select); else sessionStorage.removeItem('gitloom.select')
    if (tab) sessionStorage.setItem('gitloom.tab', tab); else sessionStorage.removeItem('gitloom.tab')
    if (v === 'palette') { setPalette('commands'); return }
    if (v === 'quickopen') { setPalette('repos'); if (select) setTimeout(() => emit('gitloom:palette', select), 120); return }
    if (v === 'collapse') { setCollapsed(true); return }
    if (v.startsWith('mode-')) { setSidebarMode(v.slice(5) as 'tree' | 'flat' | 'status'); if (select) setTimeout(() => emit('gitloom:sidebar', `filter:${select}`), 50); return }
    if (v === 'scan' && select) { void addProject(select); return }
    if (v === 'filter') { emit('gitloom:sidebar', `filter:${select ?? ''}`); return }
    if (v === 'dashboard' || v === 'allchanges' || v === 'repos') { setScope(select ?? null); sessionStorage.removeItem('gitloom.select') }
    if (tab?.startsWith('bulk-')) { sessionStorage.removeItem('gitloom.tab'); setTimeout(() => emit('gitloom:dashboard', tab === 'bulk-fetch' ? 'fetch-all' : 'fetch-all-slow'), 500) }
    setPalette(null)
    setView(v as View)
  }), [settings, saveSettings, setView, setSidebarMode, setScope, addProject])
  // keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'p' && !e.shiftKey) { e.preventDefault(); setPalette((p) => (p === 'repos' ? null : 'repos')); return }
      if (k === 'k' || (k === 'p' && e.shiftKey)) { e.preventDefault(); setPalette((p) => (p === 'commands' ? null : 'commands')); return }
      if (k === 'b') { e.preventDefault(); toggleSidebar(); return }
      if (k === 'e' && e.shiftKey) { e.preventDefault(); if (collapsed) toggleSidebar(); setTimeout(() => emit('gitloom:sidebar', 'focus-tree'), 30); return }
      if (k === 'f' && e.shiftKey) { e.preventDefault(); if (collapsed) toggleSidebar(); setTimeout(() => emit('gitloom:sidebar', 'focus-filter'), 30); return }
      if (e.key === '0') { e.preventDefault(); setScope(null); setView('dashboard'); return }
      const idx = Number(e.key)
      // Mod+1..N: everyday tabs only while in 日常 Git (or already on a daily view)
      if (idx >= 1 && idx <= NAV.length && active && viewTabStrip(view) === 'daily') { e.preventDefault(); setView(NAV[idx - 1].id) }
      if (e.key === ',') { e.preventDefault(); setView('settings') }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [setView, toggleSidebar, collapsed, active, setScope, view])

  if (!settings) return <div className="boot"><img src={logo} width={64} /><Spinner size={18} /></div>
  const scanningEmpty = !!scan && !!project && project.repos.length === 0
  const wsView = isWorkspaceView(view)
  const autoView = view === 'automation' || view === 'hooks' || view === 'aitasks'
  const hubView = view === 'knowledge' || view === 'quality' || view === 'architecture' || view === 'architecture-graph'
  return (
    <div className="app">
      <ProjectSidebar collapsed={collapsed} onToggle={toggleSidebar} />
      <div className="main">
        <Topbar onPalette={() => setPalette('commands')} onQuickOpen={() => setPalette('repos')} />
        {project && !scanningEmpty && <ModuleBar />}
        {project && view !== 'settings' && !hubView && !scanningEmpty && <ViewTabs />}
        {status?.operation && !wsView && !hubView && !autoView && view !== 'settings' && <OperationBanner />}
        <div className="content">
          {/* key by repo only — remounting on every view switch forced a sync tear-down of Quality/Knowledge */}
          <ViewBoundary key={active ?? 'workspace'} resetKey={view}>
          {view === 'settings' ? <SettingsPage /> : !project || scanningEmpty ? (
            autoView ? (
              <KeepHub active label="自动化"><AutomationView /></KeepHub>
            ) : <Welcome />
          ) : (
            <>
              <KeepHub active={autoView} label="自动化"><AutomationView /></KeepHub>
              <KeepHub active={view === 'knowledge'} label="架构与知识"><KnowledgeView /></KeepHub>
              <KeepHub active={view === 'quality'} label="质量把关"><QualityView /></KeepHub>
              {!autoView && view !== 'knowledge' && view !== 'quality' && (
                view === 'allchanges' ? <CrossChanges /> : view === 'repos' ? <WorkspaceReposView /> : view === 'dashboard' || !active ? <Dashboard /> : (
                  <>
                    {view === 'changes' && <ChangesView />}
                    {view === 'history' && <HistoryView mode="history" />}
                    {view === 'graph' && <HistoryView mode="graph" />}
                    {(view === 'branches' || view === 'tags' || view === 'worktrees' || view === 'stash') && (
                      <div className="view-stack">
                        {view !== 'branches' && view !== 'tags' && <ViewIntro key={view} id={view} />}
                        <div className="view-body">
                          {view === 'branches' && <BranchesView />}
                          {view === 'tags' && <TagsReleaseView />}
                          {view === 'worktrees' && <WorktreesView />}
                          {view === 'stash' && <StashView />}
                        </div>
                      </div>
                    )}
                    {(isAdvanced(view) || view === 'blame') && (
                      <div className="view-stack">
                        <ViewIntro key={view} id={view === 'blame' ? 'tools' : view} />
                        <div className="view-body">
                          {view === 'rebase' && <RebaseView />}
                          {view === 'bisect' && <BisectView />}
                          {view === 'submodules' && <SubmodulesView />}
                          {(view === 'tools' || view === 'blame') && <ToolsView />}
                          {view === 'forge' && <ForgeView />}
                          {view === 'ai' && <AIView />}
                        </div>
                      </div>
                    )}
                    {view === 'summary' && <Suspense fallback={<ViewFallback label="改动摘要" />}><SummaryView /></Suspense>}
                    {(view === 'viz' || view === 'architecture-graph') && <Suspense fallback={<ViewFallback label="可视化" />}><VizView /></Suspense>}
                    {view === 'architecture' && <Suspense fallback={<ViewFallback label="架构" />}><ArchitectureView /></Suspense>}
                  </>
                )
              )}
            </>
          )}
          </ViewBoundary>
        </div>
        <StatusBar onToggleLog={() => setShowLog((s) => !s)} />
        {showLog && <CommandLog onClose={() => setShowLog(false)} />}
      </div>
      {palette && <CommandPalette mode={palette} onMode={setPalette} onClose={() => setPalette(null)} onToggleSidebar={toggleSidebar} onToggleLog={() => setShowLog((s) => !s)} />}
    </div>
  )
}

/** 0.6.0 top level: six modules + scope switch (当前仓库 / 整个项目 / 仓库组). */
function ModuleBar() {
  const { view, setView, active, scope, setScope, project, projectRepos } = useApp()
  const menu = useMenu()
  const cur = moduleOf(view)
  const sc = scopeOf(view, scope)
  const root = (project?.root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const groups = [...new Set(projectRepos.filter((r) => r.initialized && !r.outside).map((r) => r.path.replace(/\\/g, '/')).filter((p) => p.startsWith(root + '/')).map((p) => p.slice(root.length + 1).split('/')).filter((s) => s.length > 1).map((s) => s[0]))].sort()
  const groupTip = SCOPES.find((s) => s.id === 'group')!.tip
  const pickScope = (id: string, el: Element) => {
    if (id === 'repo') { if (active) setView(!cur || cur.id === 'workspace' ? 'changes' : view); return }
    if (id === 'project') { setScope(null); setView('dashboard'); return }
    // Explanation lives in the picker (and the inline scope hint) — not a right-edge tip rail.
    menu(anchorOf(el), groups.length ? [
      { label: '选择仓库组（文件夹）', header: true },
      { label: groupTip, note: true },
      ...groups.map((g) => ({ label: g, icon: 'folder', checked: scope === `${root}/${g}`, sub: `${projectRepos.filter((r) => r.path.replace(/\\/g, '/').startsWith(`${root}/${g}/`)).length} 个仓库`, onClick: () => { setView('dashboard'); setScope(`${root}/${g}`) } } as MenuItem))
    ] : [
      { label: '选择仓库组（文件夹）', header: true },
      { label: groupTip, note: true },
      { label: '项目里没有包含多个仓库的子文件夹', disabled: true }
    ])
  }
  const activeScope = SCOPES.find((s) => s.id === sc)!
  const scopeTitle = (s: (typeof SCOPES)[number]) => {
    // Keep titles short so hover tips never wrap into a full-height right column.
    if (s.id === 'group' && sc === 'group' && scope) return `当前仓库组：${scope.slice(root.length + 1)}`
    return s.tip
  }
  return (
    <div className="modbar" role="tablist" aria-label="功能模块">
      {MODULES.map((m) => {
        const on = cur?.id === m.id
        const off = m.needsRepo && !active
        return (
          <button key={m.id} role="tab" aria-selected={on} data-module={m.id} className={`mod-tab ${on ? 'active' : ''}`} disabled={off}
            onClick={() => setView(m.home)}
            title={`${m.label}：${m.tip}${off ? '\n（先在左侧选择一个仓库）' : ''}`}>
            <Icon name={m.icon} size={14} /><span>{m.label}</span>
          </button>
        )
      })}
      <div className="flex1" />
      <div className="scope-ctrl">
        <span className="scope-hint" data-testid="scope-hint" title={activeScope.tip}>{activeScope.tip}</span>
        <div className="seg scope-seg" role="group" aria-label="范围">
          {SCOPES.map((s) => (
            <button key={s.id} data-scope={s.id} className={sc === s.id ? 'on' : ''} disabled={s.id === 'repo' && !active} aria-pressed={sc === s.id}
              onClick={(e) => pickScope(s.id, e.currentTarget)} title={scopeTitle(s)} aria-label={`${s.label}：${s.tip}`}>
              {s.label}{s.id === 'group' && sc === 'group' && scope ? ` · ${scope.slice(root.length + 1).split('/').pop()}` : ''}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Secondary tabs: workspace / daily / understand / automation — never mixed. Knowledge/quality hubs hide this. */
function ViewTabs() {
  const { view, setView, active, status, setScope, project, summaries, scope } = useApp()
  const strip = viewTabStrip(view)
  if (!strip) return null
  const multi = (project?.repos.length ?? 0) > 1 || view === 'allchanges'
  const dirty = (project?.repos ?? []).filter((r) => (summaries[r.path]?.changes ?? 0) > 0).length
  const n = status ? status.staged.length + status.unstaged.length + status.conflicted.length : 0
  if (strip === 'workspace') {
    return (
      <div className="viewtabs" role="tablist" data-strip="workspace" aria-label="工作区">
        <button role="tab" data-view="dashboard" aria-selected={view === 'dashboard'} className={`ws-tab ${view === 'dashboard' ? 'active' : ''}`} onClick={() => setView('dashboard')} title={`概览：项目内所有仓库的状态一览（${MOD}+0）`}><Icon name="dashboard" size={14} /><span>概览</span>{scope && <em className="scope-dot" title="已限定到文件夹" />}</button>
        {multi && <button role="tab" data-view="allchanges" aria-selected={view === 'allchanges'} className={`ws-tab ${view === 'allchanges' ? 'active' : ''}`} onClick={() => { setView('allchanges'); setScope(scope) }} title="跨仓库变更：把项目中所有仓库的未提交改动集中查看、批量提交"><Icon name="layers" size={14} /><span>跨仓变更</span>{dirty > 0 && <em className="nav-count">{dirty}</em>}</button>}
        <button role="tab" data-view="repos" aria-selected={view === 'repos'} className={`ws-tab ${view === 'repos' ? 'active' : ''}`} onClick={() => setView('repos')} title="仓库与扫描：已发现仓库列表、固定/隐藏、重新扫描（不含网络操作）"><Icon name="scan" size={14} /><span>仓库与扫描</span></button>
      </div>
    )
  }
  if (strip === 'understand') {
    return (
      <div className="viewtabs" role="tablist" data-strip="understand" aria-label="看懂改动" data-testid="understand-strip">
        <button role="tab" data-view="summary" aria-selected={view === 'summary'} className={`ws-tab ${view === 'summary' ? 'active' : ''}`} onClick={() => setView('summary')} title="改动摘要：全局摘要 → 影响模块 → 逐文件（只服务某次 diff）" data-testid="us-tab-summary"><Icon name="viz" size={14} /><span>改动摘要</span></button>
        <button role="tab" data-view="viz" aria-selected={view === 'viz'} className={`ws-tab ${view === 'viz' ? 'active' : ''}`} onClick={() => setView('viz')} disabled={!active} title="可视化：前后对比图、代码地图、阅读路线等（同一菜单内的工具子页签）" data-testid="us-tab-viz"><Icon name="treemap" size={14} /><span>可视化</span></button>
      </div>
    )
  }
  if (strip === 'automation') {
    return (
      <div className="viewtabs" role="tablist" data-strip="automation" aria-label="自动化" data-testid="automation-strip">
        <button role="tab" data-view="automation" aria-selected={view === 'automation'} className={`ws-tab ${view === 'automation' ? 'active' : ''}`} onClick={() => setView('automation')} title="事件触发：拉取/推送/抓取/提交成功后自动跑体检、Wiki 等" data-testid="auto-tab-events"><Icon name="zap" size={14} /><span>事件触发</span></button>
        <button role="tab" data-view="hooks" aria-selected={view === 'hooks'} className={`ws-tab ${view === 'hooks' ? 'active' : ''}`} onClick={() => setView('hooks')} title={active ? 'Git 钩子与模板库（当前仓库）' : 'Git 钩子与模板库 — 未选仓库时仍可打开，面板内提示如何选择'} data-testid="auto-tab-hooks"><Icon name="hook" size={14} /><span>钩子</span></button>
        <button role="tab" data-view="aitasks" aria-selected={view === 'aitasks'} className={`ws-tab ${view === 'aitasks' ? 'active' : ''}`} onClick={() => setView('aitasks')} title="AI 定时任务：模板 + AI 创建，本机按时间跑只读分析" data-testid="auto-tab-tasks"><Icon name="clock" size={14} /><span>定时任务</span></button>
      </div>
    )
  }
  return (
    <div className="viewtabs" role="tablist" data-strip="daily" aria-label="日常 Git">
      {NAV.map((t, i) => {
        const on = t.match.includes(view)
        return (
          <button key={t.id} role="tab" data-view={t.id} aria-selected={on} className={`nav-item ${on ? 'active' : ''}`} onClick={() => setView(t.id)} disabled={!active} title={`${t.label}：${t.tip}（${MOD}+${i + 1}）`}>
            <Icon name={t.icon} size={14} /><span>{t.label}</span>
            {t.id === 'changes' && n > 0 && <em className="nav-count">{n}</em>}
          </button>
        )
      })}
      <AdvancedTabs />
    </div>
  )
}

function Topbar({ onPalette, onQuickOpen }: { onPalette: () => void; onQuickOpen: () => void }) {
  const { active, status, run, busy, view } = useApp()
  const menu = useMenu()
  const dialog = useDialog()
  const push = async () => {
    if (!active) return
    if (!status?.upstream) {
      const r = await dialog({ title: '发布分支', message: `分支 ${status?.branch} 还没有上游分支，将推送并设置上游（git push -u）。`, okText: '发布' })
      if (r) await run('推送', () => git.push(active, { setUpstream: true }), '已发布分支')
      return
    }
    await run('推送', () => git.push(active), '推送完成')
  }
  const repoView = active && !isWorkspaceView(view) && view !== 'settings' && view !== 'hooks' && view !== 'knowledge' && view !== 'quality' && view !== 'automation'
  const syncBusy = !!busy && /^(抓取|拉取|推送|变基拉取)$/.test(busy)
  return (
    <header className="topbar" onDoubleClick={(e) => { if (e.target === e.currentTarget) void window.api.win?.toggleMaximize() }}>
      <Breadcrumb onQuickOpen={onQuickOpen} />
      <div className="flex1" onDoubleClick={() => void window.api.win?.toggleMaximize()} />
      {busy && <span className="busy"><Spinner size={12} /> {busy}…</span>}
      {repoView && (
        <div className="btn-group sync-group" role="group" aria-label="同步" aria-busy={syncBusy}>
          <button className="btn btn-sm" disabled={syncBusy} onClick={() => run('抓取', () => git.fetch(active), '抓取完成')} title="抓取：从远程下载最新提交，不改动本地分支（git fetch --all --prune）"><Icon name="fetch" size={14} /><span className="lbl">抓取</span></button>
          <button className="btn btn-sm" disabled={syncBusy} onClick={() => run('拉取', () => git.pull(active), '拉取完成')}
            onContextMenu={(e) => menu(e, [
              { label: '拉取（合并）', icon: 'merge', onClick: () => run('拉取', () => git.pull(active, false), '拉取完成') },
              { label: '拉取（变基 --rebase）', icon: 'branch', onClick: () => run('拉取', () => git.pull(active, true), '拉取完成') },
              { label: '拉取（仅快进 --ff-only）', icon: 'pull', onClick: () => run('拉取', () => git.pull(active, false, true), '拉取完成') }
            ])} title={`拉取：抓取并合并上游的新提交${status?.behind ? `（落后 ${status.behind}）` : ''}（git pull，右键选择变基 / 仅快进）`}>
            <Icon name="pull" size={14} /><span className="lbl">拉取</span>{!!status?.behind && <em className="count">{status.behind}</em>}
          </button>
          <button className="btn btn-sm" disabled={syncBusy} onClick={push}
            onContextMenu={(e) => menu(e, [
              { label: '推送', icon: 'push', onClick: push },
              { label: '推送所有标签', icon: 'tag', onClick: () => run('推送标签', () => git.push(active, { tags: true }), '标签已推送') },
              { sep: true },
              { label: '强制推送（--force-with-lease）', icon: 'warn', danger: true, onClick: async () => { if (await dialog({ title: '强制推送', message: '将使用 --force-with-lease 覆盖远程分支，确定吗？', danger: true, okText: '强制推送' })) await run('强制推送', () => git.push(active, { force: true }), '已强制推送') } }
            ])} title={`推送：把本地提交上传到远程${status?.ahead ? `（领先 ${status.ahead}）` : ''}（git push，右键更多选项）`}>
            <Icon name="push" size={14} /><span className="lbl">推送</span>{!!status?.ahead && <em className="count">{status.ahead}</em>}
          </button>
        </div>
      )}
      <button className="palette-trigger" onClick={onPalette} title={`命令面板：搜索命令、视图与高级功能（${MOD}+K）`}><Icon name="search" size={13} /><span>搜索命令…</span><Kbd keys={['Mod', 'K']} /></button>
      <OverflowMenu repoView={!!repoView} />
      <WindowControls />
    </header>
  )
}

/** project / folder… / repo / branch — every segment is a quick switcher. */
function Breadcrumb({ onQuickOpen }: { onQuickOpen: () => void }) {
  const { project, projects, setActiveProject, active, status, view, setView, scope, setScope, projectRepos, summaries, setActive, run } = useApp()
  const menu = useMenu()
  if (!project) return <div className="top-title">欢迎使用 GitLoom</div>
  const root = project.root.replace(/\\/g, '/').replace(/\/+$/, '')
  // 0.6.12: only true workspace views keep folder+概览 crumbs. Do NOT treat !active as workspace —
  // that stuck 「概览」 after switching to 架构与知识 / 质量把关 / 自动化 with no repo selected.
  const wsView = isWorkspaceView(view)
  const showRepo = !!active && !wsView && view !== 'settings'
  const viewLabel = crumbViewLabel(view)
  const mod = moduleOf(view)
  const showViewCrumb = !!viewLabel && (wsView || !showRepo || (mod && mod.id !== 'daily'))
  const repo = projectRepos.find((r) => r.path === active)
  const target = wsView ? (scope ?? root) : showRepo ? (repo?.outside ? null : (repo?.path ?? '').replace(/\\/g, '/')) : null
  const rel = target && target.startsWith(root) ? target.slice(root.length + 1) : ''
  const segs = rel ? rel.split('/') : []
  const folderSegs = wsView ? segs : segs.slice(0, -1)
  const folderPath = (i: number) => `${root}/${folderSegs.slice(0, i + 1).join('/')}`
  const goFolder = (p: string | null) => { setScope(p); setView('dashboard') }
  const siblingsMenu = (el: Element, folder: string) => {
    const kids = projectRepos.filter((r) => r.initialized && r.path.replace(/\\/g, '/').startsWith(folder + '/')).slice(0, 30)
    menu(anchorOf(el), [
      { label: '打开此文件夹概览', icon: 'dashboard', onClick: () => goFolder(folder === root ? null : folder) },
      { sep: true },
      ...kids.map((r) => ({ label: base(r.path), sub: r.path.replace(/\\/g, '/').slice(folder.length + 1), icon: `repo-${r.kind}`, checked: r.path === active, onClick: () => { setActive(r.path); if (wsView) setView('changes') } } as MenuItem)),
      { sep: true },
      { label: '快速打开仓库…', icon: 'search', hint: `${MOD}+P`, onClick: onQuickOpen }
    ])
  }
  const shown = folderSegs.length > 3 ? [0, -1, folderSegs.length - 2, folderSegs.length - 1] : folderSegs.map((_, i) => i)
  const branchMenu = async (el: Element) => {
    if (!active) return
    const list = await git.branches(active).catch(() => [])
    const local = list.filter((b) => !b.remote)
    menu(anchorOf(el), [
      { label: '切换分支', header: true },
      ...local.slice(0, 20).map((b) => ({ label: b.name, icon: 'branch', checked: b.current, sub: b.upstream ? `→ ${b.upstream}` : undefined, onClick: () => { if (!b.current) void run('切换分支', () => git.checkout(active, b.name), `已切换到 ${b.name}`) } } as MenuItem)),
      { sep: true },
      { label: '管理分支与标签…', icon: 'branch', onClick: () => setView('branches') }
    ])
  }
  return (
    <nav className="crumbs" aria-label="位置">
      <button className="crumb crumb-proj" onClick={(e) => menu(anchorOf(e.currentTarget), [
        { label: '项目', header: true },
        ...projects.map((p) => ({ label: p.name, sub: p.root, icon: 'layers', checked: p.id === project.id, onClick: () => setActiveProject(p.id) } as MenuItem)),
        { sep: true },
        { label: '项目概览', icon: 'dashboard', hint: `${MOD}+0`, onClick: () => goFolder(null) },
        { label: '快速打开仓库…', icon: 'search', hint: `${MOD}+P`, onClick: onQuickOpen }
      ])} title={project.root}><Icon name="layers" size={13} /><span>{project.name}</span><Icon name="chevron-down" size={11} className="cd" /></button>
      {shown.map((i, k) => i === -1 ? (
        <React.Fragment key="ellipsis"><Icon name="chevron" size={12} className="crumb-sep" />
          <button className="crumb" onClick={(e) => menu(anchorOf(e.currentTarget), folderSegs.slice(1, folderSegs.length - 2).map((sname, j) => ({ label: sname, icon: 'folder', onClick: () => goFolder(folderPath(j + 1)) })))}>…</button>
        </React.Fragment>
      ) : (
        <React.Fragment key={k}><Icon name="chevron" size={12} className="crumb-sep" />
          <button className={`crumb ${wsView && i === folderSegs.length - 1 ? 'current' : ''}`} onClick={() => goFolder(folderPath(i))} onContextMenu={(e) => { e.preventDefault(); siblingsMenu(e.currentTarget, folderPath(i)) }} title={`${folderPath(i)}\n点击打开概览，右键列出其中的仓库`}><Icon name="folder" size={12} /><span>{folderSegs[i]}</span></button>
        </React.Fragment>
      ))}
      {showRepo && <>
        <Icon name="chevron" size={12} className="crumb-sep" />
        <button className="crumb crumb-repo" onClick={(e) => siblingsMenu(e.currentTarget, folderSegs.length ? folderPath(folderSegs.length - 1) : root)} title={active!}>
          <RepoKindIcon repo={repo} size={13} /><span className="top-repo-name">{base(active!)}</span>{summaries[active!] && <StatusBadges sum={summaries[active!]} repo={repo} />}<Icon name="chevron-down" size={11} className="cd" />
        </button>
        <Icon name="chevron" size={12} className="crumb-sep" />
        <button className="branch-chip" onClick={(e) => void branchMenu(e.currentTarget)} title={`切换分支${status?.upstream ? `\n上游：${status.upstream}` : ''}`}>
          <Icon name="branch" size={13} /><span>{status?.detached ? `分离 HEAD @ ${status.headSha?.slice(0, 7)}` : status?.branch ?? '…'}</span>
          <Icon name="chevron-down" size={11} className="cd" />
        </button>
      </>}
      {showViewCrumb && <><Icon name="chevron" size={12} className="crumb-sep" /><span className="crumb-view" data-testid="crumb-view">{viewLabel}</span></>}
    </nav>
  )
}

function WindowControls() {
  const [max, setMax] = useState(false)
  useEffect(() => {
    if (!window.api.win || window.api.platform === 'darwin') return
    void window.api.win.isMaximized().then(setMax)
    return window.api.win.onMaximized(setMax)
  }, [])
  if (!window.api.win || window.api.platform === 'darwin') return null
  return (
    <div className="win-controls">
      <button title="最小化" aria-label="最小化" onClick={() => window.api.win.minimize()}><Icon name="win-min" size={15} /></button>
      <button title={max ? '还原' : '最大化'} aria-label={max ? '还原' : '最大化'} onClick={() => window.api.win.toggleMaximize()}><Icon name={max ? 'win-restore' : 'win-max'} size={12} /></button>
      <button className="close" title="关闭" aria-label="关闭" onClick={() => window.api.win.close()}><Icon name="x" size={16} /></button>
    </div>
  )
}

/** 设置 page: 通用设置 + 当前仓库的 Git 钩子 (hooks moved here from the repo tab bar in 0.4.1). */
function SettingsPage() {
  const { setView, active } = useApp()
  return (
    <div className="view-stack">
      <div className="subnav settings-tabs" role="tablist" aria-label="设置">
        <div className="seg">
          <button role="tab" aria-selected className="on" onClick={() => setView('settings')} title="AI、外观、当前仓库身份、PR 与 Issue Token"><Icon name="settings" size={13} />通用设置</button>
          <button role="tab" aria-selected={false} disabled={!active} onClick={() => setView('hooks')}
            title={active ? `前往自动化 → 钩子（当前仓库 ${base(active)}）` : '先在左侧选择一个仓库'}><Icon name="hook" size={13} />Git 钩子{active ? ` · ${base(active)}` : ''}</button>
        </div>
      </div>
      <div className="moved-hint" role="note" data-testid="moved-hooks"><Icon name="info" size={14} />Git 钩子主入口在「自动化 → 钩子」，设置里的入口保留。<button className="link" onClick={() => setView('hooks')}>前往自动化</button></div>
      <div className="view-body"><SettingsView /></div>
    </div>
  )
}

/** The single top-right overflow menu: open in editor/terminal/folder, theme, density, command log, settings. */
function OverflowMenu({ repoView }: { repoView: boolean }) {
  const { theme, settings, saveSettings, active, setView } = useApp()
  const menu = useMenu()
  const dark = theme === 'dark'
  return (
    <button className="icon-btn top-more" title="更多操作：在编辑器/终端中打开、主题、密度、设置" aria-label="更多操作" aria-haspopup="menu" onClick={(e) => menu(anchorOf(e.currentTarget), [
      ...(repoView && active ? [
        { label: '当前仓库', header: true } as MenuItem,
        { label: '在编辑器中打开', icon: 'code', onClick: () => window.api.openInEditor(active) },
        { label: '在终端中打开', icon: 'terminal', onClick: () => window.api.openTerminal(active) },
        { label: '在文件管理器中显示', icon: 'folder', onClick: () => window.api.openPath(active) },
        { sep: true } as MenuItem
      ] : []),
      { label: '外观', header: true },
      { label: dark ? '切换到浅色主题' : '切换到深色主题', icon: dark ? 'sun' : 'moon', onClick: () => settings && saveSettings({ ...settings, theme: dark ? 'light' : 'dark' }) },
      { label: settings?.density === 'compact' ? '切换为舒适密度' : '切换为紧凑密度', icon: settings?.density === 'compact' ? 'density-comfortable' : 'density-compact', onClick: () => settings && saveSettings({ ...settings, density: settings.density === 'compact' ? 'comfortable' : 'compact' }) },
      { sep: true },
      ...(repoView && active ? [{ label: 'Git 钩子（当前仓库）…', icon: 'hook', onClick: () => setView('hooks') } as MenuItem] : []),
      { label: '设置', icon: 'settings', hint: `${MOD}+,`, onClick: () => setView('settings') }
    ])}><Icon name="more" /></button>
  )
}

function OperationBanner() {
  const { active, status, run, setView } = useApp()
  const label: Record<string, string> = { MERGING: '正在合并', REBASING: '正在变基', 'CHERRY-PICKING': '正在拣选（cherry-pick）', REVERTING: '正在还原', BISECTING: '正在二分查找（bisect）' }
  const n = status!.conflicted.length
  return (
    <div className="op-banner" data-testid="op-banner" role="status">
      <Icon name="warn" />
      <span><b>{n > 0 ? '有冲突要先处理' : (label[status!.operation!] ?? status!.operation)}</b><span className="muted">{n ? ` · ${label[status!.operation!] ?? status!.operation} · ${n} 个冲突文件待解决` : ' · 冲突已全部解决，可以继续'}</span></span>
      <div className="flex1" />
      {n > 0 && <button className="btn btn-sm btn-primary" data-testid="op-banner-open-wizard" onClick={() => setView('changes')}>去解决冲突</button>}
      {status!.operation !== 'BISECTING' && <button className="btn btn-sm btn-primary" data-testid="op-banner-continue" disabled={n > 0} onClick={() => run('继续', () => git.continueOp(active!), '操作已完成')}>继续</button>}
      <button className="btn btn-sm btn-ghost-danger" data-testid="op-banner-abort" onClick={() => run('中止', () => git.abortOp(active!), '已中止')}>中止</button>
    </div>
  )
}

function StatusBar({ onToggleLog }: { onToggleLog: () => void }) {
  const { status, active, view, project, summaries, scan } = useApp()
  const [ver, setVer] = useState('')
  useEffect(() => {
    git.version().then((v) => setVer(v.replace('git version ', ''))).catch((e) => {
      const m = errMsg(e)
      setVer(/ENOENT|spawn\s+git|not found|找不到/i.test(m) ? '未安装或不在 PATH' : m)
    })
  }, [])
  const ws = isWorkspaceView(view) || !active
  const repos = project?.repos.filter((r) => r.initialized) ?? []
  const dirty = repos.filter((r) => (summaries[r.path]?.changes ?? 0) > 0).length
  return (
    <footer className="statusbar">
      {ws ? <span className="sb-item"><Icon name="layers" size={12} /> {project?.name ?? '—'} · {repos.length} 个仓库{dirty ? ` · ${dirty} 个有改动` : ''}</span> : <>
        <span className="sb-item"><Icon name="branch" size={12} /> {status?.branch ?? '—'}</span>
        {status && <span className="sb-item">
          <span className="sb-add" title="已暂存">● 暂存 {status.staged.length}</span>
          <span className="sb-mod" title="未暂存">● 未暂存 {status.unstaged.length}</span>
          {!!status.conflicted.length && <span className="sb-conf">● 冲突 {status.conflicted.length}</span>}
        </span>}
        {status?.upstream && <span className="sb-item" title="领先 / 落后上游">↑{status.ahead} ↓{status.behind}</span>}
      </>}
      {scan && <span className="sb-item"><Spinner size={10} /> 扫描中 {scan.found}</span>}
      <div className="flex1" />
      <span className="path" title={ws ? project?.root : active ?? ''}>{ws ? project?.root : active}</span>
      <button className="link" onClick={onToggleLog}><Icon name="log" size={12} /> Git 命令日志</button>
      <span title={/未安装|PATH|ENOENT/i.test(ver) ? '系统 PATH 中找不到 git 命令。请安装 Git 并确保终端能运行 git，然后重启 GitLoom。' : undefined}>git {ver || '…'}</span>
    </footer>
  )
}
