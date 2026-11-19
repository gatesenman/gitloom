// Project sidebar: project switcher, filter, Tree / Flat / Grouped-by-status modes, pinned + recent,
// virtualized rows, keyboard navigation with type-ahead, per-node context menus and rolled-up badges.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DiscoveredRepo } from '@shared/types'
import { useApp, type SidebarMode } from '../state'
import { app, git } from '../api'
import logo from '../assets/logo.svg'
import { Icon } from './Icon'
import { MOD, Resizer, Spinner, anchorOf, useDialog, useMenu, useToast, usePersistentState, type MenuItem } from './ui'
import { RepoAvatar, RepoKindIcon, StatusBadges, openItems, repoMenu, repoTitle } from './RepoBits'
import { aggregate, allIds, ancestorsOf, buildTree, filterTree, filterTreeWhere, flatten, fuzzyScore, groupByStatus, needsAttention, type TNode } from '../lib/tree'

type VRow =
  | { t: 'section'; id: string; label: string; count: number; icon: string; open: boolean }
  | { t: 'node'; id: string; node: TNode; depth: number; hasChildren: boolean; expanded: boolean }
  | { t: 'repo'; id: string; repo: DiscoveredRepo; section: 'pinned' | 'recent' | 'flat' | 'status'; dir?: string; pinIndex?: number }
  | { t: 'note'; id: string; text: string }

const MODES: { id: SidebarMode; label: string; icon: string }[] = [
  { id: 'tree', label: '树', icon: 'tree' }, { id: 'flat', label: '列表', icon: 'list' }, { id: 'status', label: '状态', icon: 'grouped' }
]
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')

const BADGE_LEGEND = [
  '徽标说明',
  '黄色数字  有未提交的改动文件数',
  '↑ 数字    领先上游（待推送的提交）',
  '↓ 数字    落后上游（待拉取的提交）',
  '⚠ 红色    有合并冲突 / 仓库不可用',
  'HEAD      分离 HEAD（没在任何分支上）',
  '无上游    分支还没推送过 / 没关联远程分支',
  '+N        折叠的文件夹里还有 N 个嵌套仓库',
  '',
  '悬停仓库可看完整路径、分支与上游；文件夹徽标是其下所有仓库的汇总。'
].join('\n')

export function ProjectSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const ctx = useApp()
  const { project, projects, summaries, active, setActive, view, setView, scope, setScope, sidebarMode, setSidebarMode, pinned, recent, scan, cancelScan, rescan, settings, saveSettings } = ctx
  const menu = useMenu()
  const toast = useToast()
  const dialog = useDialog()
  const [query, setQuery] = useState('')
  const [width, setWidth] = usePersistentState('gitloom.sidebarW', 296)
  const [changedOnly, setChangedOnly] = usePersistentState('gitloom.sidebar.changedOnly', false)
  const [sections, setSections] = usePersistentState<Record<string, boolean>>('gitloom.sections', { pinned: true, recent: true })
  const expKey = `gitloom.expanded.${project?.id ?? 'none'}`
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(400)
  const typeBuf = useRef({ s: '', t: 0 })
  const dragFrom = useRef<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const ROW_H = settings?.density === 'compact' ? 24 : 28

  useEffect(() => { document.documentElement.style.setProperty('--sidebar-w', `${width}px`) }, [width])

  const tree = useMemo(() => (project ? buildTree(project) : null), [project])
  const aggTree = useMemo(() => (tree ? { root: aggregate(tree, summaries), v: Date.now() } : null), [tree, summaries])
  const repoByPath = useMemo(() => new Map((project?.repos ?? []).map((r) => [r.path, r])), [project?.repos])
  const hidden = useMemo(() => new Set(project?.hidden ?? []), [project?.hidden])
  const visibleRepos = useMemo(() => (project?.repos ?? []).filter((r) => !hidden.has(r.path)), [project?.repos, hidden])

  // expanded state: restore per project; default = everything for small projects, two levels for large ones
  useEffect(() => {
    if (!tree) return
    const saved = localStorage.getItem(expKey)
    if (saved) { try { setExpanded(new Set(JSON.parse(saved))); return } catch { /* fallthrough */ } }
    const ids = allIds(tree)
    setExpanded(new Set(visibleRepos.length <= 80 ? ids : [tree.id, ...tree.children.map((c) => c.id)]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expKey, (tree?.children.length ?? 0) > 0])
  const saveExpanded = useCallback((s: Set<string>) => { setExpanded(s); localStorage.setItem(expKey, JSON.stringify([...s])) }, [expKey])
  const toggle = useCallback((id: string, open?: boolean) => {
    const n = new Set(expanded)
    if (open ?? !n.has(id)) n.add(id); else n.delete(id)
    saveExpanded(n)
  }, [expanded, saveExpanded])
  const expandAll = useCallback(() => tree && saveExpanded(new Set(allIds(tree))), [tree, saveExpanded])
  const collapseAll = useCallback(() => tree && saveExpanded(new Set([tree.id])), [tree, saveExpanded])

  // reveal the active repo (quick open / breadcrumb / palette) by expanding its ancestors
  useEffect(() => {
    if (!tree || !active) return
    const id = active.replace(/\\/g, '/')
    const anc = ancestorsOf(tree, id)
    if (anc.some((a) => !expanded.has(a))) saveExpanded(new Set([...expanded, ...anc]))
    setCursor(`n:${id}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tree])

  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as string
      if (d === 'expand-all') expandAll()
      else if (d === 'collapse-all') collapseAll()
      else if (d === 'focus-filter') filterRef.current?.focus()
      else if (d === 'focus-tree') listRef.current?.focus()
      else if (d?.startsWith('filter:')) setQuery(d.slice(7))
    }
    window.addEventListener('gitloom:sidebar', h)
    return () => window.removeEventListener('gitloom:sidebar', h)
  }, [expandAll, collapseAll])

  // ---------------------------------------------------------------- rows
  // switching view modes starts at the top (groups / pinned first) instead of keeping a stale offset
  useEffect(() => { if (listRef.current) { listRef.current.scrollTop = 0; setScrollTop(0) } }, [sidebarMode])
  const rows = useMemo<VRow[]>(() => {
    if (!project || !aggTree) return []
    const out: VRow[] = []
    const q = query.trim()
    const repoRow = (r: DiscoveredRepo, section: 'pinned' | 'recent' | 'flat' | 'status', extra: Partial<Extract<VRow, { t: 'repo' }>> = {}): VRow => ({ t: 'repo', id: `${section}:${r.path}`, repo: r, section, dir: dirOf(r.rel), ...extra })
    const matches = (r: DiscoveredRepo) => (!changedOnly || needsAttention(summaries[r.path])) && (!q || fuzzyScore(q, `${base(r.path)} ${r.rel} ${summaries[r.path]?.branch ?? ''}`) >= 0)
    if (!q) {
      const pins = pinned.map((p) => repoByPath.get(p)).filter(Boolean) as DiscoveredRepo[]
      if (pins.length) {
        out.push({ t: 'section', id: 's:pinned', label: '已固定', count: pins.length, icon: 'pin', open: sections.pinned !== false })
        if (sections.pinned !== false) pins.forEach((r, i) => out.push(repoRow(r, 'pinned', { pinIndex: i })))
      }
      const rec = recent.filter((p) => !pinned.includes(p)).map((p) => repoByPath.get(p)).filter((r): r is DiscoveredRepo => !!r && !hidden.has(r.path)).slice(0, 4)
      if (rec.length && visibleRepos.length > 6) {
        out.push({ t: 'section', id: 's:recent', label: '最近', count: rec.length, icon: 'clock', open: sections.recent !== false })
        if (sections.recent !== false) rec.forEach((r) => out.push(repoRow(r, 'recent')))
      }
    }
    if (sidebarMode === 'tree') {
      if (out.length) out.push({ t: 'section', id: 's:tree', label: '项目结构', count: visibleRepos.length, icon: 'tree', open: true })
      let f = q ? filterTree(aggTree.root, q, summaries) : null
      if (changedOnly) {
        const qv = f?.visible
        f = { visible: filterTreeWhere(aggTree.root, (n) => !!n.repo && needsAttention(summaries[n.repo.path]) && (!qv || qv.has(n.id))), scores: new Map() }
      }
      if (f && !f.visible.size) out.push({ t: 'note', id: 'n:none', text: changedOnly ? (q ? `没有匹配“${q}”且有改动的仓库` : '所有仓库都是干净的，没有待处理的改动 🎉') : `没有匹配“${q}”的仓库` })
      else for (const r of flatten(aggTree.root, expanded, f ? { visible: f.visible, forceExpand: true } : {})) out.push({ t: 'node', id: `n:${r.node.id}`, node: r.node, depth: r.depth, hasChildren: r.hasChildren, expanded: r.expanded })
    } else if (sidebarMode === 'flat') {
      let list = visibleRepos.filter(matches)
      if (q) list = [...list].sort((a, b) => fuzzyScore(q, `${base(b.path)} ${b.rel}`) - fuzzyScore(q, `${base(a.path)} ${a.rel}`))
      out.push({ t: 'section', id: 's:flat', label: '全部仓库', count: list.length, icon: 'list', open: true })
      list.forEach((r) => out.push(repoRow(r, 'flat')))
      if (!list.length) out.push({ t: 'note', id: 'n:none', text: changedOnly && !q ? '所有仓库都是干净的，没有待处理的改动 🎉' : `没有匹配“${q}”的仓库` })
    } else {
      const groups = groupByStatus(visibleRepos.filter(matches), summaries)
      for (const g of groups) {
        const open = sections[`g:${g.key}`] !== false
        out.push({ t: 'section', id: `s:g:${g.key}`, label: g.label, count: g.repos.length, icon: g.key === 'conflict' ? 'warn' : g.key === 'changed' ? 'changes' : g.key === 'push' ? 'push' : g.key === 'pull' ? 'pull' : g.key === 'clean' ? 'check' : 'uninit', open })
        if (open) g.repos.forEach((r) => out.push({ ...repoRow(r, 'status'), id: `status:${g.key}:${r.path}` }))
      }
      if (!groups.length) out.push({ t: 'note', id: 'n:none', text: q ? `没有匹配“${q}”的仓库` : '正在读取仓库状态…' })
    }
    return out
  }, [project, aggTree, query, pinned, recent, sections, sidebarMode, expanded, summaries, repoByPath, hidden, visibleRepos, changedOnly])

  // ---------------------------------------------------------------- virtualization
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [collapsed])
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 8)
  const scrollToRow = useCallback((i: number) => {
    const el = listRef.current
    if (!el || i < 0) return
    const top = i * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
  }, [ROW_H])
  useEffect(() => { if (cursor) scrollToRow(rows.findIndex((r) => r.id === cursor)) }, [cursor, rows, scrollToRow])

  // ---------------------------------------------------------------- actions
  const openRepo = useCallback((r: DiscoveredRepo) => {
    if (!r.initialized) { toast('info', '子模块尚未初始化：右键选择“初始化子模块”'); return }
    setActive(r.path)
    if (r.kind === 'bare') setView('history')
    else if (view === 'dashboard' || view === 'allchanges' || view === 'repos' || view === 'settings') setView('changes')
  }, [setActive, setView, view, toast])
  const openFolder = useCallback((n: TNode) => {
    if (n.type === 'group') return
    setScope(n.type === 'project' ? null : n.path)
    setView('dashboard')
  }, [setScope, setView])
  const activate = useCallback((row: VRow) => {
    setCursor(row.id)
    if (row.t === 'repo') openRepo(row.repo)
    else if (row.t === 'node') { if (row.node.repo) openRepo(row.node.repo); else { openFolder(row.node); if (!row.expanded && row.hasChildren) toggle(row.node.id, true) } }
    else if (row.t === 'section') toggleSection(row.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRepo, openFolder, toggle])
  const toggleSection = (id: string) => {
    const k = id.replace(/^s:/, '')
    if (k === 'tree' || k === 'flat') return
    setSections((s) => ({ ...s, [k]: s[k] === false }))
  }

  const actx = { run: ctx.run, togglePin: ctx.togglePin, pinned, hideRepo: ctx.hideRepo, rescan, toast, unhideRepo: ctx.unhideRepo, refreshSummaries: ctx.refreshSummaries }
  const gitApi = { fetch: (p: string) => git.fetch(p), pull: (p: string) => git.pull(p), push: (p: string) => git.push(p), raw: (p: string, c: string) => app.gitRaw(p, c) }
  const folderMenu = (n: TNode): MenuItem[] => {
    const under = (n.type === 'project' ? visibleRepos : visibleRepos.filter((r) => r.path.replace(/\\/g, '/').startsWith(n.path + '/'))).filter((r) => r.initialized)
    return [
      { label: n.name, header: true },
      { label: '打开概览', icon: 'dashboard', onClick: () => openFolder(n) },
      { label: `抓取此处全部 ${under.length} 个仓库`, icon: 'fetch', disabled: !under.length, onClick: () => { setScope(n.type === 'project' ? null : n.path); setView('dashboard'); setTimeout(() => window.dispatchEvent(new CustomEvent('gitloom:dashboard', { detail: 'fetch-all' })), 50) } },
      { sep: true },
      ...(n.type !== 'group' ? openItems(n.path) : []),
      { sep: true },
      { label: '展开全部子项', icon: 'expand-all', onClick: () => { const ids: string[] = []; const w = (x: TNode) => { if (x.children.length) ids.push(x.id); x.children.forEach(w) }; w(n); saveExpanded(new Set([...expanded, ...ids])) } },
      { label: '折叠', icon: 'collapse-all', onClick: () => toggle(n.id, false) },
      { label: '复制路径', icon: 'copy', onClick: () => { void navigator.clipboard.writeText(n.path); toast('ok', `已复制：${n.path}`) } },
      { label: '重新扫描此文件夹', icon: 'scan', disabled: n.type === 'group', onClick: () => rescan(n.type === 'project' ? undefined : n.path) }
    ]
  }
  const rowMenu = (e: React.MouseEvent, row: VRow) => {
    if (!project) return
    setCursor(row.id)
    if (row.t === 'repo') menu(e, repoMenu(row.repo, project.root, actx, gitApi))
    else if (row.t === 'node') {
      if (row.node.repo) {
        const items = repoMenu(row.node.repo, project.root, actx, gitApi)
        if (row.node.type === 'project' || row.hasChildren) items.splice(0, 0, { label: '打开概览（含嵌套仓库）', icon: 'dashboard', onClick: () => openFolder(row.node) }, { sep: true })
        menu(e, items)
      } else menu(e, folderMenu(row.node))
    }
  }

  // ---------------------------------------------------------------- keyboard
  const onKey = (e: React.KeyboardEvent) => {
    if (!rows.length) return
    const i = Math.max(0, rows.findIndex((r) => r.id === cursor))
    const row = rows[i]
    const go = (j: number) => { const k = Math.max(0, Math.min(rows.length - 1, j)); setCursor(rows[k].id) }
    const page = Math.max(1, Math.floor(viewH / ROW_H) - 1)
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); go(i + 1); return
      case 'ArrowUp': e.preventDefault(); go(i - 1); return
      case 'PageDown': e.preventDefault(); go(i + page); return
      case 'PageUp': e.preventDefault(); go(i - page); return
      case 'Home': e.preventDefault(); go(0); return
      case 'End': e.preventDefault(); go(rows.length - 1); return
      case 'ArrowRight':
        e.preventDefault()
        if (row.t === 'node' && row.hasChildren) { if (!row.expanded) toggle(row.node.id, true); else go(i + 1) }
        else if (row.t === 'section' && !row.open) toggleSection(row.id)
        return
      case 'ArrowLeft':
        e.preventDefault()
        if (row.t === 'node') {
          if (row.expanded) toggle(row.node.id, false)
          else { for (let j = i - 1; j >= 0; j--) { const r = rows[j]; if (r.t === 'node' && r.depth < row.depth) { setCursor(r.id); break } } }
        } else if (row.t === 'section' && row.open) toggleSection(row.id)
        else if (row.t === 'repo') { for (let j = i - 1; j >= 0; j--) if (rows[j].t === 'section') { setCursor(rows[j].id); break } }
        return
      case 'Enter': e.preventDefault(); activate(row); return
      case ' ': e.preventDefault(); if (row.t === 'node' && row.hasChildren) toggle(row.node.id); else if (row.t === 'section') toggleSection(row.id); return
      case 'ContextMenu': { e.preventDefault(); const el = listRef.current?.querySelector(`[data-row="${CSS.escape(row.id)}"]`); if (el) { const r = el.getBoundingClientRect(); rowMenu({ clientX: r.left + 40, clientY: r.bottom, preventDefault: () => undefined, stopPropagation: () => undefined } as unknown as React.MouseEvent, row) } return }
      case 'Escape': if (query) { setQuery(''); e.preventDefault() } return
    }
    // type-ahead: jump to the next row whose label starts with the typed prefix
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now()
      const tb = typeBuf.current
      tb.s = now - tb.t > 700 ? e.key.toLowerCase() : tb.s + e.key.toLowerCase()
      tb.t = now
      const label = (r: VRow) => (r.t === 'node' ? r.node.name.split('/').pop()! : r.t === 'repo' ? base(r.repo.path) : r.t === 'section' ? r.label : '').toLowerCase()
      const from = tb.s.length > 1 ? i : i + 1
      for (let k = 0; k < rows.length; k++) { const r = rows[(from + k) % rows.length]; if (label(r).startsWith(tb.s)) { setCursor(r.id); break } }
    }
  }

  // ---------------------------------------------------------------- project switcher / add
  const addProjectFolder = async () => { const dir = await app.pickFolder('选择项目文件夹（将递归扫描其中的所有仓库）'); if (dir) await ctx.addProject(dir) }
  const clone = async () => {
    const r = await dialog({ title: '克隆仓库', fields: [
      { name: 'url', label: '仓库地址', placeholder: 'https://github.com/user/repo.git 或 git@…' },
      { name: 'parent', label: '保存到（父目录）', placeholder: project?.root ?? '/home/me/code', value: project?.root ?? '' },
      { name: 'depth', label: '浅克隆深度（可选）', placeholder: '留空为完整克隆' }
    ], okText: '克隆' })
    if (!r || !r.url) return
    let parent = String(r.parent)
    if (!parent) { const p = await app.pickFolder('选择保存位置'); if (!p) return; parent = p }
    const name = String(r.url).replace(/\/+$/, '').split('/').pop()!.replace(/\.git$/, '')
    const dir = `${parent.replace(/[\\/]+$/, '')}/${name}`
    const ok = await ctx.run('克隆', async () => { await git.clone(String(r.url), dir, r.depth ? { depth: Number(r.depth) } : undefined); return true }, `已克隆到 ${dir}`)
    if (ok) await ctx.addRepos([dir])
  }
  const addRepoOnly = async () => {
    const dir = await app.pickFolder('选择一个 Git 仓库')
    if (!dir) return
    if (!(await git.isRepo(dir))) {
      if (await dialog({ title: '不是 Git 仓库', message: `要在 ${dir} 初始化新仓库吗？`, okText: '初始化' })) { await ctx.run('初始化', () => git.init(dir), '已初始化仓库'); await ctx.addRepos([dir]) }
      return
    }
    await ctx.addRepos([dir])
  }
  const projectMenu = (e: React.MouseEvent | { clientX: number; clientY: number }) => {
    const hiddenList = project?.hidden ?? []
    menu(e, [
      { label: '项目', header: true },
      ...projects.map((p) => ({ label: p.name, sub: p.root, icon: 'folder', checked: p.id === project?.id, onClick: () => ctx.setActiveProject(p.id) })),
      { sep: true },
      { label: '添加项目文件夹…', icon: 'folder-plus', onClick: addProjectFolder },
      { label: '克隆仓库…', icon: 'download', onClick: clone },
      ...(project ? [
        { sep: true },
        { label: '项目概览', icon: 'dashboard', onClick: () => { setScope(null); setView('dashboard') } },
        { label: project.manual ? '扫描文件夹（启用自动发现与监视）' : '重新扫描项目', icon: 'scan', onClick: () => rescan() },
        { label: '添加单个仓库到此项目…', icon: 'plus', onClick: addRepoOnly },
        { label: '重命名项目…', icon: 'save', onClick: async () => { const r = await dialog({ title: '重命名项目', fields: [{ name: 'n', label: '名称', value: project.name }] }); if (r?.n) ctx.renameProject(project.id, String(r.n)) } },
        ...(hiddenList.length ? [{ sep: true } as MenuItem, { label: `已隐藏的仓库（${hiddenList.length}）`, header: true } as MenuItem, ...hiddenList.slice(0, 8).map((h) => ({ label: `显示 ${base(h)}`, icon: 'eye', onClick: () => ctx.unhideRepo(h) }))] : []),
        { sep: true },
        { label: '关闭项目', icon: 'x', danger: true, onClick: async () => { if (await dialog({ title: '关闭项目', message: `从 GitLoom 中移除项目“${project.name}”？不会删除磁盘上的任何文件。`, okText: '关闭项目', danger: true })) ctx.removeProject(project.id) } }
      ] as MenuItem[] : [])
    ])
  }

  const totals = aggTree?.root.agg
  // ---------------------------------------------------------------- collapsed rail
  if (collapsed) {
    const rail = [...new Set([...pinned, ...recent])].map((p) => repoByPath.get(p)).filter((r): r is DiscoveredRepo => !!r).slice(0, 14)
    return (
      <aside className="sidebar collapsed">
        <div className="brand"><img src={logo} width={24} height={24} alt="" title="展开侧边栏" onClick={onToggle} /></div>
        <button className="rail-btn" title={`项目：${project?.name ?? '无'}`} onClick={(e) => projectMenu(anchorOf(e.currentTarget))}><RepoAvatar name={project?.name ?? '?'} size={28} /></button>
        <button className="rail-btn" title="项目概览" onClick={() => { setScope(null); setView('dashboard') }}><Icon name="dashboard" /></button>
        <div className="rail-sep" />
        <div className="rail-list">
          {rail.map((r) => <button key={r.path} className={`rail-btn ${active === r.path ? 'active' : ''}`} title={`${base(r.path)} · ${summaries[r.path]?.branch ?? ''}`} onClick={() => openRepo(r)}><RepoAvatar name={base(r.path)} worktree={r.kind === 'worktree'} dirty={!!summaries[r.path]?.changes} size={28} /></button>)}
        </div>
        <div className="flex1" />
        <button className="rail-btn" title={`展开侧边栏 (${MOD}+B)`} aria-label="展开侧边栏" onClick={onToggle}><Icon name="sidebar-open" /></button>
        <button className={`rail-btn ${view === 'settings' ? 'active' : ''}`} title="设置" onClick={() => setView('settings')}><Icon name="settings" /></button>
      </aside>
    )
  }

  // ---------------------------------------------------------------- render
  return (
    <aside className="sidebar" style={{ width }}>
      <div className="brand">
        <img src={logo} width={22} height={22} alt="" onDoubleClick={onToggle} />
        <div className="brand-text"><b>GitLoom</b><span>织线</span></div>
        <button className="icon-btn sm" title={`收起侧边栏 (${MOD}+B)`} aria-label="收起侧边栏" onClick={onToggle}><Icon name="sidebar-close" size={15} /></button>
      </div>
      <div className="proj-row">
        <button className="proj-switch" onClick={(e) => projectMenu(anchorOf(e.currentTarget))} title={project ? `${project.root}\n切换 / 管理项目` : '添加项目'} aria-label="切换项目">
          <RepoAvatar name={project?.name ?? '+'} size={26} />
          <span className="proj-meta"><b>{project?.name ?? '没有项目'}</b><small>{project ? project.root : '添加一个文件夹开始'}</small></span>
          <Icon name="chevron-down" size={14} />
        </button>
        <button className="icon-btn sm" title="添加…" aria-label="添加" onClick={(e) => menu(anchorOf(e.currentTarget), [
          { label: '添加项目文件夹（递归扫描）…', icon: 'folder-plus', onClick: addProjectFolder },
          { label: '添加单个仓库到当前项目…', icon: 'plus', onClick: addRepoOnly },
          { label: '克隆仓库…', icon: 'download', onClick: clone }
        ])}><Icon name="plus" size={15} /></button>
      </div>
      {project && <>
        <div className="side-search">
          <Icon name="search" size={13} />
          <input ref={filterRef} placeholder="筛选：名称 / 路径 / 分支" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="筛选仓库"
            onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.focus(); setCursor(rows.find((r) => r.t !== 'section')?.id ?? null) } if (e.key === 'Escape') setQuery('') }} />
          {query && <button className="icon-btn xs" title="清除筛选" aria-label="清除筛选" onClick={() => setQuery('')}><Icon name="x" size={12} /></button>}
        </div>
        <div className="side-tools">
          <div className="seg seg-sm" role="tablist" aria-label="视图模式">
            {MODES.map((m) => <button key={m.id} role="tab" aria-selected={sidebarMode === m.id} className={sidebarMode === m.id ? 'on' : ''} onClick={() => setSidebarMode(m.id)} title={`${m.label}视图`}><Icon name={m.icon} size={13} />{m.label}</button>)}
          </div>
          <div className="flex1" />
          <button className={`icon-btn xs toggle ${changedOnly ? 'on' : ''}`} data-testid="changed-only" aria-pressed={changedOnly} title={changedOnly ? '显示全部仓库' : '只看有改动（未提交改动、冲突、待推送 / 待拉取）'} aria-label="只看有改动" onClick={() => setChangedOnly(!changedOnly)}><Icon name="changes" size={14} /></button>
          <button className="icon-btn xs" title={sidebarMode === 'tree' ? '全部展开' : '全部展开（仅树视图）'} aria-label="全部展开" onClick={expandAll} disabled={sidebarMode !== 'tree'}><Icon name="expand-all" size={14} /></button>
          <button className="icon-btn xs" title={sidebarMode === 'tree' ? '全部折叠' : '全部折叠（仅树视图）'} aria-label="全部折叠" onClick={collapseAll} disabled={sidebarMode !== 'tree'}><Icon name="collapse-all" size={14} /></button>
          <button className="icon-btn xs" title={project.manual ? '扫描文件夹（启用自动发现）' : '重新扫描'} aria-label="重新扫描" onClick={() => rescan()} disabled={!!scan}><Icon name="scan" size={14} /></button>
        </div>
        {scan && (
          <div className="scan-bar" role="status">
            <div className="scan-line"><Spinner size={11} /><span>正在扫描… 已发现 <b>{scan.found}</b> 个仓库 · {scan.dirs} 个文件夹</span><button className="link" onClick={cancelScan}>取消</button></div>
            <div className="scan-path" title={scan.current}>{scan.current.replace(project.root, '…') || ' '}</div>
            <div className="progress indeterminate"><i /></div>
          </div>
        )}
      </>}
      <div className={`tree ${settings?.density === 'compact' ? 'compact' : ''}`} ref={listRef} tabIndex={0} role="tree" aria-label="仓库树"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onKeyDown={onKey}
        onFocus={() => { if (!cursor && rows.length) setCursor(rows[0].id) }}>
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {rows.slice(start, end).map((row, k) => {
            const i = start + k
            const top = i * ROW_H
            const common = { 'data-row': row.id, style: { top, height: ROW_H }, onContextMenu: (e: React.MouseEvent) => rowMenu(e, row) }
            if (row.t === 'section') return (
              <div key={row.id} {...common} className={`tree-section ${cursor === row.id ? 'cursor' : ''}`} onClick={() => { setCursor(row.id); toggleSection(row.id) }} role="treeitem" aria-expanded={row.open}>
                <Icon name="chevron" size={11} className={`chev ${row.open ? 'open' : ''}`} /><Icon name={row.icon} size={12} /><span>{row.label}</span><em>{row.count}</em>
              </div>
            )
            if (row.t === 'note') return <div key={row.id} {...common} className="tree-note">{row.text}</div>
            if (row.t === 'repo') {
              const r = row.repo, s = summaries[r.path]
              const isActive = active === r.path && view !== 'dashboard' && view !== 'allchanges' && view !== 'repos'
              return (
                <div key={row.id} {...common} role="treeitem" aria-selected={isActive}
                  className={`tree-row repo-item ${isActive ? 'active' : ''} ${cursor === row.id ? 'cursor' : ''} ${!r.initialized ? 'uninit' : ''} ${dragOver === row.pinIndex && row.section === 'pinned' ? 'drop' : ''}`}
                  title={repoTitle(r, s)} onClick={() => activate(row)}
                  draggable={row.section === 'pinned'}
                  onDragStart={(e) => { dragFrom.current = row.pinIndex ?? null; e.dataTransfer.effectAllowed = 'move' }}
                  onDragOver={(e) => { if (row.section === 'pinned' && dragFrom.current !== null) { e.preventDefault(); setDragOver(row.pinIndex ?? null) } }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(e) => { e.preventDefault(); if (dragFrom.current !== null && row.pinIndex !== undefined && dragFrom.current !== row.pinIndex) ctx.movePinned(dragFrom.current, row.pinIndex); dragFrom.current = null; setDragOver(null) }}
                  onDragEnd={() => { dragFrom.current = null; setDragOver(null) }}>
                  {row.section === 'pinned' && <span className="grip"><Icon name="grip" size={12} /></span>}
                  <RepoKindIcon repo={r} />
                  <span className="tr-label"><span className="tr-name">{base(r.path)}</span>{row.dir && <span className="tr-dir">{r.outside ? '项目外' : row.dir}</span>}</span>
                  {s?.branch && sidebarMode !== 'tree' && <span className="tr-branch">{s.branch}</span>}
                  <StatusBadges sum={s} repo={r} />
                </div>
              )
            }
            const n = row.node
            const r = n.repo
            const s = r ? summaries[r.path] : undefined
            const isActive = r ? active === r.path && view !== 'dashboard' && view !== 'allchanges' && view !== 'repos' : (view === 'dashboard' || view === 'repos') && ((n.type === 'project' && !scope) || scope === n.path)
            const chain = n.name.includes('/') ? n.name.slice(0, n.name.lastIndexOf('/') + 1) : ''
            const leaf = n.name.slice(chain.length)
            return (
              <div key={row.id} {...common} role="treeitem" aria-expanded={row.hasChildren ? row.expanded : undefined} aria-level={row.depth + 1} aria-selected={isActive}
                className={`tree-row ${r ? 'repo-item' : 'folder-item'} t-${n.type} ${isActive ? 'active' : ''} ${cursor === row.id ? 'cursor' : ''} ${r && !r.initialized ? 'uninit' : ''}`}
                title={r ? repoTitle(r, s) : n.path} onClick={() => activate(row)} onDoubleClick={() => { if (row.hasChildren) toggle(n.id) }}>
                <span className="indent" style={{ width: row.depth * 12 }}>{Array.from({ length: row.depth }, (_, d) => <i key={d} style={{ left: d * 12 + 7 }} />)}</span>
                <span className={`twisty ${row.hasChildren ? '' : 'none'}`} onClick={(e) => { e.stopPropagation(); if (row.hasChildren) toggle(n.id) }}>{row.hasChildren && <Icon name="chevron" size={12} className={`chev ${row.expanded ? 'open' : ''}`} />}</span>
                {n.type === 'project' && !r ? <Icon name="layers" size={14} className="ti ti-project" /> : n.type === 'group' ? <Icon name="link" size={14} className="ti ti-folder" /> : r ? <RepoKindIcon repo={r} /> : <Icon name={row.expanded ? 'folder-open' : 'folder'} size={14} className="ti ti-folder" />}
                <span className="tr-label">
                  {chain && <span className="tr-chain">{chain}</span>}
                  <span className="tr-name">{leaf}</span>
                  {r && s?.branch && !r.outside && <span className="tr-branch">{s.branch}</span>}
                  {r?.outside && <span className="tr-dir">项目外</span>}
                </span>
                {r ? <StatusBadges sum={s} repo={r} agg={row.expanded ? undefined : n.agg} /> : <StatusBadges agg={n.agg} rolled />}
                {r && !row.expanded && row.hasChildren && n.agg.repos > 1 && <span className="bdg bdg-muted" title={`含 ${n.agg.repos - 1} 个嵌套仓库`}>+{n.agg.repos - 1}</span>}
              </div>
            )
          })}
        </div>
        {!project && <div className="side-empty"><p>还没有项目。</p><button className="btn btn-sm btn-primary" onClick={addProjectFolder}><Icon name="folder-plus" size={14} />添加项目文件夹</button></div>}
      </div>
      <div className="side-foot">
        {totals && <span className="sf-stats" title="当前项目汇总">{totals.repos} 个仓库{totals.dirty ? <> · <b className="c-mod">{totals.dirty}</b> 有改动</> : null}{totals.conflicts ? <> · <b className="c-conf">{totals.conflicts}</b> 冲突</> : null}</span>}
        {changedOnly && <button className="sf-filter" onClick={() => setChangedOnly(false)} title="点击显示全部仓库">只看有改动 ×</button>}
        <div className="flex1" />
        <button className="icon-btn xs" data-testid="badge-legend" aria-label="徽标说明" title={BADGE_LEGEND}><Icon name="info" size={13} /></button>
      </div>
      <div className="side-resizer"><Resizer onResize={(d) => setWidth((w) => Math.max(232, Math.min(560, w + d)))} /></div>
    </aside>
  )
}
