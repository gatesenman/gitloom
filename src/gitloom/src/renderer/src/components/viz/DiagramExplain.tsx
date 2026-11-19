// 「AI 解读本图」 card: streams a short explanation of the current diagram; every 「节点名」 is a chip that jumps to the box.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { DiffGraph } from '@shared/viz'
import { app, errMsg } from '../../api'
import { explainPrompt, linkNames, nameIndex } from '../../lib/vizExplain'
import { Icon } from '../Icon'
import { Spinner } from '../ui'

const cache = new Map<string, string>()

export function DiagramExplain({ graph, view, scope, model, onFocus, onSettings, onClose }: {
  graph: DiffGraph; view: string; scope: string; model: string
  onFocus: (id: string) => void; onSettings: () => void; onClose: () => void
}) {
  const key = useMemo(() => `${model}|${view}|${scope}|${graph.nodes.length}|${graph.edges.length}|${graph.nodes.filter((n) => n.status !== 'unchanged').map((n) => n.id).join(',').slice(0, 2000)}`, [graph, view, scope, model])
  const [text, setText] = useState(cache.get(key) ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ctl = useRef<AbortController | null>(null)
  const run = () => {
    if (!model) return
    ctl.current?.abort(); const c = new AbortController(); ctl.current = c
    setBusy(true); setErr(null); setText('')
    app.aiChat(explainPrompt(graph, view, scope), undefined, (full) => { if (ctl.current === c) setText(full) }, c.signal)
      .then((t) => { if (ctl.current !== c) return; setText(t); cache.set(key, t) })
      .catch((e) => { if (ctl.current === c) setErr((e as Error).name === 'AbortError' ? '已停止' : errMsg(e)) })
      .finally(() => { if (ctl.current === c) setBusy(false) })
  }
  useEffect(() => { const c = cache.get(key); if (c) setText(c); else if (model) run(); return () => ctl.current?.abort() },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key])
  const idx = useMemo(() => nameIndex(graph), [graph])
  const lines = text.split('\n').filter((l) => l.trim())
  return (
    <div className="vz-explain" data-testid="viz-explain" role="dialog" aria-label="AI 解读本图">
      <div className="vz-explain-h"><Icon name="wand" size={13} /><b>AI 解读本图</b><span className="muted">{model || '未配置 AI'}</span><div className="flex1" />
        {model && !busy && text && <button className="icon-btn sm" onClick={run} title="重新生成" aria-label="重新生成"><Icon name="refresh" size={12} /></button>}
        {busy && <button className="icon-btn sm" onClick={() => { ctl.current?.abort(); setBusy(false); setErr('已停止') }} title="停止" aria-label="停止"><Icon name="stop" size={12} /></button>}
        <button className="icon-btn sm" onClick={onClose} title="关闭" aria-label="关闭"><Icon name="x" size={12} /></button>
      </div>
      {!model ? <div className="vz-explain-b"><span>配置 AI 模型后，可以让 AI 用几句话解读这张图，点名字直接跳到图上的方块。</span><button className="btn btn-sm btn-primary" onClick={onSettings}><Icon name="settings" size={12} />去配置 AI</button></div>
        : <div className="vz-explain-b" aria-live="polite">
          {busy && !text && <span className="muted"><Spinner size={11} /> AI 正在读图…</span>}
          {lines.map((l, i) => (
            <p key={i} className={/^建议先看/.test(l) ? 'tip' : ''}>{linkNames(l.replace(/^\s*[-*•]\s*/, ''), idx).map((p, j) => 'id' in p
              ? <button key={j} className="vz-ref" onClick={() => onFocus(p.id)} title="在图上定位">{p.ref}</button>
              : <React.Fragment key={j}>{p.text}</React.Fragment>)}</p>
          ))}
          {err && <span className="err">{err}{model && <button className="link" onClick={run}> 重试</button>}</span>}
        </div>}
    </div>
  )
}
