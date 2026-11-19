// Stable, flicker-free surfaces for streamed AI output (0.4.3).
// Every surface is mounted once when opened (never on "first token"), has a fixed / reserved height, scrolls
// internally, and receives text updates at most once per animation frame (see lib/aiRun.ts).
import React, { useEffect, useLayoutEffect, useRef } from 'react'
import type { AIRun, RunState } from '../lib/aiRun'
import { useRunState } from '../hooks/useAIRun'
import { Icon } from './Icon'
import { Markdown, Spinner } from './ui'

/** Keep a scroll container pinned to the bottom while streaming, unless the user scrolled up to read. */
function useStickToBottom(ref: React.RefObject<HTMLElement>, dep: unknown, active: boolean): void {
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const on = (): void => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [ref])
  useLayoutEffect(() => {
    if (!active) { stick.current = true; return }
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [dep, active, ref])
}

/** Body shared by panel + drawer: skeleton → streamed markdown → done / stopped / error. */
export function AIResultBody({ s, idle, onRetry, connecting, prefix }: {
  s: RunState
  idle?: React.ReactNode
  onRetry?: () => void
  connecting?: string
  prefix: string
}) {
  if (s.status === 'idle') return <div className="air-idle">{idle}</div>
  return (
    <>
      {s.status === 'running' && !s.text && (
        <div className="air-wait" aria-live="polite"><Spinner size={13} /><span>{connecting ?? '正在连接 AI…'}</span>
          <div className="air-skel"><i /><i /><i style={{ width: '62%' }} /></div></div>
      )}
      {!!s.text && <div className={`air-text${s.status === 'running' ? ' streaming' : ''}`} data-testid={`${prefix}-text`}><Markdown text={s.text} /></div>}
      {s.status === 'stopped' && <div className="air-note"><Icon name="stop" size={12} />已停止生成{s.text ? '（以上为部分结果，未缓存）' : ''}</div>}
      {s.status === 'error' && (
        <div className="air-error" role="alert" data-testid={`${prefix}-error`}>
          <Icon name="error" size={14} /><span>{s.error}</span>
          {onRetry && <button className="btn btn-xs" data-testid={`${prefix}-retry`} onClick={onRetry}><Icon name="refresh" size={12} />重试</button>}
        </div>
      )}
    </>
  )
}

/** Header actions: 停止 while running; 重新生成 / 复制 afterwards. */
function Actions({ s, prefix, onStop, onRegenerate }: { s: RunState; prefix: string; onStop: () => void; onRegenerate: () => void }) {
  return (
    <>
      {s.status === 'running'
        ? <button className="btn btn-xs" data-testid={`${prefix}-stop`} onClick={onStop} title="停止生成（会中断请求，不再计费）"><Icon name="stop" size={12} />停止</button>
        : (s.status === 'done' || s.status === 'stopped') && <button className="btn btn-xs" data-testid={`${prefix}-regen`} onClick={onRegenerate} title="忽略缓存，重新请求一次"><Icon name="refresh" size={12} />重新生成</button>}
      {s.status === 'done' && <button className="icon-btn xs" title="复制" aria-label="复制" onClick={() => navigator.clipboard.writeText(s.text)}><Icon name="copy" size={12} /></button>}
    </>
  )
}

/** Inline panel above the commit diff (历史 → AI 解释). Fixed height → the diff below never moves while streaming. */
export function CommitExplainPanel({ runner, short, model, onGenerate, onRegenerate, onClose }: {
  runner: AIRun; short: string; model: string; onGenerate: () => void; onRegenerate: () => void; onClose: () => void
}) {
  const s = useRunState(runner)
  const body = useRef<HTMLDivElement>(null)
  useStickToBottom(body, s.text, s.status === 'running')
  return (
    <section className="air-panel" data-testid="hx-ai-panel" data-status={s.status} aria-label="AI 解释此提交" aria-busy={s.status === 'running'}>
      <header className="air-head">
        <Icon name="ai" size={13} /><b>AI 解释</b><code>{short}</code>
        <span className="air-model" title="使用的服务商 · 模型">{model}</span>
        {s.cached && s.status === 'done' && <span className="pill air-cached" data-testid="hx-ai-cached" title="之前生成过，直接显示缓存结果；点「重新生成」可重新请求">来自缓存</span>}
        <div className="flex1" />
        <Actions s={s} prefix="hx-ai" onStop={() => runner.stop()} onRegenerate={onRegenerate} />
        <button className="icon-btn xs" title="收起" aria-label="收起 AI 解释" onClick={onClose}><Icon name="x" size={13} /></button>
      </header>
      <div className="air-body" ref={body}>
        <AIResultBody s={s} prefix="hx-ai" onRetry={onRegenerate} connecting={`正在请求 ${model}…`}
          idle={<><span className="muted">还没有解释过这个提交。</span><button className="btn btn-sm btn-ai" data-testid="hx-ai-generate" onClick={onGenerate}><Icon name="ai" size={13} />生成解释</button></>} />
      </div>
    </section>
  )
}

/** Toggle button for the panel: re-renders only when status / open changes (not per token). */
export function CommitExplainButton({ runner, open, onToggle }: { runner: AIRun; open: boolean; onToggle: () => void }) {
  const status = useRunState(runner, (x) => x.status)
  const running = status === 'running'
  return (
    <span className="air-btns">
      <button className={`btn btn-xs btn-ai${open ? ' on' : ''}`} data-testid="hx-ai-btn" aria-pressed={open} aria-busy={running} onClick={onToggle}
        title={running ? '正在生成，重复点击不会再发请求' : open ? '收起 AI 解释' : 'AI 解释这个提交（结果按提交缓存）'}>
        {running ? <><Spinner size={11} />生成中…</> : <><Icon name="ai" size={12} />AI 解释</>}
      </button>
      {running && <button className="btn btn-xs" data-testid="hx-ai-stop-inline" onClick={() => runner.stop()} title="停止生成"><Icon name="stop" size={12} />停止</button>}
    </span>
  )
}

/** Right-side drawer for longer AI output (变更 → AI 解释, 提交框 → AI 审查). Mounted on open, fixed height. */
export function AIDrawer({ runner, title, onClose, onRegenerate }: { runner: AIRun; title: React.ReactNode; onClose: () => void; onRegenerate: () => void }) {
  const s = useRunState(runner)
  const body = useRef<HTMLDivElement>(null)
  useStickToBottom(body, s.text, s.status === 'running')
  useEffect(() => {
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  // While generating, a stray click on the backdrop (e.g. on the button that opened the drawer) must not close +
  // restart the request — that was the 0.4.2 flicker loop. Close explicitly with ×/Esc/停止 while running.
  return (
    <div className="drawer" onMouseDown={(e) => { if (e.target === e.currentTarget && s.status !== 'running') onClose() }}>
      <div className="drawer-card" data-testid="ai-drawer" data-status={s.status} aria-busy={s.status === 'running'}>
        <div className="drawer-head"><Icon name="ai" />{title}<div className="flex1" />
          <Actions s={s} prefix="ai-drawer" onStop={() => runner.stop()} onRegenerate={onRegenerate} />
          <button className="icon-btn" title="关闭（生成中会停止）" aria-label="关闭" onClick={onClose}><Icon name="x" /></button></div>
        <div className="drawer-body" ref={body}><AIResultBody s={s} prefix="ai-drawer" onRetry={onRegenerate} /></div>
      </div>
    </div>
  )
}
