// Side panel for a clicked node / message: what it is, where it lives on both sides, the code diff snippet,
// its changed relations, and 打开差异 (full-file Monaco diff).
import React, { useEffect, useState } from 'react'
import { SafeDiffEditor as DiffEditor } from '../SafeDiffEditor'
import type { GNode, GEdge, SeqItem, Loc } from '@shared/viz'
import { viz, errMsg } from '../../api'
import { useApp } from '../../state'
import { Icon } from '../Icon'
import { Spinner } from '../ui'
import { STATUS_LABEL, STATUS_SIGN } from '../../lib/vizGraph'

type Msg = Extract<SeqItem, { t: 'msg' }>
export type VizSel = { type: 'node'; n: GNode; edges: GEdge[] } | { type: 'msg'; m: Msg; path: string }
type Line = { t: ' ' | '+' | '-' | '@'; text: string; b?: number; a?: number }

const KIND: Record<string, string> = { file: '文件', folder: '文件夹', function: '函数', method: '方法', class: '类', interface: '接口', type: '类型', enum: '枚举', struct: '结构体', trait: 'Trait', object: '对象', record: 'Record', route: '路由', event: '事件', external: '外部依赖', component: '组件', layer: '层', cluster: '折叠的分组', step: '语句', decision: '判断', loop: '循环', try: '异常处理', return: '返回', throw: '抛出', io: '输入输出', state: '状态', start: '开始', end: '结束', initial: '初始状态' }
const REL: Record<string, string> = { import: '导入', call: '调用', extends: '继承', implements: '实现', uses: '使用', flow: '流向', transition: '迁移', depends: '依赖', event: '事件', contains: '包含' }

function parsePatch(p: string): Line[] {
  const out: Line[] = []
  let b = 0; let a = 0
  for (const l of p.split('\n')) {
    if (l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('--- ') || l.startsWith('+++ ') || l.startsWith('similarity') || l.startsWith('rename ') || l.startsWith('new file') || l.startsWith('deleted file')) continue
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l)
    if (m) { b = Number(m[1]); a = Number(m[2]); out.push({ t: '@', text: l }); continue }
    if (l.startsWith('+')) out.push({ t: '+', text: l.slice(1), a: a++ })
    else if (l.startsWith('-')) out.push({ t: '-', text: l.slice(1), b: b++ })
    else if (l.startsWith(' ')) out.push({ t: ' ', text: l.slice(1), b: b++, a: a++ })
  }
  return out
}
const langOf = (f: string) => ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', java: 'java', go: 'go', rs: 'rust', cs: 'csharp', kt: 'kotlin', kts: 'kotlin', json: 'json', css: 'css', md: 'markdown', c: 'c', h: 'c', cpp: 'cpp', rb: 'ruby', php: 'php', swift: 'swift' } as Record<string, string>)[f.split('.').pop() ?? ''] ?? 'plaintext'

export function NodePanel({ sel, resultId, onClose, onPick, onFocus }: { sel: VizSel; resultId: string; onClose: () => void; onPick?: (id: string) => void; onFocus?: (id: string) => void }) {
  const [lines, setLines] = useState<Line[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ b?: string; a?: string } | null>(null)
  const n = sel.type === 'node' ? sel.n : null
  const before: Loc | undefined = n ? n.before : sel.type === 'msg' && sel.m.site?.side === 'before' ? sel.m.site : undefined
  const after: Loc | undefined = n ? n.after : sel.type === 'msg' && sel.m.site?.side === 'after' ? sel.m.site : undefined
  const isFile = !!n && (n.kind === 'file' || (n.id.startsWith('p:') && !n.before?.endLine && !n.after?.endLine))
  useEffect(() => {
    let alive = true
    setLines(null); setErr(null)
    if (!before && !after) { setLines([]); return }
    const short = !!n && ['step', 'decision', 'loop', 'try', 'return', 'throw', 'io', 'state'].includes(n.kind)
    const rng = (l?: Loc) => (l ? { file: l.file, line: l.line, endLine: l.endLine ?? l.line + (short || sel.type === 'msg' ? 4 : 30) } : undefined)
    const p = isFile
      ? viz.patch(resultId, (after ?? before)!.file, before && after && before.file !== after.file ? before.file : undefined).then((t) => parsePatch(t).slice(0, 600))
      : viz.snippet(resultId, { before: rng(before), after: rng(after) }).then((r) => r.lines as Line[])
    p.then((l) => alive && setLines(l)).catch((e) => alive && setErr(errMsg(e)))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultId, sel])
  const status = n ? n.status : sel.type === 'msg' ? sel.m.status : 'unchanged'
  const title = n ? n.label : sel.type === 'msg' ? sel.m.label : ''
  const changedEdges = (sel.type === 'node' ? sel.edges : []).filter((e) => e.status !== 'unchanged')
  const loc = (l?: Loc) => (l ? `${l.file}:${l.line}${l.endLine && l.endLine !== l.line ? `–${l.endLine}` : ''}` : '—')
  return (
    <aside className="vz-panel" data-testid="viz-panel" aria-label="节点详情">
      <div className="vp-head">
        <span className={`vp-status st-${status}`}>{STATUS_SIGN[status] || '='} {STATUS_LABEL[status]}</span>
        <span className="vp-kind">{n ? KIND[n.kind] ?? n.kind : '消息'}</span>
        <div className="flex1" />
        <button className="icon-btn" onClick={onClose} title="关闭（Esc）" aria-label="关闭详情"><Icon name="x" size={15} /></button>
      </div>
      <div className="vp-title" title={title}>{title.split('\n')[0]}</div>
      {n?.sub && <div className="vp-sub">{n.sub}</div>}
      <div className="vp-locs">
        <div><span className="vp-k">改动前</span><span className="mono">{loc(before)}</span></div>
        <div><span className="vp-k">改动后</span><span className="mono">{loc(after)}</span></div>
      </div>
      {n?.note && n.kind !== 'cluster' && status === 'modified' && <div className="vp-note"><span className="vp-k">原内容</span><code>{n.note}</code></div>}
      {n?.kind === 'cluster' && n.note && <div className="vp-note"><span className="vp-k">包含</span><pre>{n.note}</pre></div>}
      {!!n?.members?.length && (
        <div className="vp-sec"><div className="vp-sec-h">成员 <em>{n.members.filter((m) => m.status !== 'unchanged').length} 处改动</em></div>
          <div className="vp-members">{n.members.map((m, i) => <div key={i} className={`m-${m.status}`}><span className="vc-sign">{STATUS_SIGN[m.status] || '·'}</span>{m.name}{m.kind === 'method' ? '()' : ''}</div>)}</div>
        </div>
      )}
      {changedEdges.length > 0 && (
        <div className="vp-sec"><div className="vp-sec-h">变化的关系 <em>{changedEdges.length}</em></div>
          <div className="vp-rels">{changedEdges.slice(0, 14).map((e) => {
            const other = e.source === n!.id ? e.target : e.source
            return <button key={e.id} className={`vp-rel st-${e.status}`} onClick={() => onPick?.(other)} title={e.site ? `${e.site.file}:${e.site.line}` : ''}>
              <span className="vc-sign">{STATUS_SIGN[e.status]}</span>{e.source === n!.id ? '→' : '←'} {REL[e.kind] ?? e.kind} <b>{other.replace(/^[a-zA-Z]+:/, '').split(/[#/]/).pop()}</b>{e.label ? <em> {e.label}</em> : null}
            </button>
          })}</div>
        </div>
      )}
      <div className="vp-sec vp-code-sec">
        <div className="vp-sec-h">代码差异 {lines && lines.some((l) => l.t === '+' || l.t === '-') ? <em>+{lines.filter((l) => l.t === '+').length} −{lines.filter((l) => l.t === '-').length}</em> : lines?.length ? <em>未改动</em> : null}</div>
        {err ? <div className="vp-err">{err}</div> : !lines ? <div className="vp-loading"><Spinner size={12} /> 读取代码…</div> : !lines.length ? <div className="vp-empty">这个节点没有对应的源码位置</div> : (
          <div className="vp-code" data-testid="viz-snippet">{lines.map((l, i) => (
            <div key={i} className={`cl t${l.t === '+' ? 'a' : l.t === '-' ? 'd' : l.t === '@' ? 'h' : 'c'}`}>
              <span className="ln">{l.t === '@' ? '' : l.b ?? ''}</span><span className="ln">{l.t === '@' ? '' : l.a ?? ''}</span><span className="sg">{l.t === '@' ? '' : l.t}</span><span className="tx">{l.text || ' '}</span>
            </div>
          ))}</div>
        )}
      </div>
      <div className="vp-actions">
        <button className="btn btn-sm btn-primary" disabled={!before && !after} onClick={() => setDiff({ b: before?.file, a: after?.file })} data-testid="viz-open-diff"><Icon name="diff" size={13} />打开差异</button>
        {n && !n.group && onFocus && <button className="btn btn-sm" onClick={() => onFocus(n.id)} title="只显示这个节点及其直接相连的节点"><Icon name="focus" size={13} />聚焦邻居</button>}
        {(after ?? before) && <button className="btn btn-sm btn-ghost" onClick={() => void navigator.clipboard.writeText(loc(after ?? before))} title="复制 文件:行号"><Icon name="copy" size={13} />复制位置</button>}
      </div>
      {diff && <VizDiffModal resultId={resultId} before={diff.b} after={diff.a} line={after?.line ?? before?.line} onClose={() => setDiff(null)} />}
    </aside>
  )
}

export function VizDiffModal({ resultId, before, after, line, onClose }: { resultId: string; before?: string; after?: string; line?: number; onClose: () => void }) {
  const { theme, settings } = useApp()
  const [data, setData] = useState<{ original: string; modified: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { viz.contents(resultId, before, after).then(setData).catch((e) => setErr(errMsg(e))) }, [resultId, before, after])
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }; window.addEventListener('keydown', h, true); return () => window.removeEventListener('keydown', h, true) }, [onClose])
  const file = after ?? before ?? ''
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal vz-diff-modal" role="dialog" aria-label="代码差异" data-testid="viz-diff-modal">
        <div className="vz-diff-head"><Icon name="diff" size={14} /><span className="mono">{before && after && before !== after ? `${before} → ${after}` : file}</span><div className="flex1" /><button className="icon-btn" onClick={onClose} aria-label="关闭"><Icon name="x" size={15} /></button></div>
        <div className="vz-diff-body">
          {err ? <div className="vp-err">{err}</div> : !data ? <div className="vp-loading"><Spinner size={14} /> 加载…</div> : (
            <DiffEditor original={data.original} modified={data.modified} language={langOf(file)} theme={theme === 'dark' ? 'gitloom-dark' : 'gitloom-light'}
              onMount={(ed) => { if (line) setTimeout(() => ed.getModifiedEditor().revealLineInCenter(line), 200) }}
              options={{ readOnly: true, renderSideBySide: true, automaticLayout: true, minimap: { enabled: false }, fontSize: settings?.fontSize ?? 13, scrollBeyondLastLine: false, originalEditable: false, hideUnchangedRegions: { enabled: true, contextLineCount: 4, minimumLineCount: 6, revealLineCount: 20 }, renderSideBySideInlineBreakpoint: 560, useInlineViewWhenSpaceIsLimited: true }} />
          )}
        </div>
      </div>
    </div>
  )
}
