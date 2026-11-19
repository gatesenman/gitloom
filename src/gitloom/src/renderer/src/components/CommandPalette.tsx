// Command palette (Ctrl/⌘+K) and quick-open repo (Ctrl/⌘+P) sharing one fuzzy-ranked overlay.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { DiscoveredRepo } from '@shared/types'
import { useApp, type View } from '../state'
import { app, git } from '../api'
import { Icon } from './Icon'
import { Kbd, MOD } from './ui'
import { RepoKindIcon, StatusBadges } from './RepoBits'
import { fuzzyScore } from '../lib/tree'
import { PRIMARY, BRANCH_SECTIONS, ADVANCED, storyOf, MODULES } from '../lib/nav'
import { resetIntros, knownSubmoduleCount } from './NavBits'

const RECENT_KEY = 'gitloom.palette.recent'
function pushRecent(id: string) {
  try {
    const cur: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...cur.filter((x) => x !== id)].slice(0, 12)))
  } catch { /* */ }
}
function readRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') } catch { return [] }
}
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const emit = (name: string, detail: string) => window.dispatchEvent(new CustomEvent(name, { detail }))

interface Item { id: string; group: string; label: string; icon: string; hint?: string[]; run: () => void; repo?: DiscoveredRepo; sub?: string; project?: string; score?: number; kw?: string }

export function CommandPalette({ mode, onMode, onClose, onToggleSidebar, onToggleLog }: { mode: 'commands' | 'repos'; onMode: (m: 'commands' | 'repos') => void; onClose: () => void; onToggleSidebar: () => void; onToggleLog: () => void }) {
  const c = useApp()
  const { projects, project, active, setActive, setView, run, theme, settings, saveSettings, summaries, recent, pinned, setScope, setSidebarMode } = c
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { input.current?.focus() }, [mode])
  useEffect(() => { const h = (e: Event) => setQ((e as CustomEvent).detail as string); window.addEventListener('gitloom:palette', h); return () => window.removeEventListener('gitloom:palette', h) }, [])

  const repoItems = useMemo<Item[]>(() => {
    const out: Item[] = []
    for (const p of projects) for (const r of p.repos) {
      if (!r.initialized || p.hidden.includes(r.path)) continue
      out.push({
        id: `r-${p.id}-${r.path}`, group: p.id === project?.id ? '仓库' : `其它项目 · ${p.name}`, label: base(r.path), sub: r.outside ? r.path : r.rel || '（项目根）', icon: 'repo', repo: r, project: p.id,
        run: () => { if (p.id !== project?.id) c.setActiveProject(p.id); setActive(r.path); setView(r.kind === 'bare' ? 'history' : c.view === 'dashboard' || c.view === 'allchanges' || c.view === 'repos' || c.view === 'settings' ? 'changes' : c.view) }
      })
    }
    return out
  }, [projects, project?.id, setActive, setView, c])

  const commandItems = useMemo<Item[]>(() => {
    const list: Item[] = [
      { id: 'q-open', group: '工作区', label: '快速打开仓库…', icon: 'search', hint: ['Mod', 'P'], run: () => { onMode('repos'); setQ('') } },
      { id: 'w-dash', group: '工作区', label: '打开「工作区概览」', icon: 'dashboard', hint: ['Mod', '0'], run: () => { setScope(null); setView('dashboard') } },
      { id: 'w-cross', group: '工作区', label: '打开「跨仓变更」', icon: 'layers', run: () => setView('allchanges') },
      { id: 'w-repos', group: '工作区', label: '打开「仓库与扫描」', icon: 'scan', run: () => setView('repos') },
      { id: 'w-fetch', group: '工作区', label: '批量：抓取项目中的全部仓库', icon: 'fetch', run: () => { setScope(null); setView('dashboard'); setTimeout(() => emit('gitloom:dashboard', 'fetch-all'), 80) } },
      { id: 'w-status', group: '工作区', label: '批量：在全部仓库运行 git status -sb', icon: 'terminal', run: () => { setScope(null); setView('dashboard'); setTimeout(() => emit('gitloom:dashboard', 'status-all'), 80) } },
      { id: 'w-add', group: '项目', label: '添加项目文件夹（递归扫描）…', icon: 'folder-plus', run: async () => { const d = await app.pickFolder('选择项目文件夹'); if (d) await c.addProject(d) } },
      ...(project ? [{ id: 'w-rescan', group: '项目', label: `重新扫描「${project.name}」`, icon: 'scan', run: () => c.rescan() } as Item] : []),
      ...(c.scan ? [{ id: 'w-cancel', group: '项目', label: '取消正在进行的扫描', icon: 'stop', run: () => c.cancelScan() } as Item] : []),
      ...projects.filter((p) => p.id !== project?.id).map((p) => ({ id: `p-${p.id}`, group: '项目', label: `切换到项目「${p.name}」`, sub: p.root, icon: 'layers', run: () => c.setActiveProject(p.id) } as Item)),
      { id: 's-tree', group: '侧边栏', label: '侧边栏：树视图', icon: 'tree', run: () => setSidebarMode('tree') },
      { id: 's-flat', group: '侧边栏', label: '侧边栏：列表视图', icon: 'list', run: () => setSidebarMode('flat') },
      { id: 's-status', group: '侧边栏', label: '侧边栏：按状态分组', icon: 'grouped', run: () => setSidebarMode('status') },
      { id: 's-expand', group: '侧边栏', label: '全部展开', icon: 'expand-all', run: () => emit('gitloom:sidebar', 'expand-all') },
      { id: 's-collapse', group: '侧边栏', label: '全部折叠', icon: 'collapse-all', run: () => emit('gitloom:sidebar', 'collapse-all') },
      { id: 's-filter', group: '侧边栏', label: '筛选仓库', icon: 'search', hint: ['Mod', 'Shift', 'F'], run: () => emit('gitloom:sidebar', 'focus-filter') },
      { id: 's-focus', group: '侧边栏', label: '聚焦仓库树（方向键导航）', icon: 'tree', hint: ['Mod', 'Shift', 'E'], run: () => emit('gitloom:sidebar', 'focus-tree') },
      ...PRIMARY.map((n, i) => ({ id: `v-${n.id}`, group: '跳转', label: `打开「${n.label}」`, sub: n.tip, icon: n.icon, hint: ['Mod', String(i + 1)], run: () => setView(n.id) } as Item)),
      { id: 'v-graph', group: '跳转', label: '打开「历史 · 提交图」', sub: '所有分支的提交图谱（原「分支图」）', icon: 'graph', kw: 'graph 分支图', run: () => setView('graph') },
      ...BRANCH_SECTIONS.filter((b) => b.id !== 'branches').map((b) => ({ id: `v-${b.id}`, group: '跳转', label: `打开「分支 · ${b.label}」`, sub: b.tip, icon: b.icon, kw: b.id, run: () => setView(b.id) } as Item)),
      ...ADVANCED.filter((a) => !a.needsSubmodules || (knownSubmoduleCount(active) ?? 0) > 0).map((a) => ({ id: `v-${a.id}`, group: '日常 Git', label: a.label, sub: a.desc, icon: a.icon, kw: `${a.short} ${a.keywords}`, run: () => setView(a.id) } as Item)),
      { id: 'v-hooks', group: '自动化', label: 'Git 钩子（设置 → 当前仓库）', sub: storyOf('hooks')?.desc, icon: 'hook', kw: 'hooks pre-commit pre-push commit-msg 钩子 lint', run: () => setView('hooks') },
      { id: 'v-intros', group: '界面', label: '重新显示功能简介', icon: 'info', kw: 'intro help 帮助 说明', run: () => resetIntros() },
      ...MODULES.map((m) => ({ id: `m-${m.id}`, group: '模块', label: `模块：${m.label}`, sub: m.tip, icon: m.icon, kw: `${m.id} module 模块 ${m.id === 'workspace' ? '概览 跨仓变更 跨仓库变更 仓库与扫描 dashboard allchanges repos' : ''}${m.id === 'automation' ? 'automation 模板 运行记录 日志' : ''}${m.id === 'understand' ? '变更可视化 viz' : ''}${m.id === 'quality' ? 'review 审查 semgrep ocr 检查' : ''}${m.id === 'knowledge' ? 'wiki llmwiki 架构 知识图谱 现状' : ''}`, run: () => setView(m.home) } as Item)),
      { id: 'v-summary', group: '看懂改动', label: '改动摘要', sub: '全局摘要 → 影响模块 → 逐文件（只服务某次 diff）', icon: 'viz', kw: 'summary 摘要 看懂 风险', run: () => setView('summary') } as Item,
      { id: 'v-viz', group: '看懂改动', label: '变更可视化（前后对比图）', sub: '只属于看懂改动，日常 Git 无此入口', icon: 'viz', kw: 'viz 可视化 变更可视化 架构图 依赖图', run: () => setView('viz') } as Item,
      { id: 'v-architecture', group: '视图', label: '架构与知识', sub: '页内 C4 / HEAD 架构图 / Wiki / 知识图谱（当前现状，不服务某次 diff）', icon: 'book', kw: 'c4 architecture 架构 wiki 知识图谱', run: () => setView('knowledge') } as Item,
      { id: 'v-settings', group: '跳转', label: '打开「设置」', icon: 'settings', hint: ['Mod', ','], run: () => setView('settings') }
    ]
    if (active) {
      const isPinned = pinned.includes(active)
      list.push(
        { id: 'a-fetch', group: '当前仓库', label: '抓取（git fetch --all）', icon: 'fetch', run: () => run('抓取', () => git.fetch(active), '抓取完成') },
        { id: 'a-pull', group: '当前仓库', label: '拉取（git pull）', icon: 'pull', run: () => run('拉取', () => git.pull(active), '拉取完成') },
        { id: 'a-pullff', group: '当前仓库', label: '拉取（仅快进 --ff-only）', icon: 'pull', run: () => run('拉取', () => git.pull(active, false, true), '拉取完成') },
        { id: 'a-push', group: '当前仓库', label: '推送（git push）', icon: 'push', run: () => run('推送', () => git.push(active), '推送完成') },
        { id: 'a-pin', group: '当前仓库', label: isPinned ? '取消固定当前仓库' : '固定当前仓库', icon: isPinned ? 'unpin' : 'pin', run: () => c.togglePin(active) },
        { id: 'a-code', group: '当前仓库', label: '在编辑器中打开', icon: 'code', run: () => window.api.openInEditor(active) },
        { id: 'a-term', group: '当前仓库', label: '在终端中打开', icon: 'terminal', run: () => window.api.openTerminal(active) },
        { id: 'a-files', group: '当前仓库', label: '在文件管理器中打开', icon: 'folder-open', run: () => window.api.openPath(active) }
      )
    }
    list.push(
      { id: 'u-theme', group: '界面', label: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题', icon: theme === 'dark' ? 'sun' : 'moon', run: () => settings && saveSettings({ ...settings, theme: theme === 'dark' ? 'light' : 'dark' }) },
      { id: 'u-density', group: '界面', label: settings?.density === 'compact' ? '密度：切换为舒适' : '密度：切换为紧凑', icon: settings?.density === 'compact' ? 'density-comfortable' : 'density-compact', run: () => settings && saveSettings({ ...settings, density: settings.density === 'compact' ? 'comfortable' : 'compact' }) },
      { id: 'u-side', group: '界面', label: '收起 / 展开侧边栏', icon: 'sidebar-close', hint: ['Mod', 'B'], run: onToggleSidebar },
      { id: 'u-log', group: '界面', label: '显示 Git 命令日志', icon: 'log', run: onToggleLog }
    )
    return list
  }, [projects, project, active, pinned, theme, settings, saveSettings, setView, setScope, setSidebarMode, run, onToggleSidebar, onToggleLog, onMode, c])

  const shown = useMemo(() => {
    const ql = q.trim()
    if (mode === 'repos') {
      if (!ql) {
        const order = new Map([...recent, ...pinned].map((p, i) => [p, i]))
        return [...repoItems].sort((a, b) => (order.get(a.repo!.path) ?? 1e6) - (order.get(b.repo!.path) ?? 1e6) || (a.group === b.group ? a.sub!.localeCompare(b.sub!) : a.group === '仓库' ? -1 : 1))
          .map((it) => (order.has(it.repo!.path) && it.group === '仓库' ? { ...it, group: '最近' } : it)).slice(0, 300)
      }
      return repoItems.map((it) => ({ ...it, score: Math.max(((l) => l < 0 ? -1 : l + 300)(fuzzyScore(ql, it.label)), fuzzyScore(ql, `${it.sub} ${summaries[it.repo!.path]?.branch ?? ''}`)) }))
        .filter((it) => it.score! >= 0).sort((a, b) => b.score! - a.score!)
        .filter((it, _, arr) => arr[0].score! < 500 || it.score! >= 200) // contiguous matches exist → drop scattered ones
        .map((it) => ({ ...it, group: '匹配的仓库' })).slice(0, 200)
    }
    if (!ql) {
      const recentIds = readRecent()
      const byId = new Map(commandItems.map((it) => [it.id, it]))
      const recentItems = recentIds.map((id) => byId.get(id)).filter(Boolean).map((it) => ({ ...it!, group: '最近' }))
      // context suggestions
      const suggested: Item[] = []
      const st = active ? summaries[active] : undefined
      if (st?.conflicts) suggested.push({ id: 'sug-conflict', group: '建议', label: '有冲突 — 打开变更视图解决', icon: 'warn', run: () => setView('changes') })
      if (st?.operation === 'REBASING') suggested.push({ id: 'sug-rebase', group: '建议', label: '正在变基 — 打开交互式变基继续/中止', icon: 'rebase', run: () => setView('rebase') })
      if (st?.operation === 'BISECTING') suggested.push({ id: 'sug-bisect', group: '建议', label: '正在二分 — 打开二分视图', icon: 'bisect', run: () => setView('bisect') })
      if ((st?.ahead ?? 0) > 0) suggested.push({ id: 'sug-push', group: '建议', label: `领先 ${st!.ahead} — 推送当前仓库`, icon: 'push', run: () => active && run('推送', () => git.push(active), '推送完成') })
      if ((st?.behind ?? 0) > 0) suggested.push({ id: 'sug-pull', group: '建议', label: `落后 ${st!.behind} — 快进拉取`, icon: 'pull', run: () => active && run('拉取', () => git.pull(active, false, true), '拉取完成') })
      if ((st?.changes ?? 0) > 0) suggested.push({ id: 'sug-ai', group: '建议', label: '有改动 — 打开 AI 对话生成提交信息', icon: 'ai', run: () => setView('ai') })
      const rest = commandItems.filter((it) => !recentIds.includes(it.id) && !suggested.some((s) => s.id === it.id))
      return [...suggested, ...recentItems, ...rest]
    }
    const cmds = commandItems.map((it) => ({ ...it, score: fuzzyScore(ql, `${it.label} ${it.group} ${it.kw ?? ''}`) })).filter((it) => it.score! >= 0).sort((a, b) => b.score! - a.score!)
    const repos = repoItems.map((it) => ({ ...it, group: '切换仓库', score: fuzzyScore(ql, `${it.label} ${it.sub}`) })).filter((it) => it.score! >= 0).sort((a, b) => b.score! - a.score!).slice(0, 8)
    return [...cmds.map((x) => ({ ...x, group: '命令' })), ...repos]
  }, [q, mode, repoItems, commandItems, recent, pinned, summaries])
  useEffect(() => setIdx(0), [q, mode])
  useEffect(() => { listRef.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' }) }, [idx])
  const exec = (it?: Item) => { if (!it) return; pushRecent(it.id); onClose(); it.run() }
  let lastGroup = ''
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`palette ${mode === 'repos' ? 'palette-repos' : ''}`} role="dialog" aria-label={mode === 'repos' ? '快速打开仓库' : '命令面板'} onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
        else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(shown.length - 1, i + 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)) }
        else if (e.key === 'PageDown') { e.preventDefault(); setIdx((i) => Math.min(shown.length - 1, i + 8)) }
        else if (e.key === 'PageUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 8)) }
        else if (e.key === 'Enter') exec(shown[idx])
        else if (e.key === 'Tab') { e.preventDefault(); onMode(mode === 'repos' ? 'commands' : 'repos') }
      }}>
        <div className="palette-input">
          <Icon name={mode === 'repos' ? 'repo' : 'command'} size={17} />
          <input ref={input} placeholder={mode === 'repos' ? `快速打开仓库：名称、路径或分支（${repoItems.length} 个仓库）` : '输入命令、视图或仓库名…'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索" />
          <span className="pal-mode"><button className={mode === 'repos' ? 'on' : ''} onClick={() => onMode('repos')}>仓库 <Kbd keys={['Mod', 'P']} /></button><button className={mode === 'commands' ? 'on' : ''} onClick={() => onMode('commands')}>命令 <Kbd keys={['Mod', 'K']} /></button></span>
        </div>
        <div className="palette-list" ref={listRef}>
          {!shown.length && <div className="hint pad">没有匹配“{q}”的{mode === 'repos' ? '仓库' : '命令'}</div>}
          {shown.map((it, i) => {
            const head = it.group !== lastGroup ? (lastGroup = it.group, <div className="palette-group">{it.group}</div>) : null
            const s = it.repo ? summaries[it.repo.path] : undefined
            return (
              <React.Fragment key={it.id}>
                {head}
                <div className={`palette-item ${i === idx ? 'on' : ''}`} onMouseMove={() => setIdx(i)} onClick={() => exec(it)}>
                  {it.repo ? <RepoKindIcon repo={it.repo} size={16} /> : <Icon name={it.icon} size={16} />}
                  <span className="pl-label"><span className="pl-main">{it.repo ? <Hl text={it.label} q={q} /> : it.label}</span>{it.sub && <span className="pl-sub">{it.repo ? <Hl text={it.sub} q={q} /> : it.sub}</span>}</span>
                  {s?.branch && <span className="pl-branch"><Icon name="branch" size={11} />{s.branch}</span>}
                  {s && <StatusBadges sum={s} repo={it.repo} />}
                  {it.hint && <Kbd keys={it.hint} />}
                </div>
              </React.Fragment>
            )
          })}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> {mode === 'repos' ? '打开' : '执行'}</span><span><kbd>Tab</kbd> 切换 仓库/命令</span><span><kbd>Esc</kbd> 关闭</span><div className="flex1" /><span>{MOD === '⌘' ? '⌘P 仓库 · ⌘K 命令' : 'Ctrl+P 仓库 · Ctrl+K 命令'}</span></div>
      </div>
    </div>
  )
}

/** Highlight fuzzy-matched characters. */
function Hl({ text, q }: { text: string; q: string }) {
  const tok = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tok.length) return <>{text}</>
  const marks = new Array(text.length).fill(false)
  const t = text.toLowerCase()
  for (const k of tok) {
    const i = t.indexOf(k)
    if (i >= 0) { for (let j = i; j < i + k.length; j++) marks[j] = true; continue }
    let from = 0
    for (const ch of k) { const f = t.indexOf(ch, from); if (f < 0) break; marks[f] = true; from = f + 1 }
  }
  const out: React.ReactNode[] = []
  let buf = '', on = false
  text.split('').forEach((ch, i) => { if (marks[i] !== on) { if (buf) out.push(on ? <mark key={i}>{buf}</mark> : buf); buf = ''; on = marks[i] } buf += ch })
  if (buf) out.push(on ? <mark key="e">{buf}</mark> : buf)
  return <>{out}</>
}
