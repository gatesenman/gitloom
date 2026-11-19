// React Flow node + edge types for 变更可视化. Colour = diff status (legend), shape = kind.
import React, { memo } from 'react'
import { Handle, Position, BaseEdge, EdgeLabelRenderer, getSmoothStepPath, getBezierPath, type NodeProps, type EdgeProps, type Node, type Edge } from '@xyflow/react'
import type { GNode, GEdge, DiffStatus } from '@shared/viz'
import { Icon } from '../Icon'
import { STATUS_SIGN, STATUS_LABEL } from '../../lib/vizGraph'
import { MAX_MEMBERS, type Route } from '../../lib/vizLayout'
import { roundedPath } from '../../lib/vizSvg'
import { visMark, memberDisplay, stereoOf } from '../../lib/vizSe'

export type Pane = 'before' | 'after' | 'both'
export interface VData extends Record<string, unknown> { n: GNode; pane: Pane; dir: 'RIGHT' | 'DOWN'; hl?: boolean; sel?: boolean; heat?: number; dim?: boolean; nav?: boolean; path?: boolean; gone?: boolean; stale?: boolean }
export interface EData extends Record<string, unknown> { e: GEdge; pane: Pane; curve: 'step' | 'bezier'; hl?: boolean; dim?: boolean; route?: Route; path?: boolean; gone?: boolean }
export type VNode = Node<VData>
export type VEdge = Edge<EData>

const KIND_ICON: Record<string, string> = {
  file: 'file-code', folder: 'folder', function: 'fn', method: 'fn', class: 'box', interface: 'braces', type: 'braces', enum: 'list',
  struct: 'box', trait: 'braces', object: 'box', record: 'box', route: 'route', event: 'event', external: 'globe', component: 'component',
  layer: 'layers', cluster: 'blocks', loop: 'repeat', return: 'ret', throw: 'zap', try: 'try', io: 'file', step: 'dot', state: 'state', final: 'state'
}
const KIND_LABEL: Record<string, string> = { interface: '接口', type: '类型', enum: '枚举', struct: '结构体', trait: 'trait', object: '对象', record: 'record', class: '类' }

/** what a pane shows for a status: added items do not exist before, removed ones not after */
export const shownIn = (s: DiffStatus, pane: Pane) => pane === 'both' || (pane === 'before' ? s !== 'added' : s !== 'removed')
const cls = (d: VData, extra = '') => `vn st-${d.n.status} pane-${d.pane}${d.hl ? ' hl' : ''}${d.sel ? ' sel' : ''}${d.dim ? ' dim' : ''}${d.heat !== undefined ? ` heat heat-${d.heat}` : ''}${d.nav ? ' nav' : ''}${d.path ? ' onpath' : ''}${d.gone ? ' gone' : ''}${d.stale ? ' stale' : ''} ${extra}`

const Handles = ({ dir }: { dir: 'RIGHT' | 'DOWN' }) => (<>
  <Handle type="target" position={dir === 'DOWN' ? Position.Top : Position.Left} className="vh" isConnectable={false} />
  <Handle type="source" position={dir === 'DOWN' ? Position.Bottom : Position.Right} className="vh" isConnectable={false} />
</>)
const Badge = ({ s }: { s: DiffStatus }) => (s === 'unchanged' ? null : <span className={`vn-badge b-${s}`} title={STATUS_LABEL[s]}>{STATUS_SIGN[s]}</span>)
const StaleBadge = () => <span className="vn-badge b-stale" title="引用的文件或符号在 HEAD 已不存在" data-testid="node-stale">过时</span>

export const BoxNode = memo(function BoxNode({ data }: NodeProps<VNode>) {
  const n = data.n
  const stereo = stereoOf(n.kind)
  const tip = [stereo ? `«${stereo}»` : '', n.label, n.note].filter(Boolean).join('\n')
  return (
    <div className={cls(data, `k-${n.kind}`)} data-id={n.id} title={tip}>
      <Handles dir={data.dir} />
      <div className="vn-head"><Icon name={KIND_ICON[n.kind] ?? 'dot'} size={13} /><span className="vn-label">{n.label}</span>{n.hub && <span className="vn-hub" title={`热点文件：被 ${n.weight ?? '很多'} 个文件引用，改动影响面大`}><Icon name="flame" size={11} /></span>}<Badge s={n.status} />{data.stale && <StaleBadge />}</div>
      {stereo && <div className="vn-stereo" title={`角色：${stereo}`}>«{stereo}»</div>}
      {n.sub && <div className="vn-sub">{n.sub}</div>}
    </div>
  )
})

export const ClusterNode = memo(function ClusterNode({ data }: NodeProps<VNode>) {
  const n = data.n
  return (
    <div className={cls(data, 'k-cluster')} data-id={n.id} title={`${n.label}（已折叠 ${n.count ?? ''} 项，单击展开）${n.note ? '\n' + n.note : ''}`}>
      <Handles dir={data.dir} />
      <div className="vn-head"><Icon name="blocks" size={13} /><span className="vn-label">{n.label}</span><span className="vn-count">{n.count}</span></div>
      <div className="vn-sub">{/点击展开/.test(n.sub ?? '') ? n.sub : `${n.sub ?? ''} · 点击展开`}</div>
    </div>
  )
})

export const StepNode = memo(function StepNode({ data }: NodeProps<VNode>) {
  const n = data.n
  const lines = n.label.split('\n').slice(0, 4)
  return (
    <div className={cls(data, `k-${n.kind}`)} data-id={n.id} title={n.note ? `原：${n.note}` : n.label}>
      <Handles dir={data.dir} />
      {n.kind !== 'step' && <Icon name={KIND_ICON[n.kind] ?? 'dot'} size={12} className="vn-kind" />}
      <div className="vn-code">{lines.map((l, i) => <div key={i}>{l}</div>)}</div>
      <Badge s={n.status} />
    </div>
  )
})

export const TerminalNode = memo(function TerminalNode({ data }: NodeProps<VNode>) {
  const n = data.n
  const stereo = stereoOf(n.kind)
  return <div className={cls(data, `k-${n.kind}`)} data-id={n.id} title={stereo ? `«${stereo}» ${n.label}` : n.label}><Handles dir={data.dir} /><span className="vn-label">{n.label}</span></div>
})

export const DecisionNode = memo(function DecisionNode({ data, width, height }: NodeProps<VNode>) {
  const w = width ?? 140; const h = height ?? 62
  return (
    <div className={cls(data, 'k-decision')} data-id={data.n.id} title={data.n.note ? `原：${data.n.note}` : data.n.label}>
      <Handles dir={data.dir} />
      <svg className="vn-diamond" width={w} height={h} viewBox={`0 0 ${w} ${h}`}><polygon points={`${w / 2},1 ${w - 1},${h / 2} ${w / 2},${h - 1} 1,${h / 2}`} /></svg>
      <span className="vn-label">{data.n.label}</span><Badge s={data.n.status} />
    </div>
  )
})

export const StateNode = memo(function StateNode({ data }: NodeProps<VNode>) {
  const n = data.n
  if (n.kind === 'initial') return <div className={cls(data, 'k-initial')} data-id={n.id} title="UML 初态（实心圆）"><Handles dir={data.dir} /></div>
  if (n.kind === 'final') return (
    <div className={cls(data, 'k-final')} data-id={n.id} title={`UML 终态（牛眼）\n${n.label}${n.note ? '\n' + n.note : ''}`}>
      <Handles dir={data.dir} />
      <span className="vn-final-ring" aria-hidden /><span className="vn-final-core" aria-hidden />
      {n.label ? <span className="vn-label">{n.label}</span> : null}
      <Badge s={n.status} />
    </div>
  )
  return <div className={cls(data, 'k-state')} data-id={n.id} title={`UML 状态\n${n.label}`}><Handles dir={data.dir} /><span className="vn-label">{n.label}</span><Badge s={n.status} /></div>
})

export const ClassNode = memo(function ClassNode({ data }: NodeProps<VNode>) {
  const n = data.n
  const ms = n.members ?? []
  const attrs = ms.filter((m) => m.kind === 'field' || m.kind === 'value')
  const methods = ms.filter((m) => m.kind === 'method')
  // Keep total shown ≤ MAX_MEMBERS, attributes first then methods (UML compartments)
  const attrShow = attrs.slice(0, MAX_MEMBERS)
  const methodShow = methods.slice(0, Math.max(0, MAX_MEMBERS - attrShow.length))
  const hidden = ms.length - attrShow.length - methodShow.length
  const stereo = (KIND_LABEL[n.kind] && n.kind !== 'class') ? KIND_LABEL[n.kind] : stereoOf(n.kind, true)
  const row = (m: (typeof ms)[0], i: number) => {
    const v = visMark(m)
    const tip = [m.sig ?? m.name, STATUS_SIGN[m.status] ? STATUS_LABEL[m.status] : '', v ? `可见性 ${v}` : ''].filter(Boolean).join(' · ')
    return (
      <div key={i} className={`vc-m m-${m.status} mk-${m.kind}`} title={tip}>
        <span className="vc-vis" aria-hidden>{v || ' '}</span>
        <span className="vc-sign">{STATUS_SIGN[m.status] || ''}</span>
        <span className="vc-mname">{memberDisplay(m)}</span>
      </div>
    )
  }
  return (
    <div className={cls(data, `k-class k-${n.kind}`)} data-id={n.id} title={stereo ? `«${stereo}» ${n.label}` : n.label}>
      <Handles dir={data.dir} />
      <div className="vc-head">
        {stereo && <div className="vc-stereo">«{stereo}»</div>}
        <div className="vc-name"><span className="vn-label">{n.label}</span><Badge s={n.status} /></div>
        {n.sub && <div className="vn-sub">{n.sub}</div>}
      </div>
      {(attrShow.length > 0 || methodShow.length > 0) && (
        <>
          <div className="vc-compartment vc-attrs" title="UML 属性隔间">
            {attrShow.length === 0 ? <div className="vc-m vc-empty">—</div> : attrShow.map(row)}
          </div>
          <div className="vc-compartment vc-ops" title="UML 操作隔间">
            {methodShow.length === 0 ? <div className="vc-m vc-empty">—</div> : methodShow.map(row)}
          </div>
        </>
      )}
      {hidden > 0 && <div className="vc-m vc-more">… 还有 {hidden} 个成员</div>}
    </div>
  )
})

export const GroupNode = memo(function GroupNode({ data }: NodeProps<VNode>) {
  const n = data.n
  const stereo = stereoOf(n.kind)
  const tip = n.kind === 'layer' ? 'C4 容器 / 层边界' : n.kind === 'component' ? 'C4 组件' : stereo ? `«${stereo}»` : n.label
  return (
    <div className={`vg k-${n.kind} st-${n.status} pane-${data.pane}${data.dim ? ' dim' : ''}${data.gone ? ' gone' : ''}${data.stale ? ' stale' : ''}`} data-id={n.id} title={tip}>
      <div className="vg-label">
        <Icon name={KIND_ICON[n.kind] ?? 'folder'} size={12} />
        {stereo && <span className="vg-stereo">«{stereo}»</span>}
        <span>{n.label}</span>
        {n.status !== 'unchanged' && <Badge s={n.status} />}
        {data.stale && <StaleBadge />}
      </div>
    </div>
  )
})

export const NODE_TYPES = { box: BoxNode, cluster: ClusterNode, step: StepNode, terminal: TerminalNode, decision: DecisionNode, state: StateNode, klass: ClassNode, group: GroupNode }

export function nodeTypeOf(n: GNode): keyof typeof NODE_TYPES {
  if (n.group) return 'group'
  switch (n.kind) {
    case 'cluster': return 'cluster'
    case 'start': case 'end': return 'terminal'
    case 'decision': return 'decision'
    case 'state': case 'initial': case 'final': return 'state'
    case 'step': case 'return': case 'throw': case 'loop': case 'try': case 'io': return 'step'
    case 'class': case 'interface': case 'type': case 'enum': case 'struct': case 'trait': case 'object': case 'record': return 'klass'
    case 'file': return n.members?.length ? 'klass' : 'box'
    default: return 'box'
  }
}

/** midpoint of a polyline (by length): label anchor for routed edges without an ELK label position */
const polyMid = (pts: { x: number; y: number }[]) => {
  const seg = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i].x, q.y - pts[i].y))
  let half = seg.reduce((a, b) => a + b, 0) / 2
  for (let i = 0; i < seg.length; i++) {
    if (half <= seg[i] || i === seg.length - 1) { const t = seg[i] ? Math.min(1, half / seg[i]) : 0; return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t } }
    half -= seg[i]
  }
  return pts[0]
}

export const DiffEdge = memo(function DiffEdge(p: EdgeProps<VEdge>) {
  const d = p.data!
  let path: string; let lx: number; let ly: number
  if (d.route && d.route.pts.length >= 2) {
    // 0.5.2: ELK orthogonal / bundled route (absolute flow coordinates) — fewer crossings, no edges through boxes
    path = roundedPath(d.route.pts, 7)
    const m = d.route.label ?? polyMid(d.route.pts); lx = m.x; ly = m.y
  } else {
    ;[path, lx, ly] = d.curve === 'bezier'
      ? getBezierPath({ sourceX: p.sourceX, sourceY: p.sourceY, targetX: p.targetX, targetY: p.targetY, sourcePosition: p.sourcePosition, targetPosition: p.targetPosition })
      : getSmoothStepPath({ sourceX: p.sourceX, sourceY: p.sourceY, targetX: p.targetX, targetY: p.targetY, sourcePosition: p.sourcePosition, targetPosition: p.targetPosition, borderRadius: 10, offset: d.e.weight === -1 ? 28 : 16 })
  }
  const e = d.e
  return (<>
    <BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} className={`ve st-${e.status} ek-${e.kind}${d.hl ? ' hl' : ''}${d.dim ? ' dim' : ''}${d.path ? ' onpath' : ''}${d.gone ? ' gone' : ''}${e.weight === -1 ? ' back' : ''}`} interactionWidth={14} />
    {e.label && (
      <EdgeLabelRenderer>
        <div className={`ve-label st-${e.status}${d.dim ? ' dim' : ''}${d.gone ? ' gone' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>{e.label}</div>
      </EdgeLabelRenderer>
    )}
  </>)
})
export const EDGE_TYPES = { diff: DiffEdge }
