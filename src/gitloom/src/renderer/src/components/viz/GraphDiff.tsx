// One diagram, three ways to compare: 并排 (before | after, synced pan/zoom), 叠加 (merged, colour coded),
// 滑块 (after wiped over before). The merged graph is laid out once, so every mode shares the same coordinates.
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react'
import { ReactFlow, ReactFlowProvider, MiniMap, Background, BackgroundVariant, MarkerType, type Viewport } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { toPng } from 'html-to-image'
import type { DiffGraph, GNode, GEdge, EdgeKind, DiffStatus } from '@shared/viz'
import { EDGE_NOTE } from '../../lib/vizSe'
import { autoCluster, changeCluster, changeOrder, focusGraph, searchNodes, shortestPath, tidyLabels, toMermaid, toPlantUML, viewSummary, type DiagramKind } from '../../lib/vizGraph'
import { absBoxes, graphSvg, sideBySideSvg, LIGHT, DARK } from '../../lib/vizSvg'
import { layoutGraph, type Layout, type LayoutKind } from '../../lib/vizLayout'
import { NODE_TYPES, EDGE_TYPES, nodeTypeOf, shownIn, type Pane, type VNode, type VEdge } from './VizNodes'
import { Icon } from '../Icon'
import { Spinner } from '../ui'

export type CompareMode = 'side' | 'overlay' | 'slider'
export interface ExportApi { png: () => Promise<string>; svg: () => Promise<string>; mermaid: () => string; plantuml: () => string; fit: () => void; pngView?: () => Promise<string>; focus?: (id: string) => void }
export interface GraphDiffProps {
  graph: DiffGraph
  kind: LayoutKind
  mode: CompareMode
  focus: boolean
  hops: number
  /** focus on the neighbourhood of this node instead of all changes */
  center?: string | null
  search: string
  searchIndex: number
  selected?: string | null
  onSelect: (n: GNode | null, edges?: GEdge[]) => void
  beforeLabel: string
  afterLabel: string
  onInfo?: (i: { shown: number; total: number; clustered: number; matches: number; layoutMs: number }) => void
  emptyHint?: React.ReactNode
  /** diagram title for the exported picture */
  title?: string
  /**
   * HEAD / current-state only (架构与知识): single pane, no 前/叠加/后/播放 or change-nav.
   * Diff compare chrome stays under 看懂改动.
   */
  present?: boolean
  /** node ids whose file/symbol refs no longer exist at HEAD */
  staleIds?: ReadonlySet<string> | string[]
}


/** UML-ish arrowheads: hollow triangle = generalization/realization; open = dependency; closed = call/flow. */
function umlMarkerEnd(kind: EdgeKind, status: DiffStatus, color: string, pane: string): string | { type: MarkerType; width: number; height: number; color: string } {
  if (kind === 'extends' || kind === 'implements') return `url(#uml-gen-${status}-${pane})`
  if (kind === 'depends' || kind === 'uses' || kind === 'import') return `url(#uml-open-${status}-${pane})`
  return { type: MarkerType.ArrowClosed, width: 16, height: 16, color }
}

function UmlMarkerDefs({ pane, colors }: { pane: string; colors: Record<string, string> }) {
  const statuses = ['added', 'removed', 'modified', 'moved', 'unchanged'] as DiffStatus[]
  return (
    <svg className="uml-defs" width={0} height={0} style={{ position: 'absolute', overflow: 'hidden' }} aria-hidden>
      <defs>
        {statuses.map((s) => (
          <React.Fragment key={s}>
            <marker id={`uml-gen-${s}-${pane}`} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse">
              <path d="M1,1 L11,6 L1,11 z" fill="var(--panel2)" stroke={colors[s]} strokeWidth="1.4" />
            </marker>
            <marker id={`uml-open-${s}-${pane}`} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
              <path d="M1,1 L11,6 L1,11" fill="none" stroke={colors[s]} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          </React.Fragment>
        ))}
      </defs>
    </svg>
  )
}

const CLUSTER_AT = 150
/** change-centric clustering (0.5.2): above this many boxes the unchanged context is folded */
export const CHANGE_MAX = 40
const CC_KINDS = new Set<LayoutKind>(['modules', 'calls', 'impact', 'classes'])
/** below this zoom text is unreadable: frame the changes instead of the whole picture */
export const READABLE = 0.5
const NOUN: Record<LayoutKind, [string, string]> = { modules: ['文件', '依赖'], calls: ['函数', '调用'], classes: ['类型', '关系'], impact: ['文件', '依赖'], flow: ['步骤', '连线'], state: ['状态', '迁移'], arch: ['模块', '依赖'] }
const palette = () => {
  const cs = getComputedStyle(document.documentElement)
  const v = (k: string) => cs.getPropertyValue(k).trim() || '#888'
  return { added: v('--add'), removed: v('--del'), modified: v('--mod'), moved: v('--ren'), unchanged: v('--faint'), bg: v('--bg') }
}
const short = (id: string) => id.replace(/^[a-zA-Z]+:/, '').split(/[#/]/).pop() || id
const bucket = (a: number) => Math.round(Math.log2(Math.max(0.3, Math.min(5, a))) * 3) / 3
const cssId = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'))

/** rasterise an SVG string to a base64 PNG (no DOM capture: the WHOLE diagram, crisp at 2×) */
export async function svgToPng(svg: string, w: number, h: number, bg: string): Promise<string> {
  const scale = Math.max(0.25, Math.min(2, 16000 / w, 16000 / h, Math.sqrt(120e6 / Math.max(1, w * h))))
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('SVG 渲染失败')); img.src = url })
    const c = document.createElement('canvas'); c.width = Math.ceil(w * scale); c.height = Math.ceil(h * scale)
    const ctx = c.getContext('2d')!; ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0, w, h)
    const d = c.toDataURL('image/png'); return d.slice(d.indexOf(',') + 1)
  } finally { URL.revokeObjectURL(url) }
}
const svgSize = (svg: string) => { const m = /<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/.exec(svg); return m ? { w: +m[1], h: +m[2] } : { w: 1200, h: 800 } }

export const GraphDiff = forwardRef<ExportApi, GraphDiffProps>(function GraphDiff(p, ref) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  useEffect(() => setExpanded(new Set()), [p.graph])
  // 1) focus → 2) tidy labels → 3) change-centric clustering (click a cluster to open it) → 4) safety cap
  const shown = useMemo(() => {
    const f = tidyLabels(p.focus || p.center ? focusGraph(p.graph, p.hops, p.center ?? undefined) : p.graph)
    if (!CC_KINDS.has(p.kind)) return autoCluster(f, CLUSTER_AT, expanded)
    const a = changeCluster(f, CHANGE_MAX, expanded)
    const b = autoCluster(a.graph, CLUSTER_AT, expanded)
    return { graph: b.graph, collapsed: [...a.collapsed, ...b.collapsed] }
  }, [p.graph, p.focus, p.hops, p.center, p.kind, expanded])

  // pane size → layout aspect (components are packed to the pane shape instead of one long strip)
  const host = useRef<HTMLDivElement>(null)
  const [hostSize, setHostSize] = useState<{ W: number; H: number } | null>(null)
  useEffect(() => {
    const el = host.current; if (!el) return
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) setHostSize({ W: r.width, H: r.height }) })
    ro.observe(el); return () => ro.disconnect()
  }, [])
  const aspectB = hostSize ? bucket((p.mode === 'side' ? hostSize.W / 2 : hostSize.W) / Math.max(1, hostSize.H - 30)) : null

  // 5) deterministic layout of the merged graph (ELK in a worker)
  const [layout, setLayout] = useState<{ g: DiffGraph; L: Layout; ms: number; abs: Map<string, { x: number; y: number; w: number; h: number }> } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (aspectB === null) return
    let alive = true
    setBusy(true)
    const t0 = performance.now()
    layoutGraph(shown.graph, p.kind, { aspect: 2 ** aspectB }).then((L) => { if (alive) { setLayout({ g: shown.graph, L, ms: Math.round(performance.now() - t0), abs: absBoxes(shown.graph, L) }); setBusy(false) } })
      .catch((e) => { console.error('[viz] layout failed', e); if (alive) setBusy(false) })
    return () => { alive = false }
  }, [shown.graph, p.kind, aspectB])

  const matches = useMemo(() => (layout ? searchNodes(layout.g, p.search) : []), [layout, p.search])
  useEffect(() => { if (layout) p.onInfo?.({ shown: layout.g.nodes.filter((n) => !n.group).length, total: p.graph.nodes.filter((n) => !n.group).length, clustered: shown.collapsed.length, matches: matches.length, layoutMs: layout.ms }) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, matches.length])

  // ---- viewport (shared by both panes: synced pan / zoom)
  const [vp, setVp] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })
  const paneSize = useCallback(() => {
    const el = host.current?.querySelector('.vz-pane') as HTMLElement | null
    return { W: el?.clientWidth || 600, H: el?.clientHeight || 400 }
  }, [])
  const order = useMemo(() => (layout ? changeOrder(layout.g, (id) => { const b = layout.abs.get(id); return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null }, layout.L.dir) : []), [layout])
  const [navIdx, setNavIdx] = useState(-1)
  const [framed, setFramed] = useState<'all' | 'changes' | 'nav' | null>(null)
  const fitAllZoom = useCallback(() => {
    if (!layout) return 1
    const { W, H } = paneSize()
    return Math.min((W - 32) / Math.max(1, layout.L.width), (H - 64) / Math.max(1, layout.L.height), 1.1)
  }, [layout, paneSize])
  const fit = useCallback(() => {
    if (!layout) return
    const { W, H } = paneSize()
    const { width: w, height: h } = layout.L
    const zoom = Math.max(0.08, fitAllZoom())
    setVp({ zoom, x: (W - w * zoom) / 2, y: h * zoom < H - 64 ? (H - h * zoom) / 2 + 6 : 34 })
    setFramed('all')
  }, [layout, paneSize, fitAllZoom])
  const centerOn = useCallback((b: { x: number; y: number; w: number; h: number }, zoom: number) => {
    const { W, H } = paneSize()
    setVp({ zoom, x: W / 2 - (b.x + b.w / 2) * zoom, y: (H + 14) / 2 - (b.y + b.h / 2) * zoom })
  }, [paneSize])
  /** frame every change if that is readable, else the window (at a readable zoom) that shows the MOST changes */
  const frameChanges = useCallback(() => {
    if (!layout || !order.length) { fit(); return }
    const bs = order.map((id) => layout.abs.get(id)!).filter(Boolean)
    const box = (xs: typeof bs) => { const x0 = Math.min(...xs.map((b) => b.x)); const y0 = Math.min(...xs.map((b) => b.y)); return { x: x0, y: y0, w: Math.max(...xs.map((b) => b.x + b.w)) - x0, h: Math.max(...xs.map((b) => b.y + b.h)) - y0 } }
    const { W, H } = paneSize()
    const all = box(bs)
    const z = Math.min((W - 48) / Math.max(1, all.w), (H - 80) / Math.max(1, all.h), 1)
    setNavIdx(-1); setFramed('changes')
    if (z >= READABLE) { centerOn(all, z); return }
    const Z = 0.72; const ww = (W - 48) / Z; const wh = (H - 80) / Z
    const cand = bs.slice(0, 160)
    let best = [cand[0]]
    for (const a of cand) for (const b of cand) {
      const x0 = a.x; const y0 = b.y
      const inWin = cand.filter((c) => c.x >= x0 - 1 && c.x + c.w <= x0 + ww && c.y >= y0 - 1 && c.y + c.h <= y0 + wh)
      if (inWin.length > best.length) best = inWin
    }
    const bb = box(best)
    centerOn(bb, Math.max(Z, Math.min(1, (W - 48) / Math.max(1, bb.w), (H - 80) / Math.max(1, bb.h))))
  }, [layout, order, paneSize, centerOn, fit])
  const goChange = useCallback((step: number) => {
    if (!layout || !order.length) return
    setFlash(null)
    setNavIdx((i0) => {
      const i = ((i0 < 0 ? (step > 0 ? -1 : 0) : i0) + step + order.length) % order.length
      const b = layout.abs.get(order[i]); if (b) centerOn(b, Math.max(0.8, Math.min(vp.zoom, 1.3)))
      return i
    })
    setFramed('nav')
  }, [layout, order, centerOn, vp.zoom])
  const autoView = useCallback(() => { if (!layout) return; if (fitAllZoom() >= READABLE || !order.length) fit(); else frameChanges() }, [layout, fitAllZoom, order.length, fit, frameChanges])
  const lastFit = useRef('')
  const pendingFocus = useRef<string | null>(null)
  useEffect(() => {
    if (!layout) return
    const sig = `${p.kind}|${p.mode}|${layout.L.width}x${layout.L.height}`
    if (sig === lastFit.current) return
    lastFit.current = sig
    const pf = pendingFocus.current; pendingFocus.current = null
    const b = pf ? layout.abs.get(pf) : undefined
    requestAnimationFrame(() => { if (b) centerOn(b, Math.max(vp.zoom, Math.min(0.9, fitAllZoom() * 3))); else autoView() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, p.mode, p.kind])
  // search: centre the current match
  useEffect(() => {
    if (!layout || !matches.length) return
    const id = matches[((p.searchIndex % matches.length) + matches.length) % matches.length]
    const a = layout.abs.get(id); if (!a) return
    centerOn(a, Math.max(vp.zoom, 0.9))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, p.searchIndex, layout])

  // ---- hover (synced across panes), path between two nodes, overlay before→after animation
  const [hover, setHover] = useState<string | null>(null)
  const [pathA, setPathA] = useState<string | null>(null)
  const [path, setPath] = useState<{ a: string; b: string; nodes: Set<string>; edges: Set<string>; steps: number; directed: boolean } | null | 'none'>(null)
  useEffect(() => { setPathA(null); setPath(null); setNavIdx(-1); setHover(null); setFlash(null) }, [layout?.g])
  const [ovSide, setOvSide] = useState<'both' | 'before' | 'after'>(p.present ? 'after' : 'both')
  const [playing, setPlaying] = useState(false)
  useEffect(() => { if (p.present) { setPlaying(false); setOvSide('after') } }, [p.present])
  useEffect(() => {
    if (!playing) return
    setOvSide('before')
    const t = setInterval(() => setOvSide((s) => (s === 'before' ? 'after' : 'before')), 1500)
    return () => clearInterval(t)
  }, [playing])
  useEffect(() => { if (p.mode !== 'overlay') { setPlaying(false); setOvSide('both') } }, [p.mode])

  const pal = useMemo(palette, [p.mode, layout])
  const neigh = useMemo(() => {
    if (!p.selected || !layout) return null
    const s = new Set([p.selected])
    for (const e of layout.g.edges) { if (e.source === p.selected) s.add(e.target); if (e.target === p.selected) s.add(e.source) }
    return s
  }, [p.selected, layout])
  const current = matches.length ? matches[((p.searchIndex % matches.length) + matches.length) % matches.length] : null
  const [flash, setFlash] = useState<string | null>(null)
  const navId = navIdx >= 0 ? order[navIdx] ?? null : flash
  const onPath = path && path !== 'none' ? path : null
  const build = useCallback((pane: Pane): { nodes: VNode[]; edges: VEdge[] } => {
    if (!layout) return { nodes: [], edges: [] }
    const { g, L } = layout
    const by = new Map(g.nodes.map((n) => [n.id, n]))
    const depth = (n: GNode) => { let d = 0; let q = n.parent; while (q && by.has(q)) { d++; q = by.get(q)!.parent } return d }
    const ms = new Set(matches)
    const staleSet = p.staleIds instanceof Set ? p.staleIds : new Set(p.staleIds ?? [])
    const ghost = pane === 'both' && ovSide !== 'both' ? ovSide : null
    const nodes: VNode[] = [...g.nodes].sort((a, b) => depth(a) - depth(b) || (a.id < b.id ? -1 : 1)).map((n) => {
      const b = L.boxes[n.id] ?? { x: 0, y: 0, w: 120, h: 40 }
      const hidden = !shownIn(n.status, pane)
      const dim = !n.group && ((!!p.search && ms.size > 0 && !ms.has(n.id)) || (!!neigh && !neigh.has(n.id)) || (!!onPath && !onPath.nodes.has(n.id)))
      return {
        id: n.id, type: nodeTypeOf(n), position: { x: b.x, y: b.y }, width: b.w, height: b.h, style: { width: b.w, height: b.h },
        ...(n.parent && by.has(n.parent) ? { parentId: n.parent } : {}), hidden, selectable: !n.group, draggable: false,
        zIndex: n.group ? 0 : 2,
        data: { n, pane, dir: L.dir, hl: n.id === current || ms.has(n.id), sel: n.id === p.selected, dim, nav: n.id === navId || n.id === pathA, path: !!onPath?.nodes.has(n.id), gone: !!ghost && !shownIn(n.status, ghost), stale: staleSet.has(n.id), ...(p.kind === 'impact' ? { heat: Math.min(4, n.dist ?? 0) } : {}) }
      }
    })
    const hiddenIds = new Set(nodes.filter((n) => n.hidden).map((n) => n.id))
    const edges: VEdge[] = g.edges.filter((e) => by.has(e.source) && by.has(e.target)).map((e) => {
      const hidden = !shownIn(e.status, pane) || hiddenIds.has(e.source) || hiddenIds.has(e.target)
      const color = pal[e.status]
      const route = L.routes?.[e.id]
      return {
        id: e.id, source: e.source, target: e.target, type: 'diff', hidden, zIndex: 1,
        markerEnd: umlMarkerEnd(e.kind, e.status, color, pane),
        data: {
          e, pane, curve: p.kind === 'state' || p.kind === 'arch' ? 'bezier' : 'step', ...(route ? { route } : {}),
          hl: (!!neigh && neigh.has(e.source) && neigh.has(e.target) && (e.source === p.selected || e.target === p.selected)) || !!onPath?.edges.has(e.id),
          dim: (!!neigh && e.source !== p.selected && e.target !== p.selected) || (!!onPath && !onPath.edges.has(e.id)),
          path: !!onPath?.edges.has(e.id), gone: !!ghost && !shownIn(e.status, ghost)
        }
      }
    })
    return { nodes, edges }
  }, [layout, matches, current, neigh, p.selected, p.search, p.kind, pal, navId, pathA, onPath, ovSide])
  const before = useMemo(() => (p.mode === 'overlay' ? null : build('before')), [build, p.mode])
  const after = useMemo(() => build(p.mode === 'overlay' ? 'both' : 'after'), [build, p.mode])

  // synced hover: a tiny style rule instead of rebuilding every node
  const hoverCss = useMemo(() => {
    if (!hover || !layout) return ''
    const es = layout.g.edges.filter((e) => e.source === hover || e.target === hover)
    const ns = new Set(es.flatMap((e) => [e.source, e.target])); ns.delete(hover)
    return `.vz-graph .vn[data-id="${cssId(hover)}"]{box-shadow:0 0 0 2px var(--accent),var(--shadow-md)}` +
      (ns.size ? [...ns].map((id) => `.vz-graph .vn[data-id="${cssId(id)}"]`).join(',') + '{box-shadow:0 0 0 1.5px color-mix(in srgb,var(--accent) 55%,transparent)}' : '') +
      (es.length ? es.map((e) => `.vz-graph path.react-flow__edge-path[id="${cssId(e.id)}"]`).join(',') + '{stroke-width:2.6px;opacity:1}' : '')
  }, [hover, layout])

  const [tip, setTip] = useState<{ x: number; y: number; e: GEdge } | null>(null)
  const onEdgeEnter = useCallback((ev: React.MouseEvent, edge: VEdge) => {
    const r = host.current!.getBoundingClientRect()
    setTip({ x: ev.clientX - r.left + 12, y: ev.clientY - r.top + 12, e: edge.data!.e })
  }, [])
  const expand = useCallback((id: string) => {
    pendingFocus.current = id.endsWith('#rest') ? id.slice(0, -5) : id.startsWith('dir:') || id.startsWith('up:') ? null : id
    setExpanded((s) => new Set([...s, id]))
  }, [])
  const original = useCallback((n: GNode) => p.graph.nodes.find((x) => x.id === n.id) ?? n, [p.graph])
  const onNodeClick = useCallback((ev: React.MouseEvent, n: VNode) => {
    const g = n.data.n
    if (g.group) return
    if (g.kind === 'cluster' && !ev.shiftKey) { expand(g.id); return }
    if (ev.shiftKey && layout) {
      // Shift+点击：两点之间的路径
      if (!pathA || pathA === g.id) { setPathA(g.id); setPath(null); return }
      const r = shortestPath(layout.g, pathA, g.id)
      setPath(r ? { a: pathA, b: g.id, nodes: new Set(r.nodes), edges: new Set(r.edges), steps: r.edges.length, directed: r.directed } : 'none')
      setPathA(null)
      return
    }
    p.onSelect(original(g), layout?.g.edges.filter((e) => e.source === n.id || e.target === n.id))
  }, [p, layout, pathA, expand, original])
  const onNodeDbl = useCallback((_: React.MouseEvent, n: VNode) => { if (n.data.n.kind === 'cluster') expand(n.id) }, [expand])
  const [slider, setSlider] = useState(50)
  const [miniPref, setMiniPref] = useState<boolean | null>(null)
  const bigPicture = !!layout && vp.zoom > fitAllZoom() * 1.25 && paneSize().W >= 520   // part of the picture is off-screen → the minimap helps (not on tiny panes)
  const showMini = miniPref ?? bigPicture

  const exportSvg = useCallback(() => {
    if (!layout) return ''
    const theme = document.documentElement.dataset.theme === 'light' ? LIGHT : DARK
    const title = p.title ?? '变更可视化'
    return p.mode === 'overlay'
      ? graphSvg(layout.g, layout.L, { side: 'both', theme, title, subtitle: `${p.beforeLabel} → ${p.afterLabel}`, legend: true })
      : sideBySideSvg(layout.g, layout.L, { theme, title, beforeLabel: p.beforeLabel, afterLabel: p.afterLabel })
  }, [layout, p.mode, p.title, p.beforeLabel, p.afterLabel])
  useImperativeHandle(ref, () => ({
    fit,
    focus: (id: string) => {
      if (!layout) return
      // folded into a cluster? point at the cluster that holds it
      let target = layout.abs.has(id) ? id : null
      if (!target) { const parent = p.graph.nodes.find((n) => n.id === id)?.parent; target = layout.g.nodes.find((n) => n.kind === 'cluster' && (n.id === parent || n.id === `${parent}#rest` || (n.note ?? '').split('\n').includes(p.graph.nodes.find((x) => x.id === id)?.label ?? '\u0000')))?.id ?? null }
      if (!target) return
      const i = order.indexOf(target)
      setNavIdx(i); setFlash(i < 0 ? target : null); setFramed('nav')
      centerOn(layout.abs.get(target)!, Math.max(0.8, Math.min(vp.zoom, 1.3)))
    },
    png: async () => { const s = exportSvg(); const { w, h } = svgSize(s); return svgToPng(s, w, h, document.documentElement.dataset.theme === 'light' ? LIGHT.bg : DARK.bg) },
    svg: async () => exportSvg(),
    pngView: async () => {
      const el = host.current!.querySelector('.vz-panes') as HTMLElement
      const url = await toPng(el, { backgroundColor: pal.bg, pixelRatio: 2, filter: (n) => !(n as HTMLElement).classList?.contains('react-flow__minimap') && !(n as HTMLElement).classList?.contains('vz-zoom') })
      return url.slice(url.indexOf(',') + 1)
    },
    mermaid: () => toMermaid(layout?.g ?? shown.graph, diagramKind(p.kind), layout?.L.dir === 'DOWN' ? 'TD' : 'LR'),
    plantuml: () => toPlantUML(layout?.g ?? shown.graph, diagramKind(p.kind))
  }), [fit, pal, layout, shown.graph, p.kind, exportSvg, order, centerOn, vp.zoom, p.graph])

  const zoomBy = (f: number) => { const { W, H } = paneSize(); setVp((v) => { const zoom = Math.max(0.08, Math.min(2.5, v.zoom * f)); return { zoom, x: W / 2 - ((W / 2 - v.x) / v.zoom) * zoom, y: H / 2 - ((H / 2 - v.y) / v.zoom) * zoom } }) }
  const collapseAll = () => { setExpanded(new Set()); lastFit.current = '' }
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, [role="slider"]') || e.ctrlKey || e.metaKey || e.altKey) return
    const k = e.key
    const pan = (dx: number, dy: number) => setVp((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    if (k === 'n' || k === ']') goChange(1)
    else if (k === 'N' || k === 'p' || k === '[') goChange(-1)
    else if (k === 'f' || k === 'F' || k === '0') fit()
    else if (k === 'c' || k === 'C') frameChanges()
    else if (k === '+' || k === '=') zoomBy(1.25)
    else if (k === '-' || k === '_') zoomBy(0.8)
    else if (k === 'ArrowLeft') pan(80, 0)
    else if (k === 'ArrowRight') pan(-80, 0)
    else if (k === 'ArrowUp') pan(0, 80)
    else if (k === 'ArrowDown') pan(0, -80)
    else if (k === 'Enter' && navId && layout) { const n = layout.g.nodes.find((x) => x.id === navId); if (n) p.onSelect(original(n), layout.g.edges.filter((x) => x.source === navId || x.target === navId)) }
    else if (k === 'Escape') { setPath(null); setPathA(null) }
    else if (k === '/') { (document.querySelector('[data-testid="viz-search"]') as HTMLInputElement | null)?.focus() }
    else return
    e.preventDefault()
  }
  const flow = (data: { nodes: VNode[]; edges: VEdge[] }, pane: Pane, mini: boolean) => (
    <ReactFlowProvider>
      <ReactFlow nodes={data.nodes} edges={data.edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
        viewport={vp} onViewportChange={setVp} minZoom={0.08} maxZoom={2.5}
        onNodeClick={onNodeClick} onNodeDoubleClick={onNodeDbl} onPaneClick={() => p.onSelect(null)}
        onNodeMouseEnter={(_, n) => { if (!n.data.n.group) setHover(n.id) }} onNodeMouseLeave={() => setHover(null)}
        onEdgeMouseEnter={onEdgeEnter} onEdgeMouseLeave={() => setTip(null)}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable zoomOnDoubleClick={false} proOptions={{ hideAttribution: true }}
        colorMode={document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'} onlyRenderVisibleElements={data.nodes.length > 400}>
        <UmlMarkerDefs pane={pane} colors={pal} />
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="vz-bg" />
        {mini && showMini && <MiniMap pannable zoomable ariaLabel={`小地图（${pane === 'before' ? '改动前' : '改动后'}）`} nodeStrokeWidth={2}
          nodeColor={(n) => { const s = (n.data as VNode['data']).n.status; return (n.data as VNode['data']).n.group ? 'transparent' : s === 'unchanged' ? pal.unchanged + '66' : pal[s] }} maskColor="rgba(0,0,0,.25)" />}
      </ReactFlow>
    </ReactFlowProvider>
  )
  const empty = layout && !layout.g.nodes.some((n) => !n.group)
  const sum = useMemo(() => viewSummary(p.graph, NOUN[p.kind][0], NOUN[p.kind][1]), [p.graph, p.kind])
  const zcls = vp.zoom < 0.35 ? 'z-far' : vp.zoom < 0.6 ? 'z-mid' : 'z-near'
  const nameOf = (id: string) => layout?.g.nodes.find((n) => n.id === id)?.label.split('\n')[0] ?? short(id)
  return (
    <div className={`vz-graph mode-${p.mode} ${zcls}${playing ? ' playing' : ''}${p.present ? ' present' : ''}`} ref={host} data-kind={p.kind} tabIndex={0} onKeyDown={onKey}
      style={{ '--vz-inv': String(Math.min(4.5, 1 / vp.zoom)) } as React.CSSProperties} data-testid="viz-graph">
      {hoverCss && <style>{hoverCss}</style>}
      <div className="vz-panes">
        {p.mode === 'side' && before && (<>
          <div className="vz-pane pane-before" data-testid="viz-pane-before"><div className="vz-pane-tag"><span className="dot rm" />改动前<em>{p.beforeLabel}</em></div>{flow(before, 'before', false)}</div>
          <div className="vz-pane pane-after" data-testid="viz-pane-after"><div className="vz-pane-tag"><span className="dot ad" />改动后<em>{p.afterLabel}</em></div>{flow(after, 'after', true)}</div>
        </>)}
        {p.mode === 'overlay' && <div className="vz-pane pane-both" data-testid={p.present ? 'k-graph-canvas' : 'viz-pane-overlay'}>
          {p.present
            ? <div className="vz-pane-tag"><span className="dot md" />当前架构<em>{p.afterLabel || 'HEAD'}</em></div>
            : <>
          <div className="vz-pane-tag"><span className="dot md" />叠加对比<em>{p.beforeLabel} → {p.afterLabel}</em></div>
          <div className="vz-ov-switch seg" role="group" aria-label="叠加图显示">
            <button className={ovSide === 'before' && !playing ? 'on' : ''} onClick={() => { setPlaying(false); setOvSide('before') }} title="淡出新增的内容，只看改动前" data-testid="viz-ov-before">前</button>
            <button className={ovSide === 'both' && !playing ? 'on' : ''} onClick={() => { setPlaying(false); setOvSide('both') }} title="前后叠在一起，用颜色区分" data-testid="viz-ov-both">叠加</button>
            <button className={ovSide === 'after' && !playing ? 'on' : ''} onClick={() => { setPlaying(false); setOvSide('after') }} title="淡出删除的内容，只看改动后" data-testid="viz-ov-after">后</button>
            <button className={playing ? 'on' : ''} onClick={() => { if (playing) { setPlaying(false); setOvSide('both') } else setPlaying(true) }} title={playing ? '停止播放' : '自动在改动前后之间切换，看哪些东西出现 / 消失'} aria-pressed={playing} data-testid="viz-ov-play"><Icon name={playing ? 'pause' : 'play'} size={11} />{playing ? (ovSide === 'before' ? '前' : '后') : '播放'}</button>
          </div>
            </>}
          {flow(after, 'both', true)}
        </div>}
        {p.mode === 'slider' && before && (
          <div className="vz-pane pane-slider" data-testid="viz-pane-slider">
            <div className="vz-slide-layer">{flow(before, 'before', false)}</div>
            <div className="vz-slide-layer top" style={{ clipPath: `inset(0 0 0 ${slider}%)` }}>{flow(after, 'after', true)}</div>
            <div className="vz-pane-tag"><span className="dot rm" />改动前<em>{p.beforeLabel}</em></div>
            <div className="vz-pane-tag right"><span className="dot ad" />改动后<em>{p.afterLabel}</em></div>
            <div className="vz-slider-handle" style={{ left: `${slider}%` }} role="slider" aria-label="前后对比滑块" aria-valuenow={Math.round(slider)} aria-valuemin={0} aria-valuemax={100} tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'ArrowLeft') setSlider((s) => Math.max(0, s - 5)); if (e.key === 'ArrowRight') setSlider((s) => Math.min(100, s + 5)) }}
              onPointerDown={(e) => {
                const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
                const move = (ev: PointerEvent) => setSlider(Math.max(0, Math.min(100, ((ev.clientX - box.left) / box.width) * 100)))
                const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
                window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
              }}>
              <span className="vz-slider-grip"><Icon name="slider" size={14} /></span>
            </div>
            <div className="vz-slider-flip">
              <button className={slider >= 99 ? 'on' : ''} onClick={() => setSlider(100)} title="只看改动前">改动前</button>
              <button className={slider > 1 && slider < 99 ? 'on' : ''} onClick={() => setSlider(50)} title="左右各一半">对半</button>
              <button className={slider <= 1 ? 'on' : ''} onClick={() => setSlider(0)} title="只看改动后">改动后</button>
            </div>
          </div>
        )}
      </div>
      <div className="vz-zoom">
        <button onClick={() => zoomBy(1.25)} title="放大（+）" aria-label="放大"><Icon name="zoom-in" size={14} /></button>
        <button onClick={() => zoomBy(0.8)} title="缩小（-）" aria-label="缩小"><Icon name="zoom-out" size={14} /></button>
        <button onClick={fit} className={framed === 'all' ? 'on' : ''} title="适应窗口：看整张图（F）" aria-label="适应窗口" data-testid="viz-fit"><Icon name="fit" size={14} /></button>
        <button onClick={() => setMiniPref(!showMini)} className={showMini ? 'on' : ''} title={showMini ? '隐藏小地图' : '显示小地图'} aria-label="小地图" aria-pressed={showMini} data-testid="viz-minimap"><Icon name="minimap" size={14} /></button>
        <span className="vz-zoom-pct" title="缩放比例。缩得很小时只显示方块和分组名，放大后显示细节">{Math.round(vp.zoom * 100)}%</span>
      </div>
      {layout && !empty && (
        <div className="vz-gbar" data-testid="viz-gbar">
          <span className="vz-gsum" title={`这张图里：${sum.text}`} data-testid="viz-view-summary">{sum.text}</span>
          {!p.present && order.length > 0 && <div className="vz-nav" role="group" aria-label="逐个查看改动">
            <button onClick={() => goChange(-1)} title="上一处改动（[ 或 Shift+N）" aria-label="上一处改动" data-testid="viz-prev"><Icon name="chevron-left" size={13} /></button>
            <button className="vz-nav-txt" onClick={frameChanges} title="把镜头对准改动（C）。按 N / [ ] 逐个跳转，Enter 打开详情" data-testid="viz-changes">
              <Icon name="crosshair" size={12} />{navIdx >= 0 ? `改动 ${navIdx + 1}/${order.length}` : `看改动 · ${order.length} 处`}
            </button>
            <button onClick={() => goChange(1)} title="下一处改动（N 或 ]）" aria-label="下一处改动" data-testid="viz-next"><Icon name="chevron" size={13} /></button>
          </div>}
          {expanded.size > 0 && <button className="vz-gbtn" onClick={collapseAll} title="把点开的分组重新折叠起来" data-testid="viz-collapse"><Icon name="collapse-all" size={12} />收起 {expanded.size} 组</button>}
        </div>
      )}
      {(pathA || path) && (
        <div className="vz-pathchip" data-testid="viz-path">
          <Icon name="route" size={12} />
          {pathA ? <span>起点 <b>{nameOf(pathA)}</b> · 按住 Shift 再点一个终点</span>
            : path === 'none' ? <span>这两个节点之间没有连线路径</span>
            : onPath ? <span><b>{nameOf(onPath.a)}</b> {onPath.directed ? '→' : '—'} <b>{nameOf(onPath.b)}</b> · {onPath.steps} 步{onPath.directed ? '' : '（忽略方向）'}</span> : null}
          <button onClick={() => { setPath(null); setPathA(null) }} title="清除路径（Esc）" aria-label="清除路径"><Icon name="x" size={11} /></button>
        </div>
      )}
      {tip && <EdgeTip {...tip} />}
      {(busy || !layout) && <div className="vz-busy"><Spinner size={16} /> 正在布局…</div>}
      {empty && !busy && <div className="vz-empty-over">{p.emptyHint ?? '没有可显示的节点'}</div>}
    </div>
  )
})

const KIND_TXT: Record<string, string> = { import: '导入（依赖）', call: '调用', extends: '继承（泛化）', implements: '实现', uses: '使用（依赖）', flow: '控制流', transition: '状态迁移', depends: '依赖', event: '事件', contains: '包含' }
const ST_TXT: Record<string, string> = { added: '新增', removed: '删除', modified: '修改', moved: '移动', unchanged: '未变' }
function EdgeTip({ x, y, e }: { x: number; y: number; e: GEdge }) {
  const note = EDGE_NOTE[e.kind]
  return (
    <div className="vz-tip" style={{ left: x, top: y }} role="tooltip">
      <div><b className={`st-${e.status}`}>{ST_TXT[e.status]}</b> · {KIND_TXT[e.kind] ?? e.kind}{e.label ? ` · ${e.label}` : ''}</div>
      {note && <div className="vz-tip-note">{note}</div>}
      <div className="mono">{e.source.replace(/^[a-z]+:/, '')} → {e.target.replace(/^[a-z]+:/, '')}</div>
      {e.site && <div className="mono site">{e.kind === 'import' ? '导入位置' : e.kind === 'call' ? '调用位置' : '位置'}：{e.site.file}:{e.site.line}（{e.site.side === 'before' ? '改动前' : '改动后'}）</div>}
    </div>
  )
}

export const diagramKind = (k: LayoutKind): DiagramKind => (k === 'state' ? 'state' : k === 'classes' ? 'class' : 'flowchart')
