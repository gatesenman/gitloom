import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, DiscoveredRepo, Project, RawRepo, RepoStatus, RepoSummary, ScanProgress, WatchEvent } from '@shared/types'
import { app, errMsg, git } from './api'
import { useToast } from './components/ui'
import { projectFromList } from './lib/tree'

import type { View } from './lib/nav'
import { isWorkspaceView } from './lib/nav'

/** Labels whose runs must not overlap for the same repo (value = lock group). */
const EXCLUSIVE_GROUP: Record<string, string> = { '抓取': 'sync', '拉取': 'sync', '推送': 'sync', '变基拉取': 'sync', '提交': 'commit' }
import { explainGitError, type GitFix } from './lib/gitErrors'
import { fireAfterRunSuccess } from './lib/eventRulesRunner'
export type { View }
export type SidebarMode = 'tree' | 'flat' | 'status'

interface Ctx {
  settings: AppSettings | null
  saveSettings: (s: AppSettings) => Promise<void>
  // projects
  projects: Project[]
  project: Project | null
  setActiveProject: (id: string) => void
  addProject: (root: string) => Promise<void>
  removeProject: (id: string) => void
  renameProject: (id: string, name: string) => void
  rescan: (sub?: string) => void
  scan: ScanProgress | null
  cancelScan: () => void
  /** visible, initialized repo paths of the active project (legacy flat list) */
  repos: string[]
  projectRepos: DiscoveredRepo[]
  hideRepo: (p: string) => void
  unhideRepo: (p: string) => void
  pinned: string[]
  togglePin: (p: string) => void
  movePinned: (from: number, to: number) => void
  recent: string[]
  summaries: Record<string, RepoSummary>
  refreshSummaries: (paths?: string[]) => Promise<void>
  scope: string | null
  setScope: (p: string | null) => void
  sidebarMode: SidebarMode
  setSidebarMode: (m: SidebarMode) => void
  // active repo
  active: string | null
  setActive: (p: string | null) => void
  addRepos: (paths: string[]) => Promise<void>
  removeRepo: (p: string) => Promise<void>
  status: RepoStatus | null
  refresh: () => Promise<void>
  refreshAll: () => Promise<void>
  tick: number
  view: View
  setView: (v: View) => void
  busy: string | null
  run: <T>(label: string, fn: () => Promise<T>, okText?: string) => Promise<T | undefined>
  theme: 'dark' | 'light'
}

const C = createContext<Ctx>(null as unknown as Ctx)
export const useApp = () => useContext(C)

const newId = () => `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const relOf = (root: string, p: string) => {
  const a = root.replace(/\\/g, '/').replace(/\/+$/, ''), b = p.replace(/\\/g, '/')
  if (b === a) return ''
  if (b.startsWith(a + '/')) return b.slice(a.length + 1)
  // outside: build ../ relative path
  const as = a.split('/'), bs = b.split('/')
  let i = 0; while (i < as.length && as[i] === bs[i]) i++
  return [...Array(as.length - i).fill('..'), ...bs.slice(i)].join('/')
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const toast = useToast()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string[]>([])
  const [recent, setRecent] = useState<string[]>([])
  const [active, setActiveState] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<Record<string, RepoSummary>>({})
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [tick, setTick] = useState(0)
  const [view, setViewState] = useState<View>('changes')
  const [busy, setBusy] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanProgress | null>(null)
  const [scope, setScope] = useState<string | null>(null)
  const [sidebarMode, setSidebarModeState] = useState<SidebarMode>(() => (localStorage.getItem('gitloom.sidebarMode') as SidebarMode) || 'tree')
  const [loaded, setLoaded] = useState(false)
  const [sysDark, setSysDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const activeRef = useRef<string | null>(null)
  const projectRef = useRef<Project | null>(null)
  const scanIdRef = useRef<string | null>(null)
  const summarizing = useRef(false)

  const project = useMemo(() => projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null, [projects, activeProjectId])
  const projectRepos = project?.repos ?? []
  projectRef.current = project
  const repos = useMemo(() => {
    const hidden = new Set(project?.hidden ?? [])
    return projectRepos.filter((r) => r.initialized && !hidden.has(r.path)).map((r) => r.path)
  }, [projectRepos, project?.hidden])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const h = () => setSysDark(mq.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])

  // ---------------------------------------------------------------- load + migrate + persist
  useEffect(() => {
    void (async () => {
      setSettings(await app.settings())
      const ws = await app.workspace()
      let projs = ws.projects ?? []
      if (!projs.length && ws.repos?.length) projs = [projectFromList(ws.repos)]
      setProjects(projs)
      const pid = ws.activeProject && projs.some((p) => p.id === ws.activeProject) ? ws.activeProject : projs[0]?.id ?? null
      setActiveProjectId(pid)
      setPinned(ws.pinned ?? [])
      setRecent(ws.recent ?? [])
      const p = projs.find((x) => x.id === pid)
      const all = p?.repos.filter((r) => r.initialized).map((r) => r.path) ?? []
      const a = ws.active && all.includes(ws.active) ? ws.active : all[0] ?? null
      activeRef.current = a
      setActiveState(a)
      setLoaded(true)
      window.api.perfMark?.('workspace-loaded', `${all.length} cached repos`)
    })()
  }, [])

  useEffect(() => {
    if (!loaded) return
    const t = setTimeout(() => { void app.setWorkspace({ repos, active, projects, activeProject: project?.id ?? null, pinned, recent }) }, 250)
    return () => clearTimeout(t)
  }, [loaded, repos, active, projects, project?.id, pinned, recent])

  const updateProject = useCallback((id: string, fn: (p: Project) => Project) => setProjects((ps) => ps.map((p) => (p.id === id ? fn(p) : p))), [])

  // ---------------------------------------------------------------- active repo + status
  const setActive = useCallback((p: string | null) => {
    activeRef.current = p
    setActiveState(p)
    setStatus(null)
    if (p) setRecent((r) => [p, ...r.filter((x) => x !== p)].slice(0, 12))
  }, [])

  const setView = useCallback((v: View) => { setViewState(v); if (!isWorkspaceView(v)) setScope(null) }, [])

  const mergeSummary = useCallback((list: RepoSummary[]) => setSummaries((s) => { const n = { ...s }; for (const x of list) if (x) n[x.path] = x; return n }), [])
  // perf milestones (no-op unless GITLOOM_PERF): first tree with repos, first time every repo has a status summary
  const perfDone = useRef({ tree: false, sums: false })
  useEffect(() => {
    if (!perfDone.current.tree && repos.length) { perfDone.current.tree = true; window.api.perfMark?.('tree', `${repos.length} repos`) }
    if (!perfDone.current.sums && repos.length && repos.every((r) => summaries[r])) { perfDone.current.sums = true; window.api.perfMark?.('summaries', `${repos.length} repos`) }
  }, [repos, summaries])

  const refresh = useCallback(async () => {
    const a = activeRef.current
    if (!a) { setStatus(null); return }
    try {
      const st = await git.status(a)
      if (activeRef.current === a) setStatus(st)
      setSummaries((s) => ({ ...s, [a]: { ...(s[a] ?? { path: a, name: basename(a), isWorktree: false }), branch: st.detached ? `(${st.headSha?.slice(0, 7)})` : st.branch, changes: st.staged.length + st.unstaged.length + st.conflicted.length, ahead: st.ahead, behind: st.behind, detached: st.detached, conflicts: st.conflicted.length, staged: st.staged.length, upstream: st.upstream, operation: st.operation, dirtySubmodules: st.unstaged.filter((f) => f.submodule).length, error: undefined, updatedAt: Date.now() } }))
    } catch (e) {
      if (activeRef.current === a) setStatus(null)
      setSummaries((s) => ({ ...s, [a]: { ...(s[a] ?? { path: a, name: basename(a), branch: null, changes: 0, ahead: 0, behind: 0, isWorktree: false }), error: errMsg(e) } }))
    }
    setTick((t) => t + 1)
  }, [])

  /** Concurrency-limited summary refresh (main process pool), merged progressively in chunks. */
  const refreshSummaries = useCallback(async (paths?: string[]) => {
    const list = paths ?? repos
    if (!list.length) return
    if (!paths) { if (summarizing.current) return; summarizing.current = true }
    try {
      const CHUNK = 24
      for (let i = 0; i < list.length; i += CHUNK) mergeSummary(await window.api.summaries(list.slice(i, i + CHUNK)))
    } finally { if (!paths) summarizing.current = false }
  }, [repos, mergeSummary])
  const refreshAll = useCallback(() => refreshSummaries(), [refreshSummaries])

  useEffect(() => { void refresh() }, [active, refresh])
  useEffect(() => { void refreshSummaries() }, [refreshSummaries])

  useEffect(() => {
    const t1 = setInterval(() => { if (document.visibilityState === 'visible' && !busy) void refresh() }, 4000)
    const t2 = setInterval(() => { if (document.visibilityState === 'visible') void refreshSummaries() }, 45000)
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(t1); clearInterval(t2); window.removeEventListener('focus', onFocus) }
  }, [refresh, refreshSummaries, busy])

  useEffect(() => {
    const m = settings?.autoFetchMinutes ?? 0
    if (!m) return
    const t = setInterval(() => { if (activeRef.current) void git.fetch(activeRef.current).then(refresh).catch(() => undefined) }, m * 60000)
    return () => clearInterval(t)
  }, [settings?.autoFetchMinutes, refresh])

  // ---------------------------------------------------------------- scanning + watching
  const startScan = useCallback((p: Project, sub?: string, quiet = false) => {
    const id = `scan-${Date.now().toString(36)}`
    if (!quiet) { scanIdRef.current = id; setScan({ scanId: id, root: p.root, sub, dirs: 0, found: 0, current: '', done: false }) }
    void window.api.scanProject(id, p.root, sub)
  }, [])

  useEffect(() => window.api.onScanProgress((raw) => {
    const sp = raw as ScanProgress
    if (sp.scanId === scanIdRef.current) setScan(sp.done ? null : sp)
    if (sp.done && sp.repos) {
      setProjects((ps) => ps.map((p) => (p.root === sp.root ? { ...p, repos: sp.repos!, scannedAt: Date.now(), manual: false } : p)))
      if (sp.scanId === scanIdRef.current) {
        scanIdRef.current = null
        toast('ok', `扫描完成：${sp.repos.length} 个仓库 · ${sp.dirs} 个文件夹${sp.watchDirs ? ` · 监视 ${sp.watchDirs} 个目录` : ''}`)
        setActiveState((a) => {
          if (a && sp.repos!.some((r) => r.path === a)) return a
          const first = sp.repos!.find((r) => r.initialized && r.kind !== 'bare')?.path ?? null
          activeRef.current = first
          return first
        })
      }
    }
    if (sp.done && sp.cancelled && sp.scanId === scanIdRef.current) { scanIdRef.current = null; toast('info', '已取消扫描') }
    if (sp.done && sp.error && sp.scanId === scanIdRef.current) { scanIdRef.current = null; toast('err', `扫描失败：${sp.error}`) }
  }), [toast])

  useEffect(() => window.api.onProjectUpdated((raw) => {
    const u = raw as { root: string; repos: DiscoveredRepo[] }
    setProjects((ps) => ps.map((p) => {
      if (p.root !== u.root) return p
      const before = new Set(p.repos.map((r) => r.path))
      const added = u.repos.filter((r) => !before.has(r.path))
      const removed = p.repos.filter((r) => !u.repos.some((x) => x.path === r.path))
      if (added.length || removed.length) toast('info', `检测到文件夹变化：${added.length ? `新增 ${added.map((r) => r.rel || basename(r.path)).join('、')}` : ''}${added.length && removed.length ? '；' : ''}${removed.length ? `移除 ${removed.map((r) => r.rel || basename(r.path)).join('、')}` : ''}`)
      if (added.length) void refreshSummaries(added.filter((r) => r.initialized).map((r) => r.path))
      return { ...p, repos: u.repos }
    }))
  }), [toast, refreshSummaries])

  useEffect(() => window.api.onWatchEvent((raw) => {
    const ev = raw as WatchEvent
    if (ev.kind !== 'status') return
    void refreshSummaries([ev.path])
    if (ev.path === activeRef.current) void refresh()
  }), [refreshSummaries, refresh])

  // quiet background rescan of the active project on startup / switch (also arms fs watchers)
  const armed = useRef(new Set<string>())
  useEffect(() => {
    if (!loaded || !project || project.manual || armed.current.has(project.root)) return
    armed.current.add(project.root)
    startScan(project, undefined, true)
  }, [loaded, project, startScan])

  const rescan = useCallback((sub?: string) => { if (project) startScan(project, sub) }, [project, startScan])
  const cancelScan = useCallback(() => { if (scanIdRef.current) void window.api.cancelScan(scanIdRef.current) }, [])

  const addProject = useCallback(async (root: string) => {
    const existing = projects.find((p) => p.root === root)
    if (existing) { setActiveProjectId(existing.id); startScan(existing); return }
    const p: Project = { id: newId(), name: basename(root), root, repos: [], hidden: [] }
    setProjects((ps) => [...ps, p])
    setActiveProjectId(p.id)
    armed.current.add(root)
    setActiveState(null); activeRef.current = null
    setViewState('dashboard')
    startScan(p)
  }, [projects, startScan])

  const removeProject = useCallback((id: string) => {
    const p = projects.find((x) => x.id === id)
    if (p) void window.api.watchProject(p.root, false)
    setProjects((ps) => ps.filter((x) => x.id !== id))
    if (project?.id === id) { const next = projects.find((x) => x.id !== id); setActiveProjectId(next?.id ?? null); const a = next?.repos.find((r) => r.initialized)?.path ?? null; activeRef.current = a; setActiveState(a) }
  }, [projects, project?.id])

  const renameProject = useCallback((id: string, name: string) => updateProject(id, (p) => ({ ...p, name })), [updateProject])

  const setActiveProject = useCallback((id: string) => {
    setActiveProjectId(id)
    const p = projects.find((x) => x.id === id)
    const a = p?.repos.find((r) => r.initialized && r.kind !== 'bare')?.path ?? null
    activeRef.current = a
    setActiveState(a)
    setStatus(null)
  }, [projects])

  // ---------------------------------------------------------------- repo list editing
  const addRepos = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    const probes = await Promise.all(paths.map((p) => (window.api.probeRepo(p) as Promise<RawRepo | null>).catch(() => null)))
    const target = project ?? projectFromList(paths)
    const entries: DiscoveredRepo[] = paths.map((p, i) => {
      const raw = probes[i]
      const rel = relOf(target.root, p)
      return { path: p, rel, kind: raw?.git === 'worktree' ? 'worktree' : raw?.git === 'bare' ? 'bare' : 'normal', mainRepo: raw?.mainRepo, initialized: true, outside: rel.startsWith('..') || undefined }
    })
    if (!project) { setProjects([{ ...target, repos: entries }]); setActiveProjectId(target.id) }
    else updateProject(project.id, (p) => ({ ...p, hidden: p.hidden.filter((h) => !paths.includes(h)), repos: [...p.repos.filter((r) => !paths.includes(r.path)), ...entries] }))
    void refreshSummaries(paths)
    setActive(paths[0])
  }, [project, updateProject, refreshSummaries, setActive])

  const removeRepo = useCallback(async (p: string) => {
    if (!project) return
    updateProject(project.id, (x) => ({ ...x, repos: x.repos.filter((r) => r.path !== p) }))
    if (activeRef.current === p) { const n = repos.find((r) => r !== p) ?? null; activeRef.current = n; setActiveState(n) }
  }, [project, repos, updateProject])

  const hideRepo = useCallback((p: string) => {
    if (!project) return
    updateProject(project.id, (x) => ({ ...x, hidden: [...new Set([...x.hidden, p])] }))
    setPinned((ps) => ps.filter((x) => x !== p))
    if (activeRef.current === p) { const n = repos.find((r) => r !== p) ?? null; activeRef.current = n; setActiveState(n) }
  }, [project, repos, updateProject])
  const unhideRepo = useCallback((p: string) => { if (project) updateProject(project.id, (x) => ({ ...x, hidden: x.hidden.filter((h) => h !== p) })) }, [project, updateProject])

  const togglePin = useCallback((p: string) => setPinned((ps) => (ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p])), [])
  const movePinned = useCallback((from: number, to: number) => setPinned((ps) => { const n = [...ps]; const [x] = n.splice(from, 1); n.splice(to, 0, x); return n }), [])
  const setSidebarMode = useCallback((m: SidebarMode) => { localStorage.setItem('gitloom.sidebarMode', m); setSidebarModeState(m) }, [])

  useEffect(() => { (window as unknown as { __gitloomSetActive: (p: string) => void }).__gitloomSetActive = (p: string) => setActive(p) }, [setActive])
  useEffect(() => { (window as unknown as { __gitloomSetView: (v: View) => void }).__gitloomSetView = (v: View) => setView(v) }, [setView])

  const saveSettings = useCallback(async (s: AppSettings) => { setSettings(await app.setSettings(s)) }, [])
  useEffect(() => { (window as unknown as { __gitloomSaveSettings: typeof saveSettings }).__gitloomSaveSettings = saveSettings }, [saveSettings])

  // network/sync ops and commit are exclusive per repo: a double-click / Ctrl+Enter repeat while one is running is
  // ignored instead of spawning a second git process (which used to fail on index.lock or double-commit)
  const exclusive = useRef(new Map<string, string>())
  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
    const group = EXCLUSIVE_GROUP[label]
    const ek = group ? `${activeRef.current ?? ''}|${group}` : null
    if (ek) {
      const cur = exclusive.current.get(ek)
      if (cur) { if (cur !== label) toast('info', `正在${cur}，完成后再${label}`); return undefined }
      exclusive.current.set(ek, label)
    }
    setBusy(label)
    try {
      const r = await fn()
      if (okText) toast('ok', okText)
      // 事件触发规则：成功拉取/推送/抓取/提交后异步执行（不阻塞、不抛回）
      fireAfterRunSuccess({
        label,
        projectId: projectRef.current?.id,
        projectRoot: projectRef.current?.root,
        repo: activeRef.current,
        toast
      })
      return r
    } catch (e) {
      const raw = errMsg(e)
      const info = explainGitError(raw)
      if (!info) { toast('err', `${label}失败：${raw}`); return undefined }
      const repo = activeRef.current
      const fixes: Partial<Record<GitFix, () => void>> = {
        retry: () => { void runRef.current(label, fn, okText) },
        pushSetUpstream: () => { if (repo) void runRef.current('推送', () => git.push(repo, { setUpstream: true }), '已推送并设置上游分支') },
        pullRebase: () => { if (repo) void runRef.current('变基拉取', () => git.pull(repo, true), '已变基拉取，可以再次推送') },
        pull: () => { if (repo) void runRef.current('拉取', () => git.pull(repo), '已拉取') },
        stash: () => { if (repo) void runRef.current('储藏', () => git.stashPush(repo, `GitLoom 自动储藏（${label}前）`, { includeUntracked: true }), '已储藏本地改动，可在「分支 → 储藏」恢复；现在可以重试') },
        openChanges: () => setViewState('changes'),
        newBranch: () => setViewState('branches'),
        openRemotes: () => setViewState('branches')
      }
      const doFix = info.fix ? fixes[info.fix] : undefined
      toast('err', `${label}失败：${info.title}。${info.hint}`, doFix ? { label: info.fixLabel!, icon: 'chevron', onClick: doFix } : undefined)
      return undefined
    } finally {
      if (ek) exclusive.current.delete(ek)
      setBusy(null)
      void refresh()
    }
  }, [toast, refresh])
  const runRef = useRef(run)
  runRef.current = run

  const theme: 'dark' | 'light' = settings?.theme === 'system' ? (sysDark ? 'dark' : 'light') : (settings?.theme ?? 'dark')

  const value = useMemo<Ctx>(() => ({
    settings, saveSettings, projects, project, setActiveProject, addProject, removeProject, renameProject, rescan, scan, cancelScan,
    repos, projectRepos, hideRepo, unhideRepo, pinned, togglePin, movePinned, recent, summaries, refreshSummaries, scope, setScope,
    sidebarMode, setSidebarMode, active, setActive, addRepos, removeRepo, status, refresh, refreshAll, tick, view, setView, busy, run, theme
  }), [settings, saveSettings, projects, project, setActiveProject, addProject, removeProject, renameProject, rescan, scan, cancelScan,
    repos, projectRepos, hideRepo, unhideRepo, pinned, togglePin, movePinned, recent, summaries, refreshSummaries, scope,
    sidebarMode, setSidebarMode, active, setActive, addRepos, removeRepo, status, refresh, refreshAll, tick, view, setView, busy, run, theme])

  return <C.Provider value={value}>{children}</C.Provider>
}
