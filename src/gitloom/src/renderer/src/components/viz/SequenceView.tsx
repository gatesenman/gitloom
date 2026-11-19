// Custom SVG sequence diagram (UML-ish): participants, lifelines, messages, alt / loop / opt / try / par frames.
// The merged sequence is laid out once; each pane hides what does not exist on its side but keeps the row, so the
// before and after diagrams stay aligned row by row (the gap is marked "＋ 新增 / − 删除").
import React, { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SeqDiagram, SeqItem, DiffStatus } from '@shared/viz'
import { seqToMermaid, seqToPlantUML, visibleOn, STATUS_SIGN } from '../../lib/vizGraph'
import { textWidth } from '../../lib/vizLayout'
import { Icon } from '../Icon'
import type { ExportApi } from './GraphDiff'

type Msg = Extract<SeqItem, { t: 'msg' }>
type Frame = Extract<SeqItem, { t: 'frame' }>
export interface SeqLayout {
  width: number; height: number; colW: number; headH: number
  cols: Record<string, number>
  msgs: { m: Msg; y: number; x1: number; x2: number; self: boolean; status: DiffStatus; path: string }[]
  frames: { f: Frame; x1: number; x2: number; y1: number; y2: number; seps: { y: number; label: string }[]; status: DiffStatus }[]
  /** UML execution specifications (activation bars) on lifelines */
  activations: { id: string; x: number; y1: number; y2: number }[]
}

const ROW = 34; const SELF = 46; const FHEAD = 28; const FSEP = 24; const FPAD = 10
export function layoutSeq(d: SeqDiagram): SeqLayout {
  const maxLabel = Math.max(80, ...d.participants.map((p) => textWidth(p.label, 12.5)))
  const colW = Math.max(130, Math.min(200, maxLabel + 44))
  const cols: Record<string, number> = {}
  d.participants.forEach((p, i) => { cols[p.id] = 24 + colW * i + colW / 2 })
  const headH = 52
  const msgs: SeqLayout['msgs'] = []
  const frames: SeqLayout['frames'] = []
  const touched = (items: SeqItem[], acc: Set<string>) => { for (const it of items) { if (it.t === 'msg') { acc.add(it.from); acc.add(it.to) } else it.branches.forEach((b) => touched(b.items, acc)) } return acc }
  let y = headH + 16
  const walk = (items: SeqItem[], depth: number, path: string) => {
    items.forEach((it, i) => {
      const p = `${path}${i}`
      if (it.t === 'msg') {
        const self = it.from === it.to
        msgs.push({ m: it, y: y + 18, x1: cols[it.from] ?? 24, x2: cols[it.to] ?? 24, self, status: it.status, path: p })
        y += self ? SELF : ROW
      } else {
        const t = [...touched([it], new Set())].map((id) => cols[id]).filter((x) => x !== undefined)
        const lo = t.length ? Math.min(...t) : 24 + colW / 2
        const hi = t.length ? Math.max(...t) : 24 + colW * (d.participants.length - 0.5)
        const inset = depth * 8
        const fr = { f: it, x1: lo - colW / 2 + 10 + inset, x2: Math.max(hi + colW / 2 - 10 - inset, lo + colW - 20), y1: y, y2: 0, seps: [] as { y: number; label: string }[], status: it.status }
        frames.push(fr)
        y += FHEAD
        it.branches.forEach((b, j) => {
          if (j > 0) { fr.seps.push({ y: y + 4, label: b.label }); y += FSEP }
          walk(b.items, depth + 1, `${p}.${j}.`)
        })
        y += FPAD
        fr.y2 = y
        y += 6
      }
    })
  }
  walk(d.items, 0, '')
  // Activation bars: sync call opens target bar; return or next outbound from target closes it.
  const activations: SeqLayout['activations'] = []
  const open = new Map<string, number>()
  const close = (id: string, yEnd: number) => {
    const y0 = open.get(id)
    if (y0 === undefined) return
    if (yEnd - y0 >= 8) activations.push({ id, x: cols[id] ?? 24, y1: y0 - 4, y2: yEnd + 4 })
    open.delete(id)
  }
  for (const r of msgs) {
    const m = r.m
    if (m.ret) { close(m.from, r.y); continue }
    if (r.self || m.async) continue
    // close prior activation on target if re-entered
    if (open.has(m.to)) close(m.to, r.y - 6)
    open.set(m.to, r.y + 2)
    // callee may also briefly activate caller already open
  }
  for (const id of [...open.keys()]) close(id, y - 8)
  return { width: 48 + colW * d.participants.length, height: y + 24, colW, headH, cols, msgs, frames, activations }
}

const trunc = (s: string, px: number) => { if (textWidth(s, 12) <= px) return s; let out = ''; for (const ch of s) { if (textWidth(out + ch + '…', 12) > px) break; out += ch } return out + '…' }

function SeqSvg({ d, L, pane, scale, selected, onSelect }: { d: SeqDiagram; L: SeqLayout; pane: 'before' | 'after' | 'both'; scale: number; selected?: string | null; onSelect: (m: Msg | null, path?: string) => void }) {
  const ghosts: { y: number; h: number; kind: 'add' | 'rm'; first: boolean }[] = []
  let prevGhost = -1
  L.msgs.forEach((r, i) => {
    if (!visibleOn(r.status, pane)) { ghosts.push({ y: r.y - 14, h: r.self ? SELF : ROW, kind: r.status === 'added' ? 'add' : 'rm', first: prevGhost !== i - 1 }); prevGhost = i }
  })
  const fid = (s: DiffStatus) => `sq-ar-${s}`
  return (
    <svg className={`sq pane-${pane}`} width={L.width * scale} height={L.height * scale} viewBox={`0 0 ${L.width} ${L.height}`} xmlns="http://www.w3.org/2000/svg" onClick={(e) => { if (e.target === e.currentTarget) onSelect(null) }}>
      <defs>
        {(['added', 'removed', 'modified', 'moved', 'unchanged'] as DiffStatus[]).map((s) => (
          <React.Fragment key={s}>
            <marker id={`${fid(s)}-${pane}`} className={`sq-ar st-${s}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker>
            <marker id={`${fid(s)}-open-${pane}`} className={`sq-ar-open st-${s}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" fill="none" strokeWidth="1.5" /></marker>
          </React.Fragment>
        ))}
      </defs>
      <rect className="sq-bg" x={0} y={0} width={L.width} height={L.height} />
      {ghosts.map((g, i) => (
        <g key={`g${i}`} className={`sq-ghost ${g.kind}`}>
          <rect x={8} y={g.y} width={L.width - 16} height={g.h} rx={4} />
          {g.first && <text x={14} y={g.y + 13}>{g.kind === 'add' ? '＋ 此处在改动后新增' : '− 此处在改动后删除'}</text>}
        </g>
      ))}
      {d.participants.map((p) => {
        const x = L.cols[p.id]
        const on = visibleOn(p.status, pane)
        return (
          <g key={p.id} className={`sq-part st-${p.status}${on ? '' : ' off'}`}>
            <line className="sq-life" x1={x} y1={L.headH} x2={x} y2={L.height - 10} />
            <rect x={x - L.colW / 2 + 8} y={12} width={L.colW - 16} height={L.headH - 18} rx={7} />
            {p.kind === 'actor' && <circle cx={x - L.colW / 2 + 22} cy={12 + (L.headH - 18) / 2} r={5} className="sq-actor" />}
            <text x={x} y={12 + (L.headH - 18) / 2 + 4.5} textAnchor="middle">{trunc((p.status !== 'unchanged' ? STATUS_SIGN[p.status] + ' ' : '') + p.label, L.colW - 40)}</text>
          </g>
        )
      })}
      {L.activations.map((a, i) => (
        <rect key={`act${i}`} className="sq-act" x={a.x - 5} y={a.y1} width={10} height={Math.max(6, a.y2 - a.y1)} rx={2} />
      ))}
      {L.frames.filter((f) => visibleOn(f.status, pane)).map((f, i) => (
        <g key={`f${i}`} className={`sq-frame st-${f.status}`}>
          <rect x={f.x1} y={f.y1} width={f.x2 - f.x1} height={f.y2 - f.y1} rx={4} />
          <path className="sq-ftab" d={`M${f.x1},${f.y1} h${Math.max(44, textWidth(f.f.kind, 11) + 18)} v12 l-8,8 h${-(Math.max(44, textWidth(f.f.kind, 11) + 18) - 8)} z`} />
          <text className="sq-fkind" x={f.x1 + 6} y={f.y1 + 14}>{f.f.kind}</text>
          <text className="sq-flabel" x={f.x1 + Math.max(44, textWidth(f.f.kind, 11) + 18) + 8} y={f.y1 + 14}>{trunc(`[${f.f.label}${f.f.branches[0]?.label ? ' ' + f.f.branches[0].label : ''}]`, f.x2 - f.x1 - 70)}</text>
          {f.seps.map((s, j) => (<g key={j}><line className="sq-fsep" x1={f.x1} y1={s.y} x2={f.x2} y2={s.y} /><text className="sq-flabel" x={f.x1 + 8} y={s.y + 14}>[{trunc(s.label || 'else', f.x2 - f.x1 - 20)}]</text></g>))}
        </g>
      ))}
      {L.msgs.filter((r) => visibleOn(r.status, pane)).map((r) => {
        const sel = selected === r.path
        const dir = r.x2 >= r.x1 ? 1 : -1
        const label = (r.status !== 'unchanged' ? STATUS_SIGN[r.status] + ' ' : '') + r.m.label
        const isCreate = !r.m.ret && /^(new |create |Create|新建|创建)/i.test(r.m.label)
        const openArrow = r.m.ret || r.m.async || isCreate
        const marker = openArrow ? `url(#${fid(r.status)}-open-${pane})` : `url(#${fid(r.status)}-${pane})`
        const kindCls = `${r.m.ret ? ' ret' : ''}${r.m.async ? ' async' : ''}${isCreate ? ' create' : ''}`
        return (
          <g key={r.path} className={`sq-msg st-${r.status}${kindCls}${sel ? ' sel' : ''}`} data-path={r.path} onClick={(e) => { e.stopPropagation(); onSelect(r.m, r.path) }}>
            {r.self ? (<>
              <path className="sq-line" d={`M${r.x1},${r.y - 6} h34 v18 h-30`} markerEnd={marker} />
              <text x={r.x1 + 40} y={r.y + 4}>{trunc(label, L.colW * 1.2)}</text>
              <rect className="sq-hit" x={r.x1} y={r.y - 16} width={L.colW} height={SELF - 8} />
            </>) : (<>
              <line className="sq-line" x1={r.x1 + dir * 2} y1={r.y} x2={r.x2 - dir * 3} y2={r.y} markerEnd={marker} />
              <text x={(r.x1 + r.x2) / 2} y={r.y - 6} textAnchor="middle">{trunc(label, Math.max(60, Math.abs(r.x2 - r.x1) - 12))}</text>
              <rect className="sq-hit" x={Math.min(r.x1, r.x2)} y={r.y - 20} width={Math.abs(r.x2 - r.x1)} height={28} />
            </>)}
          </g>
        )
      })}
    </svg>
  )
}

/** inline the computed styles so an exported SVG renders the same outside the app */
export function standaloneSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const src = svg.querySelectorAll('*'); const dst = clone.querySelectorAll('*')
  const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-family', 'font-weight', 'fill-opacity', 'stroke-opacity']
  src.forEach((el, i) => { const cs = getComputedStyle(el); (dst[i] as SVGElement).setAttribute('style', props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';')) })
  clone.setAttribute('width', String(svg.viewBox.baseVal.width)); clone.setAttribute('height', String(svg.viewBox.baseVal.height))
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)
}

export const SequenceView = forwardRef<ExportApi, { d: SeqDiagram; mode: 'side' | 'overlay' | 'slider'; beforeLabel: string; afterLabel: string; selected?: string | null; onSelect: (m: Msg | null, path?: string) => void }>(function SequenceView(p, ref) {
  const L = useMemo(() => layoutSeq(p.d), [p.d])
  const [scale, setScale] = useState(1)
  const [flip, setFlip] = useState<'before' | 'after'>('after')
  const a = useRef<HTMLDivElement>(null); const b = useRef<HTMLDivElement>(null)
  const lock = useRef(false)
  const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null) => { if (!from || !to || lock.current) return; lock.current = true; to.scrollTop = from.scrollTop; to.scrollLeft = from.scrollLeft; requestAnimationFrame(() => { lock.current = false }) }
  const host = useRef<HTMLDivElement>(null)
  const fit = (min = 0.4) => { const w = (a.current ?? b.current)?.clientWidth ?? 600; setScale(Math.max(min, Math.min(1, (w - 24) / L.width))) }
  // auto-fit when the diagram or mode changes (5+ participants used to start clipped at 100 % in a half-width pane);
  // never below 60 % so labels stay readable, the user can still zoom out further
  useLayoutEffect(() => { fit(0.6) }, [L, p.mode]) // eslint-disable-line react-hooks/exhaustive-deps
  useImperativeHandle(ref, () => ({
    fit: () => fit(),
    mermaid: () => seqToMermaid(p.d),
    plantuml: () => seqToPlantUML(p.d),
    svg: async () => { const svgs = host.current!.querySelectorAll('svg.sq'); return standaloneSvg(svgs[svgs.length - 1] as SVGSVGElement) },
    png: async () => {
      const svgs = host.current!.querySelectorAll('svg.sq')
      const s = svgs[svgs.length - 1] as SVGSVGElement
      const xml = standaloneSvg(s)
      const img = new Image()
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('SVG 渲染失败')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml) })
      const c = document.createElement('canvas'); c.width = L.width * 2; c.height = L.height * 2
      const ctx = c.getContext('2d')!; ctx.scale(2, 2); ctx.drawImage(img, 0, 0)
      const url = c.toDataURL('image/png'); return url.slice(url.indexOf(',') + 1)
    }
  }))
  const svg = (pane: 'before' | 'after' | 'both') => <SeqSvg d={p.d} L={L} pane={pane} scale={scale} selected={p.selected} onSelect={p.onSelect} />
  return (
    <div className={`vz-seq mode-${p.mode}`} ref={host}>
      <div className="vz-panes">
        {p.mode === 'side' && (<>
          <div className="vz-pane pane-before" data-testid="viz-pane-before"><div className="vz-pane-tag"><span className="dot rm" />改动前<em>{p.beforeLabel}</em></div><div className="vz-seq-scroll" ref={a} onScroll={() => sync(a.current, b.current)}>{svg('before')}</div></div>
          <div className="vz-pane pane-after" data-testid="viz-pane-after"><div className="vz-pane-tag"><span className="dot ad" />改动后<em>{p.afterLabel}</em></div><div className="vz-seq-scroll" ref={b} onScroll={() => sync(b.current, a.current)}>{svg('after')}</div></div>
        </>)}
        {p.mode === 'overlay' && <div className="vz-pane pane-both" data-testid="viz-pane-overlay"><div className="vz-pane-tag"><span className="dot md" />叠加对比<em>{p.beforeLabel} → {p.afterLabel}</em></div><div className="vz-seq-scroll" ref={b}>{svg('both')}</div></div>}
        {p.mode === 'slider' && <div className="vz-pane pane-slider" data-testid="viz-pane-slider">
          <div className="vz-pane-tag"><span className={`dot ${flip === 'before' ? 'rm' : 'ad'}`} />{flip === 'before' ? '改动前' : '改动后'}<em>{flip === 'before' ? p.beforeLabel : p.afterLabel}</em></div>
          <div className="vz-seq-scroll" ref={b}>{svg(flip)}</div>
          <div className="vz-slider-flip"><button className={flip === 'before' ? 'on' : ''} onClick={() => setFlip('before')}>改动前</button><button className={flip === 'after' ? 'on' : ''} onClick={() => setFlip('after')}>改动后</button></div>
        </div>}
      </div>
      <div className="vz-zoom">
        <button onClick={() => setScale((s) => Math.min(2, s * 1.2))} title="放大" aria-label="放大"><Icon name="zoom-in" size={14} /></button>
        <button onClick={() => setScale((s) => Math.max(0.3, s / 1.2))} title="缩小" aria-label="缩小"><Icon name="zoom-out" size={14} /></button>
        <button onClick={() => fit()} title="适应宽度" aria-label="适应窗口" data-testid="viz-fit"><Icon name="fit" size={14} /></button>
        <span className="vz-zoom-pct">{Math.round(scale * 100)}%</span>
      </div>
    </div>
  )
})
