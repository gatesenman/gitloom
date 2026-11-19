// 改动导览 (0.5.1) step list — Codemaps-style numbered code path (1, 1a, 1b…) grouped with a short guide per group,
// "已看过" check boxes with progress (CodeSee review style). Static reading order works without AI; the AI path is
// generated from a question and may only reference real code locations found by static analysis.
import React from 'react'
import type { Tour, TourStep } from '@shared/viz'
import { Icon } from '../Icon'
import { Spinner } from '../ui'
import { STATUS_WORD, tourProgress } from '../../lib/codemap'

export type TourSrc = 'static' | 'ai'
export interface TourAI { model: string; running: boolean; text?: string; error?: string }

export function TourList({ tour, src, setSrc, seen, onSeen, selected, onPick, question, setQuestion, ai, onRun, onCancel, onSettings, onResetSeen }: {
  tour: Tour | null; src: TourSrc; setSrc: (s: TourSrc) => void; seen: Set<string>; onSeen: (id: string, v: boolean) => void; onResetSeen: () => void
  selected: string | null; onPick: (s: TourStep) => void; question: string; setQuestion: (q: string) => void
  ai: TourAI; onRun: () => void; onCancel: () => void; onSettings: () => void
}) {
  const prog = tour ? tourProgress(tour, seen) : { done: 0, total: 0 }
  return (
    <div className="vz-list tour-list" data-testid="viz-tour-list">
      <div className="seg vz-list-seg" role="group" aria-label="导览来源">
        <button className={src === 'static' ? 'on' : ''} onClick={() => setSrc('static')} title="静态分析：按调用顺序（调用方在前）排列改动的文件和函数，无需 AI" data-testid="tour-src-static"><Icon name="tour" size={11} />阅读路线</button>
        <button className={src === 'ai' ? 'on' : ''} onClick={() => setSrc('ai')} title="AI 按你的问题规划代码路径，每一步都引用真实的代码位置" data-testid="tour-src-ai"><Icon name="wand" size={11} />AI 路径</button>
      </div>
      {src === 'ai' && (
        <div className="tour-ask">
          <textarea className="input" rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="想了解什么？例如：下单流程改动前后怎么走" aria-label="导览问题" data-testid="tour-question"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onRun() }} />
          {!ai.model ? <button className="btn btn-sm btn-primary" onClick={onSettings} data-testid="tour-ai-setup"><Icon name="settings" size={12} />去配置 AI</button>
            : ai.running ? <button className="btn btn-sm" onClick={onCancel} data-testid="tour-ai-cancel"><Spinner size={11} />停止</button>
            : <button className="btn btn-sm btn-primary" onClick={onRun} title={`Ctrl+Enter · ${ai.model}`} data-testid="tour-ai-run"><Icon name="wand" size={12} />{tour ? '重新生成' : '生成路径'}</button>}
          {ai.running && ai.text && <span className="tour-ai-txt">{ai.text}</span>}
          {ai.error && !ai.running && <span className="tour-ai-err" data-testid="tour-ai-error">{ai.error}</span>}
          {!ai.model && <span className="tour-ai-txt">配置 AI 后，可以像 Codemaps 一样问「某个功能怎么走」，得到分组、编号、可点击的代码路径。</span>}
        </div>
      )}
      {tour && (<>
        <div className="tour-head">
          <b title={tour.title}>{tour.title}</b>
          {tour.summary && <span className="tour-sum">{tour.summary}</span>}
          {prog.total > 0 && <div className="tour-prog" title="勾选「已看过」跟踪评审进度" data-testid="tour-progress">
            <div className="vz-bar"><i style={{ width: `${(prog.done / prog.total) * 100}%` }} /></div><span>已看过 {prog.done}/{prog.total}</span>
            {prog.done > 0 && <button className="link" onClick={onResetSeen} title="清除勾选">清除</button>}
          </div>}
        </div>
        <div className="vz-list-items tour-items">
          {tour.groups.map((g) => (
            <div key={g.id} className="tour-group">
              <div className="tour-gt">{g.title}</div>
              {g.guide && <div className="tour-guide">{g.guide}</div>}
              {g.steps.map((s) => (
                <div key={s.id} className={`tour-step k-${s.kind} st-${s.status}${selected === s.id ? ' on' : ''}${seen.has(s.id) ? ' seen' : ''}`} data-testid="tour-step" data-n={s.n}>
                  <input type="checkbox" checked={seen.has(s.id)} onChange={(e) => onSeen(s.id, e.target.checked)} aria-label={`已看过第 ${s.n} 步`} title="已看过" />
                  <button className="tour-step-b" onClick={() => onPick(s)} title={`${s.why}\n${(s.after ?? s.before)?.file ?? s.file}:${(s.after ?? s.before)?.line ?? ''}`}>
                    <span className="tour-n">{s.n}</span>
                    <span className="tour-t">{s.title}{s.hub && <Icon name="flame" size={10} />}</span>
                    {s.status !== 'unchanged' ? <span className={`tour-st st-${s.status}`}>{STATUS_WORD[s.status]}</span> : <span className="tour-st">路径</span>}
                    <span className="tour-why">{s.why}</span>
                  </button>
                </div>
              ))}
            </div>
          ))}
          {!tour.groups.length && <div className="vz-li-empty">这次改动没有可导览的文件</div>}
        </div>
      </>)}
      {!tour && src === 'ai' && !ai.running && ai.model && <div className="vz-li-empty">输入问题后点「生成路径」。留空则生成「这次改动的主要执行路径」。</div>}
    </div>
  )
}
