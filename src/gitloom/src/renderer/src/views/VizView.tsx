// 变更可视化: scope picker → summary strip → 8 diagram tabs (before | after, overlay, slider), node side panel,
// export, optional AI enrichment. Static views work fully without AI.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ELKApi from 'elkjs/lib/elk-api'
// @ts-ignore - raw import of the classic worker script; started from a Blob URL (CSP: worker-src 'self' blob:)
import elkWorkerSrc from 'elkjs/lib/elk-worker.min.js?raw'
import type { VizResult, VizScope, VizViewId, VizAIResult, SeqDiagram, StateMachine, FlowEntry, DiffGraph, SummaryCount, GNode, MapFile, Tour, TourStep } from '@shared/viz'
import { VIZ_VIEWS, scopeLabel } from '@shared/viz'
import { viz, git, errMsg, type VizProgressEvent } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Spinner, useToast, useMenu, anchorOf, usePersistentState } from '../components/ui'
import { GraphDiff, type CompareMode, type ExportApi } from '../components/viz/GraphDiff'
import { SequenceView } from '../components/viz/SequenceView'
import { NodePanel, type VizSel } from '../components/viz/NodePanel'
import { setElkFactory, type LayoutKind } from '../lib/vizLayout'
import { takeViz, peekSoftViz, type VizHandoff } from '../lib/vizNav'
import { STATUS_SIGN } from '../lib/vizGraph'
import { natCmp } from '../lib/codemap'
import { CodeMapView, type CodeMapApi, type MapDisplay } from '../components/viz/CodeMapView'
import { TourList, type TourSrc } from '../components/viz/TourList'
import { DiagramExplain } from '../components/viz/DiagramExplain'
import { TAB_NOTATION } from '../lib/vizSe'
import { codemapJson, codemapMarkdown, importersOf, stepNode, tourGraph, tourMarkdown, type ColorBy, type MapScope, type SizeSide } from '../lib/codemap'
import '../components/viz/viz.css'

// ELK in a Web Worker keeps the UI responsive on big graphs; falls back to the in-thread build if workers fail
try {
  const url = URL.createObjectURL(new Blob([elkWorkerSrc as string], { type: 'text/javascript' }))
  setElkFactory(() => new ELKApi({ workerUrl: url }) as unknown as Parameters<typeof setElkFactory>[0] extends () => infer R ? R : never)
} catch { /* keep default */ }

type ScopeKind = VizScope['kind']
type AIState = { model: string; running: boolean; text?: string; error?: string; result?: VizAIResult & { cached?: boolean } }
const SUMMARY: { k: keyof VizResult['summary']; label: string; tab: VizViewId }[] = [
  { k: 'files', label: '文件', tab: 'modules' }, { k: 'modules', label: '模块', tab: 'arch' }, { k: 'deps', label: '依赖', tab: 'modules' },
  { k: 'functions', label: '函数', tab: 'calls' }, { k: 'calls', label: '调用', tab: 'calls' }, { k: 'classes', label: '类型', tab: 'classes' },
  { k: 'states', label: '状态', tab: 'state' }, { k: 'routes', label: '路由/事件', tab: 'arch' }
]
const LAYOUT_OF: Record<string, LayoutKind> = { tour: 'flow', arch: 'arch', modules: 'modules', calls: 'calls', classes: 'classes', impact: 'impact', flow: 'flow', state: 'state' }
const changedLeaves = (g: DiffGraph) => g.nodes.filter((n) => !n.group && n.status !== 'unchanged').length
const leaves = (g: DiffGraph) => g.nodes.filter((n) => !n.group).length
/** a code-map file as a graph node, so the existing side panel (patch + 打开差异) works for it */
const mapNode = (f: MapFile): GNode => {
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
  return { id: `m:${f.path}`, label: f.path.split('/').pop()!, kind: 'file', status: f.status, sub: dir, lang: f.lang, weight: importersOf(f),
    ...(f.status !== 'added' ? { before: { file: f.oldPath ?? f.path, line: 1 } } : {}), ...(f.status !== 'removed' ? { after: { file: f.path, line: 1 } } : {}),
    note: f.blast ? `影响面 ${f.blast} 个文件${f.hub ? ' · 热点文件' : ''}` : f.hub ? '热点文件' : undefined }
}
const seenKey = (k: string, src: string) => `gitloom.viz.seen.${k}.${src}`

function Chip({ c, label, onClick }: { c: SummaryCount; label: string; onClick: () => void }) {
  const total = c.added + c.removed + c.modified + (c.moved ?? 0)
  return (
    <button className={`vz-chip${total ? '' : ' zero'}`} onClick={onClick} title={`${label}：新增 ${c.added}，删除 ${c.removed}，修改 ${c.modified}${c.moved ? `，移动 ${c.moved}` : ''}`}>
      {c.added > 0 && <b className="ad">+{c.added}</b>}{c.removed > 0 && <b className="rm">−{c.removed}</b>}{c.modified > 0 && <b className="md">~{c.modified}</b>}{(c.moved ?? 0) > 0 && <b className="mv">→{c.moved}</b>}
      {!total && <b className="z">0</b>}<span>{label}</span>
    </button>
  )
}

function Legend({ heat, tab }: { heat: boolean; tab: VizViewId }) {
  const note = TAB_NOTATION[tab]
  return (
    <div className="vz-legend" aria-label="图例">
      {heat
        ? <><span className="lg heat-0">改动点</span><span className="lg heat-1">直接依赖</span><span className="lg heat-2">2 跳</span><span className="lg heat-3">3 跳+</span></>
        : <><span className="lg ad">新增</span><span className="lg rm">删除</span><span className="lg md">修改</span><span className="lg mv">移动</span><span className="lg un">未变</span></>}
      {note && <span className="vz-notation" title={note} data-testid="viz-notation">{note}</span>}
    </div>
  )
}

function AICard({ ai, what, onRun, onCancel, onSettings }: { ai: AIState; what: string; onRun: () => void; onCancel: () => void; onSettings: () => void }) {
  return (
    <div className="vz-aicard" data-testid="viz-ai-card">
      <Icon name="wand" size={22} />
      <div className="vz-aicard-txt">
        <b>{what}需要 AI 生成</b>
        {!ai.model ? <span>静态分析看不出业务语义。配置一个 AI 模型后，GitLoom 会把静态分析事实和 diff 交给模型，生成严格校验过的结构化图表。</span>
          : ai.running ? <span>{ai.text ?? 'AI 正在生成…'}</span>
          : ai.error ? <span className="err">{ai.error}</span>
          : <span>将使用 <b>{ai.model}</b>，基于静态分析事实生成，结果按提交缓存。</span>}
      </div>
      {!ai.model ? <button className="btn btn-sm btn-primary" onClick={onSettings} data-testid="viz-ai-setup"><Icon name="settings" size={13} />去配置 AI</button>
        : ai.running ? <button className="btn btn-sm" onClick={onCancel} data-testid="viz-ai-cancel"><Icon name="stop" size={13} />停止</button>
        : <button className="btn btn-sm btn-primary" onClick={onRun} data-testid="viz-ai-run"><Icon name="wand" size={13} />{ai.error ? '重试' : 'AI 生成'}</button>}
    </div>
  )
}

export default function VizView() {
  const { active, status, settings, setView, theme, view } = useApp()
  const knowledgeGraphOnly = view === 'architecture-graph'
  const toast = useToast()
  const menu = useMenu()
  // ---------------------------------------------------------------- scope
  const [kind, setKind] = useState<ScopeKind>('working')
  const [sha, setSha] = useState('HEAD')
  const [from, setFrom] = useState('HEAD~5')
  const [to, setTo] = useState('HEAD')
  const [base, setBase] = useState('')
  const [head, setHead] = useState('HEAD')
  const [filter, setFilter] = useState('')
  const [commits, setCommits] = useState<{ sha: string; subject: string }[]>([])
  const [refs, setRefs] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [curBranch, setCurBranch] = useState<{ name: string; upstream?: string } | null>(null)
  useEffect(() => {
    if (!active) return
    git.tags(active).then((ts) => setTags([...ts].sort((a, b) => b.date - a.date || natCmp(b.name, a.name)).map((t) => t.name))).catch(() => setTags([]))
    git.log(active, { limit: 60 }).then((l) => setCommits(l.map((c) => ({ sha: c.hash, subject: c.subject })))).catch(() => setCommits([]))
    git.branches(active).then((bs) => {
      const names = bs.map((b) => b.name)
      setRefs(names)
      const cur = bs.find((b) => b.current && !b.remote)
      setCurBranch(cur ? { name: cur.name, upstream: cur.upstream ?? undefined } : null)
      const main = names.find((n) => n === 'main') ?? names.find((n) => n === 'master') ?? names.find((n) => /origin\/(main|master)$/.test(n)) ?? names[0] ?? ''
      setBase((b) => b || main)
    }).catch(() => setRefs([]))
  }, [active])
  const swapSides = () => { if (kind === 'range') { setFrom(to); setTo(from) } else if (kind === 'refs') { setBase(head); setHead(base) } }
  const presetMenu = (el: Element) => {
    const main = refs.find((n) => n === 'main') ?? refs.find((n) => n === 'master') ?? refs.find((n) => /origin\/(main|master)$/.test(n))
    const go = (s: VizScope) => { setKind(s.kind); if (s.kind === 'commit') setSha(s.sha); if (s.kind === 'range') { setFrom(s.from); setTo(s.to) } if (s.kind === 'refs') { setBase(s.base); setHead(s.head) } void analyze(s, filter.trim()) }
    menu(anchorOf(el), [
      { label: '快捷对比', header: true },
      { label: '工作区 ↔ HEAD（未提交的改动）', icon: 'changes', onClick: () => go({ kind: 'working' }) },
      { label: '最新提交 ↔ 它的父提交', icon: 'commit', onClick: () => go({ kind: 'commit', sha: 'HEAD' }) },
      { label: '最近 5 个提交（HEAD~5 → HEAD）', icon: 'history', onClick: () => go({ kind: 'range', from: 'HEAD~5', to: 'HEAD' }) },
      ...(tags[0] ? [{ label: `最新标签 ${tags[0]} → HEAD（发版以来）`, icon: 'tag', onClick: () => go({ kind: 'range', from: tags[0], to: 'HEAD' }) }] : []),
      ...(tags[1] ? [{ label: `两个标签之间：${tags[1]} → ${tags[0]}`, icon: 'tag', onClick: () => go({ kind: 'range', from: tags[1], to: tags[0] }) }] : []),
      ...(main && curBranch && curBranch.name !== main ? [{ label: `当前分支 ${curBranch.name} ↔ ${main}（类似 PR）`, icon: 'branch', onClick: () => go({ kind: 'refs', base: main, head: curBranch.name }) }] : []),
      ...(curBranch?.upstream ? [{ label: `还没推送的提交（${curBranch.upstream} → HEAD）`, icon: 'push', onClick: () => go({ kind: 'range', from: curBranch.upstream!, to: 'HEAD' }) }] : [])
    ])
  }
  const scopeOf = useCallback((): VizScope => kind === 'working' ? { kind } : kind === 'commit' ? { kind, sha: sha.trim() || 'HEAD' } : kind === 'range' ? { kind, from: from.trim(), to: to.trim() || 'HEAD' } : { kind, base: base.trim(), head: head.trim() || 'HEAD' }, [kind, sha, from, to, base, head])

  // ---------------------------------------------------------------- analysis
  const [result, setResult] = useState<VizResult | null>(null)
  const [prog, setProg] = useState<VizProgressEvent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const ctl = useRef<AbortController | null>(null)
  const analyze = useCallback(async (scope: VizScope, f: string) => {
    if (!active) return
    ctl.current?.abort()
    const c = new AbortController(); ctl.current = c
    setRunning(true); setError(null); setProg({ phase: 'git', done: 0, total: 1, text: '准备…' })
    try {
      const r = await viz.analyze({ repo: active, scope, filter: f || undefined, hops: 2 }, setProg, c.signal)
      if (ctl.current !== c) return
      setResult(r); setSel(null); setCenter(null)
    } catch (e) {
      if (ctl.current !== c) return
      setError((e as Error).name === 'AbortError' ? '已取消分析' : errMsg(e))
    } finally { if (ctl.current === c) { setRunning(false); setProg(null) } }
  }, [active])
  const cancel = () => { ctl.current?.abort(); ctl.current = null; setRunning(false); setProg(null); setError('已取消分析') }
  const run = () => void analyze(scopeOf(), filter.trim())
  const applyHandoff = useCallback((h: VizHandoff) => {
    const s = h.scope
    setKind(s.kind)
    if (s.kind === 'commit') setSha(s.sha)
    if (s.kind === 'range') { setFrom(s.from); setTo(s.to) }
    if (s.kind === 'refs') { setBase(s.base); setHead(s.head) }
    setFilter(h.filter ?? '')
    void analyze(s, h.filter ?? '')
  }, [analyze])
  // first open: a parked request from another view, else working tree (or HEAD when clean)
  const booted = useRef<string | null>(null)
  useEffect(() => {
    if (!active || booted.current === active) return
    booted.current = active
    const tabHint = sessionStorage.getItem('gitloom.tab')
    if (tabHint?.startsWith('viz-')) { const [, v, m] = tabHint.split('-'); if (v) setTab(v as VizViewId); if (m) setMode(m as CompareMode) }
    const h = takeViz(active) ?? peekSoftViz(active)
    if (h) { applyHandoff(h); return }
    const dirty = status ? status.staged.length + status.unstaged.length > 0 : false
    if (!dirty) { setKind('commit'); setSha('HEAD'); void analyze({ kind: 'commit', sha: 'HEAD' }, '') } else void analyze({ kind: 'working' }, '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent<VizHandoff>).detail; if (d && d.repo === active) { takeViz(active); applyHandoff(d) } }
    window.addEventListener('gitloom:viz', h)
    return () => window.removeEventListener('gitloom:viz', h)
  }, [active, applyHandoff])
  useEffect(() => () => ctl.current?.abort(), [])

  // ---------------------------------------------------------------- view state
  const [tab, setTab] = usePersistentState<VizViewId>('gitloom.viz.tab', 'arch')
  useEffect(() => { if (knowledgeGraphOnly && tab !== 'arch') setTab('arch') }, [knowledgeGraphOnly, tab, setTab])
  const [mode, setMode] = usePersistentState<CompareMode>('gitloom.viz.mode', 'side')
  const [focusPref, setFocusPref] = useState<Partial<Record<VizViewId, boolean>>>({})
  const [hops, setHops] = usePersistentState<number>('gitloom.viz.hops', 1)
  const [search, setSearch] = useState('')
  const [searchIdx, setSearchIdx] = useState(0)
  const [sel, setSel] = useState<VizSel | null>(null)
  const [center, setCenter] = useState<string | null>(null)
  const [info, setInfo] = useState<{ shown: number; total: number; clustered: number; matches: number; layoutMs: number } | null>(null)
  const [archSrc, setArchSrc] = useState<'static' | 'ai'>('static')
  const [flowSrc, setFlowSrc] = useState<'code' | 'biz'>('code')
  const [pick, setPick] = useState<Partial<Record<'flow' | 'sequence' | 'state', string>>>({})
  const [listQ, setListQ] = useState('')
  const [explain, setExplain] = useState(false)
  const exp = useRef<ExportApi>(null)
  // 代码地图 / 改动导览 (0.5.1)
  const [mapDisplay, setMapDisplay] = usePersistentState<MapDisplay>('gitloom.viz.map.display', 'tree')
  const [mapScope, setMapScope] = usePersistentState<MapScope>('gitloom.viz.map.scope', 'changed')
  const [colorBy, setColorBy] = usePersistentState<ColorBy>('gitloom.viz.map.color', 'status')
  const [sizeSide, setSizeSide] = useState<SizeSide>('after')
  const [mapQ, setMapQ] = useState('')
  const mapExp = useRef<CodeMapApi>(null)
  const [tourSrc, setTourSrc] = useState<TourSrc>('static')
  const [tourQ, setTourQ] = useState('')
  const [aiTour, setAiTour] = useState<{ running: boolean; text?: string; error?: string; tour?: Tour & { cached?: boolean } }>({ running: false })
  const tourCtl = useRef<AbortController | null>(null)
  const [seen, setSeen] = useState<Set<string>>(new Set())
  useEffect(() => { setSel(null); setCenter(null); setSearch(''); setListQ(''); setMapQ(''); setExplain(false) }, [tab])
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) { setSel(null); setCenter(null) } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h) }, [])

  // ---------------------------------------------------------------- AI enrichment
  const [ai, setAi] = useState<AIState>({ model: '', running: false })
  const aiCtl = useRef<AbortController | null>(null)
  useEffect(() => {
    let alive = true
    viz.aiInfo(result?.id).then((i) => {
      if (!alive) return
      setAi((a) => ({ ...a, model: i.model, result: a.result && result && a.result.key === result.key && a.result.model === i.model ? a.result : undefined, error: undefined }))
      if (i.cached && result) void runAI(true)
    }).catch(() => undefined)
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.id, settings?.ai])
  const runAI = useCallback(async (silent = false) => {
    if (!result) return
    aiCtl.current?.abort()
    const c = new AbortController(); aiCtl.current = c
    setAi((a) => ({ ...a, running: true, error: undefined, text: 'AI 正在读取分析结果…' }))
    try {
      const r = await viz.ai(result.id, (p) => setAi((a) => ({ ...a, text: p.text })), c.signal)
      if (aiCtl.current !== c) return
      setAi((a) => ({ ...a, running: false, result: r, text: undefined }))
      if (!silent) toast('ok', r.cached ? '已使用缓存的 AI 图表' : `AI 图表已生成${r.attempts && r.attempts > 1 ? '（第二次校验通过）' : ''}`)
      if (r.arch) setArchSrc((s) => (silent ? s : 'ai'))
    } catch (e) {
      if (aiCtl.current !== c) return
      setAi((a) => ({ ...a, running: false, text: undefined, error: (e as Error).name === 'AbortError' ? '已停止' : errMsg(e) }))
    }
  }, [result, toast])
  const cancelAI = () => { aiCtl.current?.abort(); aiCtl.current = null; setAi((a) => ({ ...a, running: false, text: undefined, error: '已停止' })) }
  useEffect(() => () => aiCtl.current?.abort(), [])
  const aiRes = ai.result && result && ai.result.key === result.key ? ai.result : undefined

  // ---------------------------------------------------------------- 改动导览
  useEffect(() => { tourCtl.current?.abort(); tourCtl.current = null; setAiTour({ running: false }) }, [result?.id])
  const runTour = useCallback(async () => {
    if (!result) return
    tourCtl.current?.abort()
    const c = new AbortController(); tourCtl.current = c
    setAiTour((t) => ({ ...t, running: true, error: undefined, text: 'AI 正在读取改动…' }))
    try {
      const t = await viz.tour(result.id, tourQ, (p) => setAiTour((x) => ({ ...x, text: p.text })), c.signal)
      if (tourCtl.current !== c) return
      setAiTour({ running: false, tour: t })
      toast('ok', t.cached ? '已使用缓存的 AI 路径' : `AI 路径已生成：${t.groups.reduce((n, g) => n + g.steps.length, 0)} 步${t.attempts && t.attempts > 1 ? '（第二次校验通过）' : ''}`)
    } catch (e) {
      if (tourCtl.current !== c) return
      setAiTour((t) => ({ ...t, running: false, text: undefined, error: (e as Error).name === 'AbortError' ? '已停止' : errMsg(e) }))
    }
  }, [result, tourQ, toast])
  const cancelTour = () => { tourCtl.current?.abort(); tourCtl.current = null; setAiTour((t) => ({ ...t, running: false, text: undefined, error: '已停止' })) }
  useEffect(() => () => tourCtl.current?.abort(), [])
  const tour: Tour | null = !result ? null : tourSrc === 'ai' ? aiTour.tour ?? null : result.tour ?? null
  useEffect(() => {
    if (!result || !tour) { setSeen(new Set()); return }
    try { setSeen(new Set(JSON.parse(localStorage.getItem(seenKey(result.key, tour.id + (tour.question ?? ''))) ?? '[]') as string[])) } catch { setSeen(new Set()) }
  }, [result?.key, tour])
  const markSeen = (id: string, v: boolean) => setSeen((s0) => {
    const s1 = new Set(s0); if (v) s1.add(id); else s1.delete(id)
    if (result && tour) { try { localStorage.setItem(seenKey(result.key, tour.id + (tour.question ?? '')), JSON.stringify([...s1])) } catch { /* quota */ } }
    return s1
  })
  const tourG = useMemo(() => (tour ? tourGraph(tour) : null), [tour])

  // ---------------------------------------------------------------- derived
  const flows: FlowEntry[] = useMemo(() => (flowSrc === 'biz' ? aiRes?.flows ?? [] : result?.flows ?? []), [flowSrc, aiRes, result])
  const seqs: SeqDiagram[] = useMemo(() => [...(aiRes?.sequences ?? []), ...(result?.sequences ?? [])], [aiRes, result])
  const states: StateMachine[] = useMemo(() => [...(aiRes?.states ?? []), ...(result?.states ?? [])], [aiRes, result])
  const listOf = tab === 'flow' ? flows : tab === 'sequence' ? seqs : tab === 'state' ? states : []
  const listKey = tab === 'flow' || tab === 'sequence' || tab === 'state' ? tab : null
  const picked = listKey ? (listOf as { id: string }[]).find((x) => x.id === pick[listKey]) ?? listOf[0] : undefined
  const graph: DiffGraph | null = !result ? null
    : tab === 'arch' ? (archSrc === 'ai' && aiRes?.arch ? aiRes.arch : result.arch)
    : tab === 'modules' ? result.modules : tab === 'calls' ? result.calls : tab === 'classes' ? result.classes : tab === 'impact' ? result.impact
    : tab === 'tour' ? (tourG && tourG.nodes.length ? tourG : null)
    : tab === 'flow' ? (picked as FlowEntry | undefined)?.graph ?? null : tab === 'state' ? (picked as StateMachine | undefined)?.graph ?? null : null
  const autoFocus = !!graph && (tab === 'modules' ? leaves(graph) > 40 : tab === 'calls' ? leaves(graph) > 90 : false) && changedLeaves(graph) > 0
  const focus = focusPref[tab] ?? autoFocus
  const counts: Record<VizViewId, number> = result ? {
    map: result.map?.totals.changed ?? 0, tour: result.tour?.groups.reduce((n, g) => n + g.steps.filter((x) => x.kind === 'file').length, 0) ?? 0,
    arch: changedLeaves(result.arch), modules: changedLeaves(result.modules), calls: changedLeaves(result.calls), classes: changedLeaves(result.classes),
    impact: result.impact.nodes.filter((n) => !n.group).length, flow: result.flows.length + (aiRes?.flows.length ?? 0),
    sequence: seqs.length, state: states.length
  } : { map: 0, tour: 0, arch: 0, modules: 0, calls: 0, classes: 0, impact: 0, flow: 0, sequence: 0, state: 0 }

  // ---------------------------------------------------------------- export
  const slug = result ? scopeLabel(result.scope).replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').slice(0, 40) : 'viz'
  const doExport = async (what: 'png' | 'svg' | 'mermaid' | 'plantuml' | 'view') => {
    const api = exp.current
    if (!api) return
    try {
      if (what === 'mermaid' || what === 'plantuml') {
        const txt = what === 'mermaid' ? api.mermaid() : api.plantuml()
        ;(window as unknown as { __vizLastCopy?: string }).__vizLastCopy = txt
        await navigator.clipboard.writeText(txt).catch(() => undefined)
        toast('ok', `已复制 ${what === 'mermaid' ? 'Mermaid' : 'PlantUML'} 代码（${txt.split('\n').length} 行）`)
        return
      }
      const data = what === 'png' ? await api.png() : what === 'view' ? await (api.pngView ?? api.png)() : await api.svg()
      const ext = what === 'view' ? 'png' : what
      const name = `gitloom-${tab}${what === 'view' ? '-view' : ''}-${slug}.${ext}`
      const p = await viz.save(name, data, ext === 'png' ? 'base64' : 'utf8')
      if (p) toast('ok', `已导出 ${p}`)
    } catch (e) { toast('err', `导出失败：${errMsg(e)}`) }
  }
  const saveText = async (name: string, txt: string) => {
    try { const p = await viz.save(name, txt, 'utf8'); if (p) toast('ok', `已导出 ${p}`) } catch (e) { toast('err', `导出失败：${errMsg(e)}`) }
  }
  const copyText = async (txt: string, what: string) => {
    ;(window as unknown as { __vizLastCopy?: string }).__vizLastCopy = txt
    await navigator.clipboard.writeText(txt).catch(() => undefined)
    toast('ok', `已复制${what}（${txt.split('\n').length} 行）`)
  }
  const mapExportMenu = (el: Element) => result && menu(anchorOf(el), [
    { label: '导出代码地图', header: true },
    { label: '导出 Markdown 评审包', icon: 'file-text', onClick: () => void saveText(`gitloom-codemap-${slug}.md`, codemapMarkdown(result)) },
    { label: '复制 Markdown（贴到 PR 描述）', icon: 'clip-copy', onClick: () => void copyText(codemapMarkdown(result), ' Markdown 评审包') },
    { label: '导出 JSON（gitloom.codemap/v1）', icon: 'braces', onClick: () => void saveText(`gitloom-codemap-${slug}.json`, codemapJson(result)) },
    { sep: true },
    { label: '导出 PNG 图片', icon: 'image', onClick: async () => { try { const d = await mapExp.current!.png(); const p = await viz.save(`gitloom-codemap-${slug}.png`, d, 'base64'); if (p) toast('ok', `已导出 ${p}`) } catch (e) { toast('err', `导出失败：${errMsg(e)}`) } } }
  ])
  const exportMenu = (el: Element) => tab === 'map' ? mapExportMenu(el) : menu(anchorOf(el), [
    ...(tab === 'tour' && tour && result ? [
      { label: '导出导览', header: true },
      { label: '导出 Markdown 阅读清单', icon: 'file-text', onClick: () => void saveText(`gitloom-tour-${slug}.md`, tourMarkdown(tour, result)) },
      { label: '复制 Markdown', icon: 'clip-copy', onClick: () => void copyText(tourMarkdown(tour, result), '导览 Markdown') },
      { sep: true }
    ] : []),
    { label: '导出', header: true },
    { label: tab === 'sequence' ? '导出 PNG 图片' : '导出 PNG 图片（整张图，高清）', icon: 'image', onClick: () => void doExport('png') },
    { label: tab === 'sequence' ? '导出 SVG 矢量图' : '导出 SVG 矢量图（整张图）', icon: 'download', onClick: () => void doExport('svg') },
    ...(tab !== 'sequence' ? [{ label: '导出当前画面（PNG 截图）', icon: 'image', onClick: () => void doExport('view') }] : []),
    { sep: true },
    { label: '复制为 Mermaid', icon: 'clip-copy', onClick: () => void doExport('mermaid') },
    { label: '复制为 PlantUML', icon: 'clip-copy', onClick: () => void doExport('plantuml') }
  ])

  const onSelectNode = useCallback((n: GNode | null, edges?: DiffGraph['edges']) => setSel(n ? { type: 'node', n, edges: edges ?? [] } : null), [])
  const mapEdges = (id: string) => (result?.modules.edges ?? []).filter((e) => e.source === id || e.target === id)
  const pickMapFile = (f: MapFile | null) => setSel(f ? { type: 'node', n: mapNode(f), edges: mapEdges(`m:${f.path}`) } : null)
  const pickNode = (id: string) => {
    if (tab === 'map') { const f = result?.map?.files.find((x) => `m:${x.path}` === id); if (f) pickMapFile(f); return }
    const n = graph?.nodes.find((x) => x.id === id); if (n) setSel({ type: 'node', n, edges: graph!.edges.filter((e) => e.source === id || e.target === id) })
  }
  const pickStep = (st: TourStep) => {
    const n = graph?.nodes.find((x) => x.id === st.id)
    if (n) { pickNode(st.id); return }
    // function step of the static tour: drawn as a member of its file node → open the function itself
    setSel({ type: 'node', n: stepNode(st), edges: [] })
  }
  const graphTab = tab !== 'sequence'
  const aiOnly = (tab === 'arch' && archSrc === 'ai' && !aiRes?.arch) || (tab === 'flow' && flowSrc === 'biz' && !aiRes?.flows.length)

  if (!active) return null
  return (
    <div className="vz" data-testid="viz-view">
      {/* ---------------- scope picker */}
      <div className="vz-scope">
        <div className="seg" role="tablist" aria-label="对比范围">
          {([['working', '工作区', '还没提交的全部改动（对比最新提交）'], ['commit', '最新提交', '最近一次提交改了什么'], ['refs', '比较分支', '两个分支之间的全部差异（类似合并请求）'], ['range', '提交范围', '任意两个提交 / 标签之间（进阶）']] as [ScopeKind, string, string][]).map(([k, l, t]) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)} title={t} data-testid={`viz-scope-${k}`}>{l}</button>
          ))}
        </div>
        {kind === 'commit' && <input className="input vz-in" list="vz-commits" value={sha} onChange={(e) => setSha(e.target.value)} placeholder="提交 SHA / HEAD~1" aria-label="提交" data-testid="viz-sha" onKeyDown={(e) => e.key === 'Enter' && run()} />}
        {kind === 'range' && <><input className="input vz-in" list="vz-commits" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="起点" placeholder="起点" data-testid="viz-from" /><span className="muted">..</span><input className="input vz-in" list="vz-commits" value={to} onChange={(e) => setTo(e.target.value)} aria-label="终点" placeholder="终点" data-testid="viz-to" /><button className="icon-btn sm" onClick={swapSides} title="交换两侧（起点 ⇄ 终点）" aria-label="交换两侧" data-testid="viz-swap"><Icon name="swap" size={13} /></button></>}
        {kind === 'refs' && <><input className="input vz-in" list="vz-refs" value={base} onChange={(e) => setBase(e.target.value)} aria-label="基准分支" placeholder="基准（如 main）" data-testid="viz-base" /><Icon name="compare" size={13} className="muted" /><input className="input vz-in" list="vz-refs" value={head} onChange={(e) => setHead(e.target.value)} aria-label="对比分支" placeholder="对比分支" data-testid="viz-head" /><button className="icon-btn sm" onClick={swapSides} title="交换两侧（基准 ⇄ 对比）" aria-label="交换两侧" data-testid="viz-swap"><Icon name="swap" size={13} /></button></>}
        <datalist id="vz-commits">{tags.slice(0, 30).map((t) => <option key={`t:${t}`} value={t}>标签</option>)}{commits.map((c) => <option key={c.sha} value={c.sha.slice(0, 10)}>{c.subject}</option>)}</datalist>
        <datalist id="vz-refs">{refs.map((r) => <option key={r} value={r} />)}{tags.slice(0, 30).map((t) => <option key={`t:${t}`} value={t}>标签</option>)}</datalist>
        <button className="btn btn-sm" onClick={(e) => presetMenu(e.currentTarget)} title="常用对比：发版以来、两个标签之间、当前分支 ↔ main、未推送的提交…" data-testid="viz-presets"><Icon name="compare" size={13} /><span className="lbl-sm">快捷对比</span><Icon name="chevron-down" size={11} /></button>
        <div className="vz-filter"><Icon name="folder" size={13} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="路径 / 模块过滤（可选）" aria-label="路径过滤" data-testid="viz-filter" onKeyDown={(e) => e.key === 'Enter' && run()} /></div>
        {running ? <button className="btn btn-sm" onClick={cancel} data-testid="viz-cancel"><Icon name="stop" size={13} />停止</button>
          : <button className="btn btn-sm btn-primary" onClick={run} data-testid="viz-run"><Icon name="play" size={13} />分析</button>}
      </div>
      {running && prog && <div className="vz-prog" data-testid="viz-progress"><Spinner size={12} /><span>{prog.text}</span>{prog.total > 1 && <div className="vz-bar"><i style={{ width: `${Math.min(100, (prog.done / prog.total) * 100)}%` }} /></div>}</div>}
      {error && !running && <div className="vz-err" data-testid="viz-error"><Icon name="warn" size={14} />{error}<button className="btn btn-sm" onClick={run}>重新分析</button></div>}
      {result && (<>
        {/* ---------------- summary strip */}
        <div className="vz-summary" data-testid="viz-summary">
          <span className="vz-range" title={`${result.beforeLabel} → ${result.afterLabel}`}><b>{scopeLabel(result.scope)}</b>{result.filter && <em> · {result.filter}</em>}</span>
          {SUMMARY.map((s) => <Chip key={s.k} c={result.summary[s.k]} label={s.label} onClick={() => setTab(s.tab)} />)}
          {aiRes?.headline && <span className={`vz-headline risk-${aiRes.risk ?? 'low'}`} title={`AI · ${aiRes.model}`}><Icon name="wand" size={12} />{aiRes.headline}{aiRes.risk && <em>{aiRes.risk === 'high' ? '高风险' : aiRes.risk === 'medium' ? '中风险' : '低风险'}</em>}</span>}
          <div className="flex1" />
          <span className="vz-stats" title={`语言：${Object.entries(result.stats.langs).map(([k, v]) => `${k} ${v}`).join('，')}\ngit ${result.stats.gitMs}ms · 解析 ${result.stats.parseMs}ms（新解析 ${result.stats.parsed}，缓存 ${result.stats.cached}）`}>
            {result.stats.files} 个源文件 · {(result.stats.ms / 1000).toFixed(1)}s{result.stats.cached > 0 ? ` · 缓存 ${result.stats.cached}` : ''}
          </span>
        </div>
        {result.warnings.map((w, i) => <div key={i} className="vz-warn"><Icon name="info" size={13} />{w}</div>)}
        {/* ---------------- tabs */}
        <div className="vz-tabs" role="tablist" aria-label="图表类型">
          {(knowledgeGraphOnly ? VIZ_VIEWS.filter((v) => v.id === 'arch') : VIZ_VIEWS).map((v) => (
            <button key={v.id} role="tab" aria-selected={tab === v.id} className={`vz-tab${tab === v.id ? ' on' : ''}${counts[v.id] ? '' : ' quiet'}`} onClick={() => setTab(v.id)} title={v.tip} data-testid={`viz-tab-${v.id}`}>
              <Icon name={v.icon} size={14} /><span>{v.label}</span>{counts[v.id] > 0 && <em>{counts[v.id]}</em>}
            </button>
          ))}
        </div>
        {/* ---------------- toolbar */}
        <div className="vz-toolbar">
          {tab === 'map' && result.map && <>
            <div className="seg" role="group" aria-label="地图画法">
              <button className={mapDisplay === 'tree' ? 'on' : ''} onClick={() => setMapDisplay('tree')} title="树状清单：像 codemap --diff，按目录列出每个文件的大小、行数、被引用数变化" data-testid="cm-display-tree"><Icon name="tree" size={13} /><span className="lbl">树状清单</span></button>
              <button className={mapDisplay === 'treemap' ? 'on' : ''} onClick={() => setMapDisplay('treemap')} title="方块图：面积 = 文件大小，按目录嵌套，一眼看出改动落在哪里" data-testid="cm-display-treemap"><Icon name="treemap" size={13} /><span className="lbl">方块图</span></button>
            </div>
            <div className="seg" role="group" aria-label="显示范围">
              <button className={mapScope === 'changed' ? 'on' : ''} onClick={() => setMapScope('changed')} title="只看改动的文件 + 可能受影响的文件 + 引用方变化的文件" data-testid="cm-scope-changed"><span className="lbl-always">只看改动</span></button>
              <button className={mapScope === 'all' ? 'on' : ''} onClick={() => setMapScope('all')} title="显示范围内的全部文件（没改动的目录默认折叠）" data-testid="cm-scope-all"><span className="lbl-always">全部文件</span></button>
            </div>
            {mapDisplay === 'treemap' && <div className="seg" role="group" aria-label="面积按">
              <button className={sizeSide === 'before' ? 'on' : ''} onClick={() => setSizeSide('before')} title="方块面积按改动前的文件大小（新增文件不显示）" data-testid="cm-size-before"><span className="lbl-always">改动前</span></button>
              <button className={sizeSide === 'after' ? 'on' : ''} onClick={() => setSizeSide('after')} title="方块面积按改动后的文件大小（删除的文件不显示）；来回切换可以看到哪里变大变小" data-testid="cm-size-after"><span className="lbl-always">改动后</span></button>
            </div>}
            <select className="input vz-hops" value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorBy)} aria-label="着色方式" title="颜色表示什么" data-testid="cm-color">
              <option value="status">按改动着色</option><option value="heat">按热度（被引用数）</option><option value="growth">按大小变化</option>
            </select>
            <div className="vz-search"><Icon name="search" size={13} /><input value={mapQ} onChange={(e) => setMapQ(e.target.value)} placeholder="筛选文件路径" aria-label="筛选文件" data-testid="cm-search" onKeyDown={(e) => { if (e.key === 'Escape') setMapQ('') }} /></div>
          </>}
          {tab !== 'map' && <>
          <div className="seg" role="group" aria-label="对比方式">
            <button className={mode === 'side' ? 'on' : ''} onClick={() => setMode('side')} title="并排：左改动前、右改动后，平移缩放同步" data-testid="viz-mode-side"><Icon name="split" size={13} /><span className="lbl">并排</span></button>
            <button className={mode === 'overlay' ? 'on' : ''} onClick={() => setMode('overlay')} title="叠加：一张图里用颜色区分新增 / 删除 / 修改" data-testid="viz-mode-overlay"><Icon name="layers" size={13} /><span className="lbl">叠加</span></button>
            <button className={mode === 'slider' ? 'on' : ''} onClick={() => setMode('slider')} title="滑块：拖动分割线在改动前后之间切换" data-testid="viz-mode-slider"><Icon name="slider" size={13} /><span className="lbl">滑块</span></button>
          </div>
          {tab === 'arch' && <div className="seg" role="group" aria-label="架构来源">
            <button className={archSrc === 'static' ? 'on' : ''} onClick={() => setArchSrc('static')} title="按目录与命名推断分层（无需 AI）">目录推断</button>
            <button className={archSrc === 'ai' ? 'on' : ''} onClick={() => setArchSrc('ai')} title="由 AI 依据静态事实划分职责分层" data-testid="viz-arch-ai"><Icon name="wand" size={12} />AI 分层</button>
          </div>}
          {graphTab && !aiOnly && <>
            <button className={`btn btn-sm vz-focus${focus ? ' on' : ''}`} aria-pressed={focus} onClick={() => setFocusPref((f) => ({ ...f, [tab]: !focus }))} title="只看改动的节点及其 N 跳以内的邻居" data-testid="viz-focus"><Icon name="focus" size={13} /><span className="lbl">只看变更</span></button>
            {focus && <select className="input vz-hops" value={hops} onChange={(e) => setHops(Number(e.target.value))} aria-label="邻居跳数" data-testid="viz-hops"><option value={0}>不含邻居</option><option value={1}>+1 跳邻居</option><option value={2}>+2 跳邻居</option><option value={3}>+3 跳邻居</option></select>}
            {center && <button className="vz-centerchip" onClick={() => setCenter(null)} title="退出聚焦">聚焦：{center.replace(/^[a-zA-Z]+:/, '').split(/[#/]/).pop()} <Icon name="x" size={11} /></button>}
            <div className="vz-search"><Icon name="search" size={13} /><input value={search} onChange={(e) => { setSearch(e.target.value); setSearchIdx(0) }} placeholder="搜索节点" aria-label="搜索节点" data-testid="viz-search"
              onKeyDown={(e) => { if (e.key === 'Enter') setSearchIdx((i) => i + (e.shiftKey ? -1 : 1)); if (e.key === 'Escape') setSearch('') }} />{search && info && <em>{info.matches ? `${((searchIdx % info.matches) + info.matches) % info.matches + 1}/${info.matches}` : '0'}</em>}</div>
          </>}
          <Legend heat={tab === 'impact'} tab={tab} />
          </>}
          <div className="flex1" />
          {info && graphTab && !aiOnly && tab !== 'map' && <span className="vz-info" title={`布局 ${info.layoutMs}ms`}>{info.shown < info.total ? `显示 ${info.shown}/${info.total}` : `${info.total} 个节点`}{info.clustered ? ` · 折叠 ${info.clustered} 组` : ''}</span>}
          {ai.running ? <button className="btn btn-sm" onClick={cancelAI} title={ai.text} data-testid="viz-ai-stop"><Spinner size={11} />停止 AI</button>
            : <button className={`btn btn-sm${aiRes ? ' on' : ''}`} onClick={() => { if (ai.model) { void runAI(); return } /* no AI yet: jump to the inline 去配置 AI card instead of doing nothing visible */ if (tab === 'flow') setFlowSrc('biz'); else if (tab === 'tour') setTourSrc('ai'); else { setTab('arch'); setArchSrc('ai') } }} disabled={!result} title={ai.model ? `AI 增强：生成业务流程、时序、状态与分层（${ai.model}）` : '未配置 AI：静态图表已可用；配置后可生成业务流程等'} data-testid="viz-ai"><Icon name="wand" size={13} /><span className="lbl">{aiRes ? 'AI 已增强' : 'AI 增强'}</span></button>}
          {graphTab && !aiOnly && tab !== 'map' && graph && <button className={`btn btn-sm${explain ? ' on' : ''}`} onClick={() => setExplain((x) => !x)} aria-pressed={explain} title={ai.model ? `AI 用几句话解读这张图，点名字跳到图上（${ai.model}）` : '未配置 AI：点开后可去配置'} data-testid="viz-explain-btn"><Icon name="info" size={13} /><span className="lbl">解读本图</span></button>}
          <button className="btn btn-sm" onClick={(e) => exportMenu(e.currentTarget)} disabled={tab === 'map' ? !result.map : tab === 'tour' ? !tour : aiOnly || (!graph && tab !== 'sequence') || (tab === 'sequence' && !picked)} data-testid="viz-export"><Icon name="download" size={13} /><span className="lbl">导出</span><Icon name="chevron-down" size={11} /></button>
        </div>
        {/* ---------------- canvas */}
        <div className={`vz-main${listKey || tab === 'tour' ? ' with-list' : ''}`}>
          {tab === 'tour' && <TourList tour={tour} src={tourSrc} setSrc={(x) => { setTourSrc(x); setSel(null); setCenter(null) }} seen={seen} onSeen={markSeen} onResetSeen={() => { setSeen(new Set()); if (result && tour) localStorage.removeItem(seenKey(result.key, tour.id + (tour.question ?? ''))) }}
            selected={sel?.type === 'node' ? sel.n.id : null} onPick={pickStep} question={tourQ} setQuestion={setTourQ}
            ai={{ model: ai.model, running: aiTour.running, text: aiTour.text, error: aiTour.error }} onRun={() => void runTour()} onCancel={cancelTour} onSettings={() => setView('settings')} />}
          {listKey && (
            <div className="vz-list" data-testid="viz-list">
              {tab === 'flow' && <div className="seg vz-list-seg"><button className={flowSrc === 'code' ? 'on' : ''} onClick={() => setFlowSrc('code')} title="函数的控制流（静态分析）">代码控制流</button><button className={flowSrc === 'biz' ? 'on' : ''} onClick={() => setFlowSrc('biz')} title="用户视角的业务流程（AI 生成）" data-testid="viz-flow-biz"><Icon name="wand" size={11} />业务流程</button></div>}
              <div className="vz-list-q"><Icon name="search" size={12} /><input value={listQ} onChange={(e) => setListQ(e.target.value)} placeholder={tab === 'flow' ? '筛选函数' : tab === 'sequence' ? '筛选调用链' : '筛选状态机'} aria-label="筛选列表" /></div>
              <div className="vz-list-items">
                {(listOf as (FlowEntry | SeqDiagram | StateMachine)[]).filter((x) => { const t = 'label' in x ? x.label : 'title' in x ? x.title : x.name; return !listQ || t.toLowerCase().includes(listQ.toLowerCase()) }).map((x) => {
                  const t = 'label' in x ? x.label : 'title' in x ? x.title : x.name
                  const sub = 'file' in x && x.file ? x.file.split('/').pop() : 'origin' in x && x.origin ? x.origin : ''
                  return (
                    <button key={x.id} className={`vz-li st-${x.status}${picked?.id === x.id ? ' on' : ''}`} onClick={() => { setPick((p) => ({ ...p, [listKey]: x.id })); setSel(null); setCenter(null) }} title={`${t}${sub ? `\n${sub}` : ''}`}>
                      <span className={`vz-dot st-${x.status}`} /><span className="vz-li-t">{t}</span>
                      {x.source === 'ai' && <em className="vz-ai-tag">AI</em>}
                      {sub && <span className="vz-li-s">{sub}</span>}
                    </button>
                  )
                })}
                {!listOf.length && !(tab === 'flow' && flowSrc === 'biz') && <div className="vz-li-empty">{tab === 'flow' ? '这次改动没有可画控制流的函数' : tab === 'sequence' ? '没有找到跨模块的调用链' : '没有检测到状态枚举 / 状态机'}{ai.model && tab !== 'flow' ? '，可试试 AI 增强' : ''}</div>}
              </div>
            </div>
          )}
          <div className="vz-canvas">
            {tab === 'map' ? (
              result.map ? <CodeMapView ref={mapExp} result={result} map={result.map} display={mapDisplay} scope={mapScope} colorBy={colorBy} sizeSide={sizeSide} q={mapQ}
                selected={sel?.type === 'node' && sel.n.id.startsWith('m:') ? sel.n.id.slice(2) : null} onSelect={pickMapFile} onShowAll={() => setMapScope('all')} />
                : <div className="vz-center"><div className="vz-none"><Icon name="codemap" size={28} /><b>请重新分析</b><span>这个结果来自旧版本，没有代码地图数据。</span><button className="btn btn-sm" onClick={run}>重新分析</button></div></div>
            ) : tab === 'tour' && !graph ? (
              <div className="vz-center"><div className="vz-none"><Icon name="tour" size={28} />{tourSrc === 'ai' && !aiTour.tour
                ? <><b>{aiTour.running ? 'AI 正在规划代码路径…' : 'AI 代码路径'}</b><span>{aiTour.running ? aiTour.text : '在左侧输入问题，AI 会从静态分析找到的真实代码位置里挑出路径，分组编号，点每一步直达代码。'}</span></>
                : <><b>没有可导览的改动</b><span>这次改动没有源代码文件。</span></>}</div></div>
            ) : aiOnly ? (
              <div className="vz-center"><AICard ai={ai} what={tab === 'arch' ? 'AI 职责分层' : '业务流程图'} onRun={() => void runAI()} onCancel={cancelAI} onSettings={() => setView('settings')} /></div>
            ) : tab === 'sequence' ? (
              picked ? <SequenceView ref={exp} key={picked.id} d={picked as SeqDiagram} mode={mode} beforeLabel={result.beforeLabel} afterLabel={result.afterLabel}
                selected={sel?.type === 'msg' ? sel.path : null} onSelect={(m, path) => setSel(m && path ? { type: 'msg', m, path } : null)} />
                : <div className="vz-center">{ai.model ? <AICard ai={ai} what="时序图" onRun={() => void runAI()} onCancel={cancelAI} onSettings={() => setView('settings')} /> : <div className="vz-none"><Icon name="sequence" size={28} /><b>没有可画的调用链</b><span>改动的函数没有调用其它模块。配置 AI 后可以从 diff 推断时序。</span><button className="btn btn-sm" onClick={() => setView('settings')}>去配置 AI</button></div>}</div>
            ) : graph ? (
              <GraphDiff ref={exp} key={`${tab}:${picked?.id ?? ''}:${archSrc}:${tab === 'tour' ? `${tour?.id}${tour?.question ?? ''}` : ''}`} graph={graph} kind={LAYOUT_OF[tab]} mode={mode} focus={focus} hops={hops} center={center}
                search={search} searchIndex={searchIdx} selected={sel?.type === 'node' ? sel.n.id : null} onSelect={onSelectNode}
                beforeLabel={result.beforeLabel} afterLabel={result.afterLabel} onInfo={setInfo}
                title={`${VIZ_VIEWS.find((v) => v.id === tab)?.label ?? ''} · ${scopeLabel(result.scope)}`}
                emptyHint={focus ? <span>这张图里没有改动的节点。<button className="link" onClick={() => setFocusPref((f) => ({ ...f, [tab]: false }))}>显示全部</button></span> : '这次改动在这张图里没有内容'} />
            ) : (
              <div className="vz-center">{tab === 'state' && ai.model ? <AICard ai={ai} what="状态图" onRun={() => void runAI()} onCancel={cancelAI} onSettings={() => setView('settings')} />
                : <div className="vz-none"><Icon name={VIZ_VIEWS.find((v) => v.id === tab)?.icon ?? 'viz'} size={28} /><b>{tab === 'state' ? '没有检测到状态机' : tab === 'flow' ? '没有可画控制流的函数' : '没有内容'}</b><span>{tab === 'state' ? '支持：联合字面量类型、枚举、reducer / switch 迁移、xstate createMachine。' : '这次改动没有改到函数体。'}</span></div>}</div>
            )}
            {explain && graph && graphTab && !aiOnly && tab !== 'map' && <DiagramExplain graph={graph} view={VIZ_VIEWS.find((v) => v.id === tab)?.label ?? tab} scope={scopeLabel(result.scope)} model={ai.model}
              onFocus={(id) => exp.current?.focus?.(id)} onSettings={() => setView('settings')} onClose={() => setExplain(false)} />}
            {sel && <NodePanel key={sel.type === 'node' ? sel.n.id : sel.path} sel={sel} resultId={result.id} onClose={() => setSel(null)} onPick={pickNode} onFocus={(id) => { setCenter(id); setSel(null) }} />}
          </div>
        </div>
      </>)}
      {!result && !running && !error && <div className="vz-center"><Spinner size={16} /></div>}
      {!result && running && <div className="vz-center vz-boot"><Icon name="viz" size={34} /><b>正在分析改动…</b><span>读取两侧的源码（不切换分支），用 tree-sitter 解析 TS/JS、Python、Java、Go、Rust、C#、Kotlin</span></div>}
      <span hidden data-theme-probe={theme} />
    </div>
  )
}
