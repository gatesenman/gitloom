import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { useApp, type View } from '../state'
import { Icon } from '../components/Icon'
import { git, errMsg, app as appApi, health } from '../api'
import { useToast, Spinner } from '../components/ui'
import { useAIRunner, useRunState } from '../hooks/useAIRun'
import { AIDrawer } from '../components/AIResult'
import { parkViz } from '../lib/vizNav'
import type { BranchInfo, HookTemplate } from '@shared/types'

/** Keep Knowledge/Quality shells light — do not sync-pull Monaco/xyflow/health/Tasks into the hub chunk. */
const TasksPanel = lazy(() => import('./TasksPanel'))
const ArchitectureView = lazy(() => import('./UnderstandViews').then((m) => ({ default: m.ArchitectureView })))
const HealthReportPanel = lazy(() => import('./health/HealthReportPanel').then((m) => ({ default: m.HealthReportPanel })))
const DesignReviewPanel = lazy(() => import('./health/DesignReviewPanel').then((m) => ({ default: m.DesignReviewPanel })))
const KnowledgeGraphPanel = lazy(() => import('./knowledge/KnowledgeGraphPanel').then((m) => ({ default: m.KnowledgeGraphPanel })))
const ArchGraphEmbed = lazy(() => import('./knowledge/ArchGraphEmbed').then((m) => ({ default: m.ArchGraphEmbed })))

function HubPanelFallback({ label }: { label: string }) {
  return (
    <div className="us-loading" data-testid="hub-panel-loading" role="status" aria-live="polite">
      <Spinner size={14} /><span>加载{label}…</span>
    </div>
  )
}

/** 0.6.3: module landing pages are destinations — embed real content; cross-module only as secondary links. */
interface Card { icon: string; title: string; desc: string; action?: string; tip?: string; onClick?: () => void; planned?: string; needsRepo?: boolean; testid?: string; secondary?: boolean }

const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

function Hub({ icon, title, lead, cards, children, id }: { icon: string; title: string; lead: string; cards: Card[]; children?: React.ReactNode; id: string }) {
  const { active } = useApp()
  const primary = cards.filter((c) => !c.secondary)
  const secondary = cards.filter((c) => c.secondary)
  return (
    <div className="mod-hub" data-testid={`mod-hub-${id}`}>
      <div className="mod-hub-head"><span className="mod-hub-ic"><Icon name={icon} size={22} /></span><div><h2>{title}</h2><p>{lead}</p></div></div>
      {primary.length > 0 && (
        <div className="mod-hub-grid">
          {primary.map((c) => {
            const off = !!c.planned || (c.needsRepo && !active)
            return (
              <div key={c.title} className={`mod-hub-card ${c.planned ? 'planned' : ''}`} data-testid={c.testid}>
                <div className="hc-top"><Icon name={c.icon} size={16} /><b>{c.title}</b>{c.planned && <em className="hc-tag" title="按路线图后续版本提供">规划中 · {c.planned}</em>}</div>
                <p>{c.desc}</p>
                {c.action && <div className="hc-act"><button className="btn btn-sm" disabled={off} onClick={c.onClick} title={c.needsRepo && !active ? '先在左侧选择一个仓库' : c.tip ?? c.desc}>{c.action}</button></div>}
              </div>
            )
          })}
        </div>
      )}
      {children}
      {secondary.length > 0 && (
        <div className="mod-hub-related" data-testid={`mod-hub-related-${id}`}>
          <span className="muted small">相关能力</span>
          {secondary.map((c) => (
            <button key={c.title} className="link small" disabled={!!(c.needsRepo && !active)} onClick={c.onClick} title={c.tip ?? c.desc} data-testid={c.testid}>
              {c.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function useGo() {
  const { setView } = useApp()
  return {
    view: (v: View) => setView(v),
    /** Open viz under 看懂改动 (module highlight will switch — only for secondary links). */
    viz: (tab: string) => { sessionStorage.setItem('gitloom.tab', `viz-${tab}`); setView('viz'); setTimeout(() => sessionStorage.removeItem('gitloom.tab'), 800) },
    /** @deprecated 0.6.5：架构图已内嵌 KnowledgeView，禁止再 setView('architecture-graph') */
    tools: (tab: string) => { localStorage.setItem('gitloom.tools.tab', JSON.stringify(tab)); setView('tools') }
  }
}

// ── Wiki panel (project-local) ──
type WikiStatus = {
  projectId: string; root: string; exists: boolean
  pages: { path: string; title: string; summary?: string }[]
  settings: { enabledAuto: boolean; dailyTokenCap: number }
  legacyDir?: string
}

function WikiPanel() {
  const { project, active, setView, settings } = useApp()
  const toast = useToast()
  const [st, setSt] = useState<WikiStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')
  const [editRel, setEditRel] = useState<string | undefined>(undefined)
  const [msg, setMsg] = useState<string | null>(null)
  const [askQ, setAskQ] = useState('')
  const [askAns, setAskAns] = useState<string | null>(null)
  const [askHits, setAskHits] = useState<{ path: string; title: string; snippet: string }[]>([])
  const [autoOn, setAutoOn] = useState(false)
  const [tokenCap, setTokenCap] = useState(200000)
  const root = project?.root

  const refresh = useCallback(async () => {
    if (!root || !window.api.wikiStatus) { setSt(null); return }
    try {
      const s = await window.api.wikiStatus(root, active ?? undefined) as WikiStatus
      setSt(s)
      setAutoOn(!!s.settings?.enabledAuto)
      setTokenCap(s.settings?.dailyTokenCap ?? 200000)
    } catch (e) { setMsg(errMsg(e)) }
  }, [root, active])

  useEffect(() => { void refresh() }, [refresh])

  if (!project || !root) {
    return (
      <section className="mod-hub-sec" id="wiki-panel" data-testid="wiki-panel">
        <div className="mod-hub-sec-head"><b>项目 Wiki</b><span className="muted">本地知识库 · 不进仓库</span></div>
        <p className="muted">先打开一个项目文件夹，才能在本机建立项目级 Wiki（保存在应用数据目录，不会提交进 Git）。</p>
      </section>
    )
  }

  const ensure = async () => {
    setBusy(true); setMsg(null)
    try { setSt(await window.api.wikiEnsure(root) as WikiStatus); toast('ok', '已建立项目 Wiki') }
    catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }
  const openPage = async (rel: string) => {
    try {
      const r = await window.api.wikiRead(root, rel) as { path: string; content: string }
      setPreview(r); setEditing(false)
      setEditRel(r.path); setEditBody(r.content)
      const m = /^#\s+(.+)$/m.exec(r.content)
      setEditTitle(m ? m[1].trim() : r.path)
    } catch (e) { toast('err', errMsg(e)) }
  }
  const startNew = () => {
    setPreview(null); setEditing(true); setEditRel(undefined)
    setEditTitle('新页面'); setEditBody('# 新页面\n\n')
  }
  const savePage = async () => {
    if (!editTitle.trim()) { toast('err', '请填写标题'); return }
    setBusy(true)
    try {
      const r = await window.api.wikiWrite(root, {
        rel: editRel, title: editTitle.trim(), content: editBody
      }) as { path: string }
      toast('ok', editRel ? '已保存' : '已新建页面')
      await refresh()
      await openPage(r.path)
      setEditing(false)
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }
  const saveAskAsPage = async () => {
    if (!askAns?.trim()) return
    setBusy(true)
    try {
      const title = (askQ.trim() || '百科问答').slice(0, 60)
      const body = `# ${title}\n\n> 由「问百科」保存\n\n${askAns.trim()}\n`
      const r = await window.api.wikiWrite(root, { title, content: body, summary: askAns.trim().slice(0, 80) }) as { path: string }
      toast('ok', '已存为新页')
      await refresh()
      await openPage(r.path)
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }
  const saveSettings = async (patch: { enabledAuto?: boolean; dailyTokenCap?: number }) => {
    try {
      const s = await window.api.wikiSaveSettings(root, patch) as WikiStatus['settings']
      setAutoOn(!!s.enabledAuto)
      setTokenCap(s.dailyTokenCap)
      toast('ok', 'Wiki 设置已保存')
      await refresh()
    } catch (e) { toast('err', errMsg(e)) }
  }
  const reveal = async () => {
    try {
      await window.api.wikiReveal(root)
    } catch (e) {
      // fallback: openPath on root from status
      if (st?.root) window.api.openPath(st.root)
      else toast('err', errMsg(e))
    }
  }
  const ingest = async () => {
    if (!active) { toast('err', '请先在左侧选择一个仓库，再吸收它的最近提交'); return }
    setBusy(true); setMsg(null)
    try {
      const r = await window.api.wikiIngest(root, active, 10) as { page: string; usedAi: boolean; message: string }
      setMsg(r.message)
      await refresh()
      if (r.page) await openPage(r.page)
      toast('ok', r.message)
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }
  const migrate = async () => {
    if (!st?.legacyDir) return
    setBusy(true)
    try {
      const r = await window.api.wikiMigrate(root, st.legacyDir) as { copied: number; message: string }
      toast('ok', r.message); await refresh()
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }
  const hasAi = !!(settings?.ai && ((settings.ai.profiles?.length ?? 0) > 0 || settings.ai.baseUrl))

  const askWiki = async () => {
    if (!root || !askQ.trim()) return
    setBusy(true); setAskAns(null)
    try {
      const r = await window.api.wikiQuery(root, askQ.trim()) as { answer: string; usedAi: boolean; hits: { path: string; title: string; snippet: string }[] }
      setAskAns((r.usedAi ? '' : '（全文搜索）\n') + r.answer)
      setAskHits(r.hits || [])
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }

  return (
    <section className="mod-hub-sec" id="wiki-panel" data-testid="wiki-panel">
      <div className="mod-hub-sec-head">
        <b title="项目级、仅保存在本机应用数据目录；不进入任何 Git 仓库">项目 Wiki</b>
        <span className="muted">本地 · 可新建 / 编辑</span>
        <div className="flex1" />
        {!st?.exists
          ? <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void ensure()} data-testid="wiki-ensure" title="在本机应用数据目录创建 Wiki 骨架">{busy ? <Spinner size={12} /> : null}建立 Wiki</button>
          : <>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={startNew} data-testid="wiki-new" title="新建 Markdown 页面">新建页面</button>
            <button className="btn btn-sm" disabled={busy || !active} onClick={() => void ingest()} data-testid="wiki-ingest" title={hasAi ? '用规则化摘要 + AI 吸收最近提交' : '无 AI 时写规则化摘要'}>{busy ? <Spinner size={12} /> : <Icon name="ai" size={13} />}吸收最近提交</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => void reveal()} data-testid="wiki-reveal" title="在文件管理器中打开 Wiki 目录"><Icon name="folder" size={13} />打开目录</button>
            <button className="btn btn-sm btn-ghost" onClick={() => void refresh()} title="刷新页面列表"><Icon name="refresh" size={13} /></button>
          </>}
      </div>
      {st && (
        <p className="muted small" data-testid="wiki-meta">
          {st.exists ? <>已建库 · 项目 ID <code>{st.projectId}</code> · {st.pages.length} 页</> : <>尚未建库 · 将创建于应用数据目录</>}
          {!hasAi && st.exists && <> · <button className="link" onClick={() => setView('settings')}>配置 AI</button> 后可生成 AI 摘要</>}
        </p>
      )}
      {st?.exists && (
        <div className="row gap" style={{ flexWrap: 'wrap', marginBottom: 8 }} data-testid="wiki-settings">
          <label className="check" title="开启后，自动化「事件触发」里配置的 Wiki 规则可在拉取等成功后轻量吸收">
            <input type="checkbox" checked={autoOn} onChange={(e) => { setAutoOn(e.target.checked); void saveSettings({ enabledAuto: e.target.checked }) }} data-testid="wiki-auto" />
            自动更新
          </label>
          <label className="inline-field" title="每日 token 上限（有 AI 时生效）">每日 token 上限
            <input type="number" min={0} step={1000} value={tokenCap} style={{ width: 100 }}
              onChange={(e) => setTokenCap(Number(e.target.value) || 0)}
              onBlur={() => void saveSettings({ dailyTokenCap: tokenCap })}
              data-testid="wiki-token-cap" />
          </label>
        </div>
      )}
      {msg && <p className="muted small">{msg}</p>}
      {st?.legacyDir && (
        <p className="muted small" data-testid="wiki-legacy">
          发现旧版 <code>docs/llmwiki</code>。
          <button className="link" disabled={busy} onClick={() => void migrate()} data-testid="wiki-migrate">迁移复制到项目 Wiki</button>
          （不删除原文件）
        </p>
      )}
      {st?.exists && (
        <div className="wiki-layout">
          <ul className="wiki-list" data-testid="wiki-list">
            {st.pages.length === 0 && <li className="muted">还没有页面。点「新建页面」或「吸收最近提交」。</li>}
            {st.pages.map((pg) => (
              <li key={pg.path}>
                <button className={`link ${preview?.path === pg.path ? 'on' : ''}`} onClick={() => void openPage(pg.path)} title={pg.path}>
                  {pg.title}{pg.summary ? <span className="muted"> — {pg.summary}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {(preview || editing) && (
            <div className="wiki-preview" data-testid="wiki-preview">
              <div className="wiki-preview-h">
                <b>{editing ? (editRel ? '编辑' : '新建') : preview?.path}</b>
                <div className="flex1" />
                {!editing && preview && (
                  <button className="btn btn-xs" onClick={() => { setEditing(true); setEditRel(preview.path); setEditBody(preview.content) }} data-testid="wiki-edit">编辑</button>
                )}
                {editing && (
                  <button className="btn btn-xs btn-primary" disabled={busy} onClick={() => void savePage()} data-testid="wiki-save">保存</button>
                )}
                <button className="btn btn-xs btn-ghost" onClick={() => { setPreview(null); setEditing(false) }}>关闭</button>
              </div>
              {editing ? (
                <div className="col gap" style={{ padding: 8 }}>
                  <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="标题" data-testid="wiki-edit-title" />
                  <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={16} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 13 }} data-testid="wiki-edit-body" />
                </div>
              ) : (
                <pre className="wiki-md">{preview?.content}</pre>
              )}
            </div>
          )}
        </div>
      )}
      {st?.exists && (
        <div className="wiki-ask" data-testid="wiki-ask" style={{ marginTop: 12 }}>
          <div className="mod-hub-sec-head" style={{ marginBottom: 6 }}>
            <b title="读取 index 与相关页后回答；无 AI 时全文搜索">问百科</b>
            <span className="muted">本地 Wiki 问答</span>
          </div>
          <div className="row gap" style={{ flexWrap: 'wrap' }}>
            <input className="flex1" style={{ minWidth: 200 }} placeholder="例如：这个项目的模块怎么划分？" value={askQ}
              onChange={(e) => setAskQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void askWiki() }}
              data-testid="wiki-ask-input" title="输入问题后回车或点提问" />
            <button className="btn btn-sm btn-primary" disabled={busy || !askQ.trim()} onClick={() => void askWiki()} data-testid="wiki-ask-go">
              {busy ? <Spinner size={12} /> : '提问'}
            </button>
          </div>
          {askAns && (
            <div className="wiki-ask-ans" data-testid="wiki-ask-ans" style={{ marginTop: 8 }}>
              <div className="row gap" style={{ marginBottom: 6 }}>
                <button className="btn btn-sm" disabled={busy} onClick={() => void saveAskAsPage()} data-testid="wiki-save-ask" title="把本次答案写入 pages 并更新 index/log">存为新页</button>
              </div>
              <pre className="wiki-md" style={{ whiteSpace: 'pre-wrap' }}>{askAns}</pre>
              {askHits.length > 0 && (
                <ul className="wiki-list">{askHits.map((h) => (
                  <li key={h.path}><button className="link small" onClick={() => void openPage(h.path)} title={h.path}>{h.title}</button>
                    {h.snippet ? <span className="muted small"> — {h.snippet}</span> : null}</li>
                ))}</ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function LlmwikiEmbed() {
  const { active, run, settings, setView } = useApp()
  const toast = useToast()
  const [wikiDir, setWikiDir] = useState('docs/llmwiki')
  const [tpl, setTpl] = useState<HookTemplate | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!active) return
    void git.hookTemplates().then((list) => setTpl(list.find((t) => t.id === 'llmwiki') || null))
    void git.config(active, 'llmwiki.dir').then((d) => setWikiDir(d || 'docs/llmwiki'))
  }, [active])
  if (!active) {
    return (
      <section className="mod-hub-sec" id="k-llmwiki" data-testid="k-llmwiki">
        <div className="mod-hub-sec-head"><b>旧版 llmwiki 钩子</b><span className="muted">仓库内 docs/llmwiki</span></div>
        <p className="muted">选择仓库后可在此安装 post-commit 模板、修改输出目录。</p>
      </section>
    )
  }
  const install = async () => {
    if (!tpl) return
    setBusy(true)
    try {
      await run('安装 llmwiki', () => git.installHookTemplate(active, 'llmwiki'), '已安装 llmwiki post-commit')
      await run('保存配置', () => git.setConfig(active, 'llmwiki.dir', wikiDir || 'docs/llmwiki'))
      toast('ok', `已安装到 post-commit · 输出 ${wikiDir || 'docs/llmwiki'}`)
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }
  return (
    <section className="mod-hub-sec" id="k-llmwiki" data-testid="k-llmwiki">
      <div className="mod-hub-sec-head">
        <b title="真脚本模板，不必跳到自动化也能装">旧版 llmwiki 钩子</b>
        <span className="muted">post-commit · 仓库内文档</span>
        <div className="flex1" />
        <span className="muted small" data-testid="k-llmwiki-all">完整钩子编辑在「自动化」模块（本页已可安装 llmwiki）</span>
      </div>
      <p className="muted small">{tpl?.description || '提交后把变更摘要写入 docs/llmwiki（可改目录）。'}</p>
      <div className="row gap" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="inline-field">输出目录
          <input value={wikiDir} onChange={(e) => setWikiDir(e.target.value)}
            onBlur={() => void run('保存配置', () => git.setConfig(active, 'llmwiki.dir', wikiDir || 'docs/llmwiki'))}
            data-testid="k-llmwiki-dir" style={{ width: 160 }} />
        </label>
        <button className="btn btn-sm btn-primary" disabled={busy || !tpl} onClick={() => void install()} data-testid="k-llmwiki-install">
          {busy ? <Spinner size={12} /> : <Icon name="download" size={13} />}一键安装模板
        </button>
        <button className="btn btn-sm" onClick={() => window.api.openInEditor(`${active}/${wikiDir || 'docs/llmwiki'}/index.md`)} data-testid="k-llmwiki-open">
          <Icon name="eye" size={13} />查看 docs/llmwiki
        </button>
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        AI 摘要：{settings?.aiEnvForHooks && settings.ai?.baseUrl ? `通过 GitLoom 提交时注入环境变量（${settings.ai.model || '未设模型'}）` : '未启用钩子 AI 环境'}
        · <button className="link" onClick={() => setView('settings')}>设置</button>
      </p>
    </section>
  )
}

export function KnowledgeView() {
  const [sec, setSec] = useState<'arch' | 'c4' | 'wiki' | 'graph' | 'llmwiki'>('arch')
  const goSec = (id: typeof sec) => { setSec(id) }
  // 主功能全部内嵌：禁止 setView 离开 knowledge；一次只显示一个分区，页面本身不可拖拽
  return (
    <Hub id="knowledge" icon="book" title="架构与知识" lead="看懂项目「现在长什么样」（以最新提交为准），并把理解沉淀到本机 Wiki 与知识图谱。标题与卡片是普通页面，只有下方图里可以拖动缩放。" cards={[
      { icon: 'modules', title: '模块架构图', desc: 'HEAD 模块依赖可视化，内嵌本页。', action: '本页查看', needsRepo: true, onClick: () => goSec('arch'), tip: '切换到模块架构图', testid: 'k-arch' },
      { icon: 'book', title: 'C4 分层', desc: '系统 → 容器 → 组件，附源码依据。', action: '本页查看', needsRepo: true, onClick: () => goSec('c4'), tip: '切换到 C4', testid: 'k-c4-card' },
      { icon: 'book', title: '项目 Wiki', desc: '本机知识库：新建、编辑、问答。', action: '本页查看', onClick: () => goSec('wiki'), tip: '切换到 Wiki', testid: 'k-wiki-card' },
      { icon: 'calls', title: '知识图谱', desc: 'File / Module / Symbol 关系图。', action: '本页查看', needsRepo: true, onClick: () => goSec('graph'), tip: '切换到知识图谱', testid: 'k-graph-card' },
      { icon: 'hook', title: 'llmwiki 钩子', desc: '安装 post-commit 模板、改输出目录。', action: '本页查看', needsRepo: true, onClick: () => goSec('llmwiki'), tip: '切换到 llmwiki', testid: 'k-llmwiki-card' }
    ]}>
      <div className="row gap" style={{ flexWrap: 'wrap', marginBottom: 8 }} data-testid="k-sec-tabs" role="tablist">
        {([
          ['arch', '模块架构图'],
          ['c4', 'C4'],
          ['wiki', 'Wiki'],
          ['graph', '知识图谱'],
          ['llmwiki', 'llmwiki']
        ] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={sec === id}
            className={`btn btn-sm ${sec === id ? 'btn-primary' : ''}`}
            onClick={() => goSec(id)} data-testid={`k-tab-${id}`}>{label}</button>
        ))}
      </div>
      {sec === 'arch' && <Suspense fallback={<HubPanelFallback label="架构图" />}><ArchGraphEmbed /></Suspense>}
      {sec === 'c4' && (
        <section className="mod-hub-sec" data-testid="k-c4" id="k-c4">
          <div className="mod-hub-sec-head"><b>当前架构（C4）</b><span className="muted">以最新提交为准 · 内嵌于本页</span></div>
          <div className="mod-hub-embed" data-testid="k-c4-embed">
            <Suspense fallback={<HubPanelFallback label="C4" />}><ArchitectureView /></Suspense>
          </div>
        </section>
      )}
      {sec === 'wiki' && <WikiPanel />}
      {sec === 'graph' && <Suspense fallback={<HubPanelFallback label="知识图谱" />}><KnowledgeGraphPanel /></Suspense>}
      {sec === 'llmwiki' && <LlmwikiEmbed />}
      <p className="muted small" style={{ marginTop: 16 }} data-testid="k-codemap-note">
        说明：代码地图 / 阅读路线 / 改动对比（前 / 叠加 / 后）在侧栏「看懂改动」。本页只展示当前 HEAD，不提供跳转。
      </p>
    </Hub>
  )
}


type ToolRow = { id: string; found: boolean; version?: string; note?: string; source?: 'builtin' | 'app' | 'system'; path?: string }
const TOOL_INFO: Record<string, { name: string; use: string; install: string; cmd?: string; oneClick?: boolean; appInstall?: boolean; bundled?: boolean }> = {
  ocr: { name: 'OpenCodeReview（ocr）', use: '多智能体代码审查', install: '随包装好，一般不用装', cmd: 'npm install -g @alibaba-group/open-code-review', oneClick: true, bundled: true },
  semgrep: { name: 'Semgrep', use: '静态安全 / 漏洞模式扫描', install: '还没装 → 点安装到应用内', cmd: 'pip install semgrep', oneClick: true, appInstall: true },
  'osv-scanner': { name: 'OSV Scanner', use: '依赖漏洞（CVE/OSV）', install: '随包装好，一般不用装', cmd: '也可在 npm 项目用 npm audit', oneClick: true, bundled: true },
  node: { name: 'Node.js', use: '运行 lint / 测试 / npm 工具', install: '还没装 → 去 nodejs.org 下载 LTS', cmd: 'https://nodejs.org' },
  npx: { name: 'npx', use: '按需运行 npm 包 CLI', install: '随 Node.js 一起装好', cmd: '随 Node.js 安装' },
  python: { name: 'Python 3', use: 'Semgrep 应用内安装依赖', install: '还没装 → 去 python.org 下载（勾选 Add to PATH）', cmd: 'https://python.org' }
}

function QualityReviewPanel() {
  const { active, setView, settings } = useApp()
  const toast = useToast()
  const reviewRun = useAIRunner()
  const reviewLoading = useRunState(reviewRun, (x) => x.status) === 'running'
  const reviewText = useRunState(reviewRun, (x) => x.text)
  const [open, setOpen] = useState(false)
  const [scopeHint, setScopeHint] = useState('')
  const [merging, setMerging] = useState(false)
  useEffect(() => { reviewRun.reset(); setOpen(false) }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  const start = (force = false) => {
    if (!active) return
    setOpen(true)
    setScopeHint('优先审查暂存区；若为空则审查工作区改动')
    reviewRun.start(`review|quality|${active}`, (signal, onDelta) => appApi.aiStream('reviewStaged', active, {}, onDelta, signal), { force })
  }
  const hasAi = !!(settings?.ai && ((settings.ai.profiles?.length ?? 0) > 0 || settings.ai.baseUrl))

  return (
    <section className="mod-hub-sec" data-testid="q-review">
      <div className="mod-hub-sec-head">
        <b title="在本页直接审查，不必跳到变更页">AI 审查</b>
        <span className="muted">可选 · 要先配置 AI</span>
        <div className="flex1" />
        <button className="btn btn-sm btn-primary btn-ai" disabled={!active || reviewLoading} onClick={() => start()} data-testid="q-review-start" title={!active ? '先选择仓库' : !hasAi ? '未配置 AI 时会提示前往设置' : '开始审查'}>
          {reviewLoading ? <Spinner size={12} /> : <Icon name="ai" size={13} />}{reviewLoading ? '审查中…' : '开始审查'}
        </button>
        <button className="link small" onClick={() => setView('changes')} title="在变更页查看完整 diff">打开变更页看 diff</button>
      </div>
      <p className="muted small">用 AI 读一遍你的改动，给出风险提示。{!hasAi ? <>要先 <button className="link" onClick={() => setView('settings')}>配置 AI</button>；配好前可先用上方「一键体检」。</> : '优先看暂存区，没有则看工作区。'}</p>
      {scopeHint && open && <p className="muted small">{scopeHint}</p>}

        {open && reviewText && active && (
          <button className="btn btn-sm" disabled={merging} title="把本次审查结果并入最近一次体检报告"
            onClick={() => {
              void (async () => {
                setMerging(true)
                try {
                  const latest = await health.latest(active)
                  if (!latest) { toast('err', '还没有体检报告，请先运行一键体检'); return }
                  await window.api.healthMergeReview(active, latest.id, reviewText)
                  toast('ok', '已并入最近体检报告')
                } catch (e) { toast('err', errMsg(e)) }
                finally { setMerging(false) }
              })()
            }} data-testid="q-review-merge">并入体检</button>
        )}
      {open && <AIDrawer runner={reviewRun} title="AI 代码审查" onClose={() => { reviewRun.stop(); setOpen(false) }} onRegenerate={() => start(true)} />}
    </section>
  )
}

function QualityComparePanel({ repo, collapsible = false }: { repo: string; collapsible?: boolean }) {
  const toast = useToast()
  const { setView } = useApp()
  const [a, setA] = useState('main')
  const [b, setB] = useState('HEAD')
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [res, setRes] = useState<Awaited<ReturnType<typeof git.compareRefs>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(!collapsible)
  useEffect(() => {
    git.branches(repo).then((list) => {
      setBranches(list)
      const cur = list.find((x) => x.current)?.name
      const main = list.find((x) => !x.remote && (x.name === 'main' || x.name === 'master'))?.name
      if (main) setA(main)
      if (cur) setB(cur)
    }).catch(() => setBranches([]))
  }, [repo])
  const go = async () => {
    setBusy(true)
    try { setRes(await git.compareRefs(repo, a.trim(), b.trim())) }
    catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }
  const openViz = () => {
    parkViz({ repo, scope: { kind: 'refs', base: a.trim(), head: b.trim() } })
    sessionStorage.setItem('gitloom.tab', 'viz-arch')
    setView('viz')
    setTimeout(() => sessionStorage.removeItem('gitloom.tab'), 800)
  }
  return (
    <section className="mod-hub-sec" data-testid="q-compare">
      <div className="mod-hub-sec-head">
        {collapsible ? (
          <button type="button" className="q-sec-toggle" onClick={() => setOpen((v) => !v)} data-testid="q-compare-toggle" aria-expanded={open}>
            <Icon name={open ? 'chevron-down' : 'chevron'} size={14} />
            <b>比较分支</b>
          </button>
        ) : <b>比较分支</b>}
        <span className="muted">进阶 · 结果留在本页</span>
      </div>
      {!open && <p className="muted small">日常提交前一般不用。展开后可在本页对比两个分支。</p>}
      {open && <p className="muted small">看看两个分支差了哪些提交和文件。</p>}
      {open && <div className="row gap" style={{ flexWrap: 'wrap' }}>
        <select value={a} onChange={(e) => setA(e.target.value)} title="基准" data-testid="q-compare-a">
          {branches.filter((x) => !x.remote).map((br) => <option key={br.fullRef} value={br.name}>{br.name}</option>)}
          {!branches.length && <option value={a}>{a}</option>}
        </select>
        <Icon name="compare" size={16} />
        <select value={b} onChange={(e) => setB(e.target.value)} title="对比" data-testid="q-compare-b">
          {branches.filter((x) => !x.remote).map((br) => <option key={br.fullRef} value={br.name}>{br.name}</option>)}
          {!branches.length && <option value={b}>{b}</option>}
        </select>
        <button className="btn btn-sm btn-primary" onClick={() => void go()} disabled={busy} data-testid="q-compare-go">{busy ? <Spinner size={12} /> : '比较'}</button>
        <button className="link small" disabled={!a.trim() || !b.trim()} onClick={openViz} title="次要入口：打开「看懂改动」的改动向可视化（本页比较结果已在上方）" data-testid="q-compare-viz">在看懂改动中打开可视化对比（改动分析）</button>
      </div>}
      {open && res && (
        <div className="compare-cols" style={{ marginTop: 12 }} data-testid="q-compare-res">
          <div className="stat-chips">
            <span className="stat-chip">领先 <b>{res.ahead}</b></span>
            <span className="stat-chip">落后 <b>{res.behind}</b></span>
            <span className="stat-chip">提交 <b>{res.commits.length}</b></span>
            <span className="stat-chip">文件 <b>{res.files.length}</b></span>
          </div>
          <div className="row gap" style={{ alignItems: 'flex-start', marginTop: 8 }}>
            <div className="flex1">
              <h4>提交</h4>
              {res.commits.slice(0, 30).map((c) => <div key={c.hash} className="pickaxe-row"><span className="mono">{c.short}</span><span className="flex1">{c.subject}</span></div>)}
              {res.commits.length > 30 && <p className="muted small">…另有 {res.commits.length - 30} 个提交</p>}
            </div>
            <div className="flex1">
              <h4>文件</h4>
              {res.files.slice(0, 40).map((f) => <div key={f.path} className="pickaxe-row"><span className="flex1">{f.path}</span><span className="add">+{f.additions}</span><span className="del">−{f.deletions}</span></div>)}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function QualityHooksPanel({ repo }: { repo: string }) {
  const toast = useToast()
  const { setView } = useApp()
  const [templates, setTemplates] = useState<HookTemplate[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { void git.hookTemplates().then(setTemplates).catch(() => setTemplates([])) }, [])
  const wanted = templates.filter((t) => t.id === 'precommit-check' || t.id === 'prepush-test' || t.id === 'conventional')
  const install = async (id: string) => {
    setBusy(id)
    try { await git.installHookTemplate(repo, id); toast('ok', '已安装钩子模板') }
    catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(null) }
  }
  return (
    <section className="mod-hub-sec" data-testid="q-hooks">
      <div className="mod-hub-sec-head">
        <b>提交前钩子</b>
        <span className="muted">白话：提交时自动拦问题</span>
        <div className="flex1" />
        <button className="link small" onClick={() => setView('automation')} title="打开自动化看全部钩子">打开自动化看全部钩子</button>
      </div>
      <p className="muted small">装好后，你点「提交」时会自动检查，有问题会拦住，不用每次手动体检。</p>
      <ul className="mod-hub-list">
        {(wanted.length ? wanted : [
          { id: 'precommit-check', name: '提交前基础检查', hook: 'pre-commit', description: '拦截冲突标记、空白错误与大文件', content: '' },
          { id: 'prepush-test', name: '推送前运行测试', hook: 'pre-push', description: '推送前跑测试', content: '' }
        ]).map((t) => (
          <li key={t.id} data-testid={`q-hook-${t.id}`}>
            <div><b>{t.name}</b> <span className="muted small">· {t.hook}</span><p className="muted small">{t.description}</p></div>
            <button className="btn btn-sm" disabled={busy === t.id} onClick={() => void install(t.id)}>{busy === t.id ? <Spinner size={12} /> : '一键安装'}</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function QualityView() {
  const go = useGo()
  const toast = useToast()
  const { active, setView } = useApp()
  const [tools, setTools] = useState<ToolRow[] | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [advCmd, setAdvCmd] = useState<Record<string, boolean>>({})
  const healthRunRef = useRef<(() => void) | null>(null)
  const detect = () => { setTools(null); void window.api.detectTools?.().then(setTools, () => setTools([])) }
  useEffect(detect, [])
  const sourceLabel = (row: ToolRow) => {
    if (row.source === 'builtin') return '随包装好'
    if (row.source === 'app') return '应用内安装'
    if (row.source === 'system') return '本机已有'
    if (row.note) return row.note
    return ''
  }
  const readyCount = tools?.filter((t) => t.found).length ?? 0
  const totalCount = tools?.length ?? 0
  const oneClick = async (id: string) => {
    if (!window.api.installTool) { toast('err', '当前版本不支持一键安装'); return }
    setInstalling(id)
    try {
      const r = await window.api.installTool(id)
      if (r.ok) { toast('ok', `${TOOL_INFO[id]?.name ?? id} 已就绪`); detect() }
      else {
        toast('err', '安装未成功，可展开「高级命令」手动执行')
        console.warn('[installTool]', r.log)
        if (r.command) {
          try { await navigator.clipboard.writeText(r.command); toast('ok', '已复制手动安装命令到剪贴板') } catch { /* */ }
        }
        detect()
      }
    } catch (e) { toast('err', errMsg(e)) }
    finally { setInstalling(null) }
  }
  const runHealth = () => {
    if (!active) { toast('err', '请先在左侧选择一个仓库'); return }
    healthRunRef.current?.()
    document.getElementById('q-report')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <Hub id="quality" icon="shield" title="质量把关"
      lead="提交前先自动查一遍：有没有漏密钥、明显坏味道、依赖漏洞。不用会命令行。"
      cards={[]}>
      <ol className="q-hero-steps" data-testid="q-hero-steps">
        <li className={active ? 'done' : 'need'} data-testid="q-step-repo">
          <span className="q-step-n">①</span>
          <div>
            <b>选好左侧仓库</b>
            {active
              ? <p className="muted small">已选：{base(active)}</p>
              : <p className="muted small">还没选 — <button type="button" className="btn btn-sm btn-primary" onClick={() => toast('ok', '请在左侧边栏点一个仓库')} data-testid="q-pick-repo">去左侧选一个</button></p>}
          </div>
        </li>
        <li className={active ? 'focus' : ''} data-testid="q-step-run">
          <span className="q-step-n">②</span>
          <div>
            <b>点「一键体检」</b>
            <p className="muted small">用安全默认项自动检查</p>
            <button type="button" className="btn btn-lg btn-primary" disabled={!active} onClick={runHealth}
              data-testid="q-hero-run" title={!active ? '先选仓库' : '运行一键体检'}>
              <Icon name="shield" size={18} />一键体检
            </button>
          </div>
        </li>
        <li data-testid="q-step-result">
          <span className="q-step-n">③</span>
          <div>
            <b>看结果</b>
            <p className="muted small">分数 + 几条白话结论；详情可展开</p>
          </div>
        </li>
      </ol>

      <Suspense fallback={<HubPanelFallback label="体检" />}>
        <HealthReportPanel tools={tools} runRef={healthRunRef} />
      </Suspense>

      <Suspense fallback={<HubPanelFallback label="设计审查" />}><DesignReviewPanel /></Suspense>

      <section className="mod-hub-sec" data-testid="tool-detect">
        <div className="mod-hub-sec-head">
          <button type="button" className="q-sec-toggle" onClick={() => setToolsOpen((v) => !v)} data-testid="tool-detect-toggle" aria-expanded={toolsOpen}>
            <Icon name={toolsOpen ? 'chevron-down' : 'chevron'} size={14} />
            <b>检查工具</b>
          </button>
          <span className="muted" data-testid="tool-ready-summary">
            {!tools ? '检测中…' : `已就绪 ${readyCount} 项` + (totalCount ? ` / ${totalCount}` : '')}
          </span>
          <div className="flex1" />
          <button className="btn btn-sm" onClick={detect} title="重新检测"><Icon name="refresh" size={13} />重新检测</button>
        </div>
        {!toolsOpen && (
          <p className="muted small">多数工具已随包装好或可「安装到应用内」。需要时再展开查看与安装。</p>
        )}
        <div hidden={!toolsOpen} data-testid="tool-detect-body">
          <p className="muted small" data-testid="tool-recommend">
            <b>怎么选：</b>ocr / osv-scanner <em>随包装好</em>；semgrep 可 <em>安装到应用内</em>（需本机 Python）。
            密钥扫描与静态分析已内置，不必另装。高级用户仍可用本机 PATH 外置工具。
          </p>
          {!tools ? <p className="muted">正在检测…</p> : (
            <>
              <table className="mod-hub-table"><tbody>
                {tools.map((row) => {
                  const i = TOOL_INFO[row.id]
                  const inHealth = row.id === 'ocr' || row.id === 'semgrep'
                  const src = sourceLabel(row)
                  return (
                    <tr key={row.id} data-testid={`tool-row-${row.id}`}>
                      <td><Icon name={row.found ? 'ok' : 'warn'} size={14} className={row.found ? 'ok' : 'warn'} /> {i?.name ?? row.id}</td>
                      <td className="muted">{i?.use}</td>
                      <td>{row.found
                        ? <span className="muted">{row.version || '已就绪'}{src ? ` · ${src}` : ''}</span>
                        : <span>{i?.install || '还没装'}</span>}</td>
                      <td>
                        {row.found ? <span className="muted small">{inHealth ? '可在「一键体检」勾选' : '已就绪'}{i?.bundled && row.source === 'builtin' ? ' · 无需外装' : ''}</span>
                          : i?.oneClick ? (
                            <button className="btn btn-sm" data-testid={`tool-install-${row.id}`} disabled={installing === row.id}
                              onClick={() => void oneClick(row.id)} title={i?.appInstall ? '安装到应用数据目录（userData/tools）' : '尝试安装或使用外置回退'}>
                              {installing === row.id ? <Spinner size={12} /> : null}{installing === row.id ? '安装中…' : (i?.appInstall ? '安装到应用内' : (i?.bundled ? '检查内置' : '一键安装'))}
                            </button>
                          ) : <span className="muted small">请按说明手动安装</span>}
                      </td>
                      <td>
                        {i?.cmd && (
                          <details className="tool-adv-cmd" open={!!advCmd[row.id]} onToggle={(e) => setAdvCmd((m) => ({ ...m, [row.id]: (e.target as HTMLDetailsElement).open }))}>
                            <summary className="muted small">高级命令</summary>
                            <code className="tool-cmd" title="可复制">{i.cmd}</code>
                            <button type="button" className="btn btn-xs" onClick={() => { void navigator.clipboard.writeText(i.cmd!).then(() => toast('ok', '已复制'), () => toast('err', '复制失败')) }}>复制</button>
                          </details>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody></table>
              <p className="muted small" style={{ marginTop: 6 }}>
                密钥扫描 / 静态语法树：内置。Semgrep「安装到应用内」写入应用数据目录；ocr 与 osv-scanner 随安装包。失败时不会假装成功。
              </p>
            </>
          )}
        </div>
      </section>

      <QualityReviewPanel />
      {active ? <QualityHooksPanel repo={active} /> : (
        <section className="mod-hub-sec" data-testid="q-hooks-placeholder">
          <div className="mod-hub-sec-head"><b>提交前钩子</b><span className="muted">提交时自动拦问题</span></div>
          <p className="muted">先在左侧选择仓库，再安装常用钩子模板。</p>
        </section>
      )}

      {active ? <QualityComparePanel repo={active} collapsible /> : (
        <section className="mod-hub-sec" data-testid="q-compare">
          <div className="mod-hub-sec-head"><b>比较分支</b><span className="muted">进阶</span></div>
          <p className="muted">选择仓库后可在本页比较分支。</p>
        </section>
      )}

      <section className="mod-hub-sec q-advanced" data-testid="q-tasks-wrap">
        <div className="mod-hub-sec-head">
          <button type="button" className="q-sec-toggle" onClick={() => setTasksOpen((v) => !v)} data-testid="q-tasks-toggle" aria-expanded={tasksOpen}>
            <Icon name={tasksOpen ? 'chevron-down' : 'chevron'} size={14} />
            <b>AI 定时任务</b>
          </button>
          <span className="muted">进阶 · 装好后再用</span>
          <div className="flex1" />
          <button className="link small" onClick={() => setView('automation')} title="完整入口在自动化模块">在自动化中打开</button>
        </div>
        {!tasksOpen && <p className="muted small">按时间让 AI 做只读分析（问题日报、安全扫描等）。配置好 AI 后再用。</p>}
        {tasksOpen && (
          <div data-testid="ai-tasks-quality">
            <Suspense fallback={<HubPanelFallback label="定时任务" />}><TasksPanel /></Suspense>
          </div>
        )}
      </section>

      <div className="mod-hub-related" data-testid="mod-hub-related-quality">
        <span className="muted small">相关能力</span>
        <button className="link small" disabled={!active} onClick={() => go.viz('impact')} title="次要入口：打开看懂改动的影响范围（非本页主功能）" data-testid="q-impact">
          影响范围 → 看懂改动（改动分析）
        </button>
      </div>
    </Hub>
  )
}
