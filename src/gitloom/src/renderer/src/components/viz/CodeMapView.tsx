// 代码地图 (0.5.1): codemap-style project map of the compared range — a folder tree table or a squarified treemap,
// each file with before → after size / lines, +/− lines, importers before → after, blast radius and a hub flag.
// Unchanged files that depend on a changed one are marked "可能受影响" (CodeSee review-map style).
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { toPng } from 'html-to-image'
import type { CodeMap, MapFile, VizResult } from '@shared/viz'
import { Icon } from '../Icon'
import { buildTree, colorClass, fileTip, filterFiles, fmtBytes, fmtDelta, importersOf, treemapCells, STATUS_WORD, type ColorBy, type MapDir, type MapScope, type SizeSide } from '../../lib/codemap'

export type MapDisplay = 'tree' | 'treemap'
export interface CodeMapApi { png: () => Promise<string> }
export interface CodeMapProps {
  result: VizResult
  map: CodeMap
  display: MapDisplay
  scope: MapScope
  colorBy: ColorBy
  sizeSide: SizeSide
  q: string
  selected: string | null
  onSelect: (f: MapFile | null) => void
  onShowAll: () => void
}

const COV_LABEL = { complete: '完整', partial: '部分', none: '无' } as const

function Totals({ map, onPick, colorBy }: { map: CodeMap; onPick: (p: string) => void; colorBy: ColorBy }) {
  const t = map.totals
  const changedHubs = map.files.filter((f) => f.hub && f.status !== 'unchanged')
  return (<>
    <div className="cm-totals" data-testid="cm-totals">
      <span title="改动前 → 改动后的文件数（当前范围内）"><Icon name="file" size={12} />文件 <b>{t.filesB}</b> → <b>{t.filesA}</b></span>
      <span title="所有文件的总字节数"><Icon name="box" size={12} />大小 <b>{fmtBytes(t.bytesB)}</b> → <b>{fmtBytes(t.bytesA)}</b>{t.bytesA !== t.bytesB && <em className={t.bytesA > t.bytesB ? 'up' : 'dn'}>{fmtDelta(t.bytesB, t.bytesA, fmtBytes)}</em>}</span>
      <span title="可解析源码文件的总行数"><Icon name="code" size={12} />源码行 <b>{t.linesB}</b> → <b>{t.linesA}</b></span>
      <span title="git diff 的增删行数"><b className="ad">+{t.add}</b> <b className="rm">−{t.del}</b></span>
      <span title="改动的文件 / 没改动但直接或间接依赖了改动文件的文件"><b>{t.changed}</b> 个改动 · <b>{t.affected}</b> 个可能受影响</span>
      <span className={`cm-cov cov-${map.coverage}`} title={map.coverageNote ?? '所有源文件都已解析，引用关系完整'} data-testid="cm-coverage"><Icon name={map.coverage === 'complete' ? 'ok' : 'info'} size={12} />依赖覆盖：{COV_LABEL[map.coverage]}</span>
      {map.truncated ? <span className="cm-trunc" title="文件太多，只显示改动、受影响和热点文件以及改动所在的目录">已省略 {map.truncated} 个文件</span> : null}
      <span className="flex1" />
      <MapLegend by={colorBy} hubMin={map.hubMin} />
    </div>
    {changedHubs.length > 0 && (
      <div className="cm-hubwarn" data-testid="cm-hubwarn">
        <Icon name="flame" size={13} />
        <span>改动了 {changedHubs.length} 个<b>热点文件</b>（被 ≥ {map.hubMin} 个文件引用），评审时重点看：</span>
        {changedHubs.slice(0, 4).map((f) => <button key={f.path} className="cm-hubchip" onClick={() => onPick(f.path)} title={`被 ${importersOf(f)} 个文件引用，影响面 ${f.blast ?? 0} 个文件`}>{f.path.split('/').pop()} <em>{importersOf(f)}←</em></button>)}
        {changedHubs.length > 4 && <span className="muted">等 {changedHubs.length} 个</span>}
      </div>
    )}
  </>)
}

const Num = ({ b, a, fmt = String }: { b?: number; a?: number; fmt?: (n: number) => string }) => {
  if (b === undefined && a === undefined) return <span className="faint">—</span>
  if (b === a) return <span>{fmt(a ?? 0)}</span>
  return <span>{b === undefined ? <span className="faint">—</span> : fmt(b)} <span className="faint">→</span> {a === undefined ? <span className="faint">—</span> : fmt(a)}</span>
}

function TreeTable({ root, map, colorBy, selected, onSelect, scope }: { root: MapDir; map: CodeMap; colorBy: ColorBy; selected: string | null; onSelect: (f: MapFile) => void; scope: MapScope }) {
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [opened, setOpened] = useState<Set<string>>(new Set())
  useEffect(() => { setClosed(new Set()); setOpened(new Set()) }, [scope])
  const isOpen = (d: MapDir) => (closed.has(d.path) ? false : opened.has(d.path) ? true : scope === 'changed' || d.agg.changed + d.agg.affected > 0)
  const toggle = (d: MapDir) => {
    const open = isOpen(d)
    setClosed((s) => { const n = new Set(s); if (open) n.add(d.path); else n.delete(d.path); return n })
    setOpened((s) => { const n = new Set(s); if (!open) n.add(d.path); else n.delete(d.path); return n })
  }
  const rows: React.ReactNode[] = []
  const walk = (d: MapDir, depth: number) => {
    for (const c of d.dirs) {
      const open = isOpen(c)
      rows.push(
        <div key={`d:${c.path}`} className={`cm-row cm-dir st-${c.status}`} style={{ paddingLeft: 6 + depth * 16 }} onClick={() => toggle(c)} role="treeitem" aria-expanded={open} data-testid="cm-dir" title={`${c.path}\n${c.agg.files} 个文件 · ${c.agg.changed} 个改动 · ${c.agg.affected} 个可能受影响`}>
          <span className="cm-name"><Icon name={open ? 'chevron-down' : 'chevron'} size={12} /><Icon name="folder" size={13} /><span className="cm-dirname">{c.name}/</span>
            <span className="cm-dirmeta">{c.agg.files} 个文件{c.agg.changed ? <> · <b className="md">{c.agg.changed} 改动</b></> : null}{c.agg.hubs ? <> · <Icon name="flame" size={10} />{c.agg.hubs}</> : null}</span></span>
          <span className="cm-c-st" />
          <span className="cm-c-size"><Num b={c.agg.bytesB} a={c.agg.bytesA} fmt={fmtBytes} /></span>
          <span className="cm-c-lines">{c.agg.add || c.agg.del ? <><b className="ad">+{c.agg.add}</b> <b className="rm">−{c.agg.del}</b></> : null}</span>
          <span className="cm-c-in" /><span className="cm-c-blast" />
        </div>
      )
      if (open) walk(c, depth + 1)
    }
    for (const f of d.files) {
      rows.push(
        <div key={f.path} className={`cm-row cm-file st-${f.status}${selected === f.path ? ' on' : ''}`} style={{ paddingLeft: 22 + depth * 16 }} onClick={() => onSelect(f)} title={fileTip(f, map.hubMin)} role="treeitem" data-testid="cm-file" data-path={f.path}>
          <span className="cm-name"><i className={`cm-dot ${colorClass(f, colorBy, map.hubMin)}`} /><span className="cm-fname">{f.path.split('/').pop()}</span>
            {f.oldPath && <span className="cm-old" title={`原路径 ${f.oldPath}`}>← {f.oldPath.split('/').pop()}</span>}
            {f.hub && <span className="cm-hub" title={`热点文件：被 ${importersOf(f)} 个文件引用`}><Icon name="flame" size={11} />热点</span>}
            {f.affected && <span className="cm-aff" title="没改动，但直接或间接依赖了改动的文件">受影响</span>}
            {f.status === 'unchanged' && !f.affected && (f.gained?.length || f.lost?.length) ? <span className="cm-aff" title="文件本身没改，但引用它的文件变了">引用方变化</span> : null}</span>
          <span className={`cm-c-st st-${f.status}`}>{f.status === 'unchanged' ? '' : STATUS_WORD[f.status]}</span>
          <span className="cm-c-size"><Num b={f.bytesB} a={f.bytesA} fmt={fmtBytes} /></span>
          <span className="cm-c-lines">{f.add || f.del ? <><b className="ad">+{f.add ?? 0}</b> <b className="rm">−{f.del ?? 0}</b></> : null}</span>
          <span className="cm-c-in">{f.inA !== undefined || f.inB !== undefined ? <Num b={f.inB} a={f.inA} /> : null}{f.gained?.length ? <em className="ad" title={`新增引用方：${f.gained.join('、')}`}> +{f.gained.length}</em> : null}{f.lost?.length ? <em className="rm" title={`失去引用方：${f.lost.join('、')}`}> −{f.lost.length}</em> : null}</span>
          <span className="cm-c-blast">{f.blast ? <span className={`cm-blast${f.blast >= map.hubMin * 2 ? ' big' : ''}`} title={`${f.blast} 个文件直接或间接依赖它`}>{f.blast}</span> : null}</span>
        </div>
      )
    }
  }
  walk(root, 0)
  return (
    <div className="cm-table" role="tree" aria-label="代码地图">
      <div className="cm-row cm-head">
        <span className="cm-name">文件</span><span className="cm-c-st">状态</span><span className="cm-c-size" title="改动前 → 改动后">大小</span>
        <span className="cm-c-lines" title="git diff 增删行">行 +/−</span><span className="cm-c-in" title="多少个文件 import 它（改动前 → 改动后）">被引用</span>
        <span className="cm-c-blast" title="影响面：直接或间接依赖它的文件数（谁可能被改坏）">影响面</span>
      </div>
      <div className="cm-rows">{rows}</div>
    </div>
  )
}

function Treemap({ root, map, colorBy, sizeSide, selected, onSelect }: { root: MapDir; map: CodeMap; colorBy: ColorBy; sizeSide: SizeSide; selected: string | null; onSelect: (f: MapFile) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = host.current; if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  const cells = useMemo(() => (size.w > 20 && size.h > 20 ? treemapCells(root, { x: 0, y: 0, w: size.w, h: size.h }, sizeSide) : []), [root, size, sizeSide])
  return (
    <div className="cm-treemap" ref={host} data-testid="cm-treemap">
      {cells.map((c) => c.dir ? (
        <div key={c.id} className={`cm-tdir st-${c.dir.status}`} style={{ left: c.x, top: c.y, width: c.w, height: c.h }} title={`${c.dir.path}/\n${c.dir.agg.files} 个文件 · ${c.dir.agg.changed} 个改动\n大小 ${fmtBytes(c.dir.agg.bytesB)} → ${fmtBytes(c.dir.agg.bytesA)}`}>
          {c.label && <span className="cm-tdir-l">{c.dir.name}{c.dir.agg.changed ? <em>{c.dir.agg.changed}</em> : null}</span>}
        </div>
      ) : (
        <button key={c.id} className={`cm-cell ${colorClass(c.file!, colorBy, map.hubMin)}${selected === c.file!.path ? ' on' : ''}${c.file!.hub ? ' hub' : ''}`} style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
          onClick={() => onSelect(c.file!)} title={fileTip(c.file!, map.hubMin)} data-testid="cm-cell" data-path={c.file!.path}>
          {c.label && <span className="cm-cell-l">{c.file!.hub && <Icon name="flame" size={10} />}{c.file!.path.split('/').pop()}</span>}
          {c.label && c.h > 34 && (c.file!.add || c.file!.del) ? <span className="cm-cell-s">+{c.file!.add ?? 0} −{c.file!.del ?? 0}</span> : null}
        </button>
      ))}
    </div>
  )
}

export const CodeMapView = forwardRef<CodeMapApi, CodeMapProps>(function CodeMapView(p, ref) {
  const body = useRef<HTMLDivElement>(null)
  const files = useMemo(() => filterFiles(p.map, p.scope, p.q), [p.map, p.scope, p.q])
  const root = useMemo(() => buildTree(files), [files])
  useImperativeHandle(ref, () => ({
    png: async () => {
      const el = body.current!
      const bg = getComputedStyle(el).backgroundColor || getComputedStyle(document.body).backgroundColor
      const url = await toPng(el, { backgroundColor: bg, pixelRatio: 2 })
      return url.slice(url.indexOf(',') + 1)
    }
  }), [])
  const pick = (path: string) => { const f = p.map.files.find((x) => x.path === path); if (f) p.onSelect(f) }
  return (
    <div className="cm" data-testid="viz-codemap">
      <Totals map={p.map} onPick={pick} colorBy={p.colorBy} />
      <div className="cm-body" ref={body}>
        {!files.length ? (
          <div className="vz-center"><div className="vz-none"><Icon name="codemap" size={28} /><b>{p.q ? '没有匹配的文件' : '没有改动的文件'}</b>
            <span>{p.q ? `没有路径包含「${p.q}」的文件` : '这个范围里没有文件改动。'}</span>{p.scope === 'changed' && <button className="btn btn-sm" onClick={p.onShowAll}>显示全部文件</button>}</div></div>
        ) : p.display === 'tree'
          ? <TreeTable root={root} map={p.map} colorBy={p.colorBy} selected={p.selected} onSelect={p.onSelect} scope={p.scope} />
          : <Treemap root={root} map={p.map} colorBy={p.colorBy} sizeSide={p.sizeSide} selected={p.selected} onSelect={p.onSelect} />}
      </div>
    </div>
  )
})

/** legend for the current colouring */
export function MapLegend({ by, hubMin }: { by: ColorBy; hubMin: number }) {
  const items: [string, string][] = by === 'status' ? [['cm-added', '新增'], ['cm-removed', '删除'], ['cm-modified', '修改'], ['cm-moved', '移动'], ['cm-affected', '可能受影响'], ['cm-un', '未变']]
    : by === 'heat' ? [['cm-hot3', `热点 ≥${hubMin}`], ['cm-hot2', '常用'], ['cm-hot1', '少量引用'], ['cm-hot0', '无人引用']]
    : [['cm-grnew', '新文件'], ['cm-grup2', '变大 >20%'], ['cm-grup1', '变大'], ['cm-gr0', '不变'], ['cm-grdn1', '变小'], ['cm-grdn2', '变小 >20%'], ['cm-grgone', '已删除']]
  return <div className="vz-legend cm-legend" aria-label="图例">{items.map(([c, l]) => <span key={c} className={`lg ${c}`}>{l}</span>)}</div>
}
