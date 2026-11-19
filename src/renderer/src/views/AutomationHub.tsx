/** 自动化 module shell — keep light so first open does not pull Monaco / xyflow / health. */
import React, { Suspense, lazy, useEffect, useState } from 'react'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/ui'

const EventRulesPanel = lazy(() => import('./EventRulesPanel'))
const HooksView = lazy(() => import('./HooksView'))
const TasksPanel = lazy(() => import('./TasksPanel'))

const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

function PanelFallback({ label }: { label: string }) {
  return (
    <div className="us-loading" data-testid="auto-panel-loading" role="status" aria-live="polite">
      <Spinner size={14} /><span>加载{label}…</span>
    </div>
  )
}

/**
 * Defer panel mount until after paint: rAF ×2 lets module chrome + secondary tabs commit,
 * then idle/timeout mounts the lazy panel (IPC/Monaco stay off the click turn).
 */
function Deferred({ children, label }: { children: React.ReactNode; label: string }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    let ricId: number | undefined
    let timeoutId: number | undefined
    const kick = () => { if (!cancelled) setReady(true) }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    const afterPaint = () => {
      if (cancelled) return
      if (typeof w.requestIdleCallback === 'function') {
        ricId = w.requestIdleCallback(kick, { timeout: 120 })
      } else {
        timeoutId = window.setTimeout(kick, 0)
      }
    }
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(afterPaint)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      if (ricId != null) w.cancelIdleCallback?.(ricId)
      if (timeoutId != null) window.clearTimeout(timeoutId)
    }
  }, [])
  if (!ready) return <PanelFallback label={label} />
  return <>{children}</>
}

export function AutomationView() {
  const { view, active, setView } = useApp()
  const zone = view === 'hooks' ? 'hooks' : view === 'aitasks' ? 'tasks' : 'events'
  return (
    <div className="view-stack auto-hub" data-testid="automation-hub">
      <div className="view-body auto-zone">
        {zone === 'events' && (
          <section className="mod-hub-sec" data-testid="auto-events">
            <div className="mod-hub-sec-head">
              <b title="拉取、推送、抓取、提交成功后异步跑体检 / Wiki / 写记录">事件触发</b>
              <span className="muted small">按项目本地保存 · 不拦截 Git</span>
            </div>
            <Suspense fallback={<PanelFallback label="事件规则" />}>
              <Deferred label="事件规则"><EventRulesPanel /></Deferred>
            </Suspense>
          </section>
        )}
        {zone === 'hooks' && (
          <section className="mod-hub-sec" data-testid="auto-hooks">
            <div className="mod-hub-sec-head">
              <b>Git 钩子与模板库</b>
              {active ? <span className="muted">当前仓库：{base(active)}</span> : <span className="muted">先选仓库</span>}
              <span className="spacer" />
              <button className="btn btn-sm btn-ghost" data-testid="a-log-hooks" title="打开 GitLoom 命令运行记录"
                onClick={() => window.dispatchEvent(new Event('gitloom:showlog'))}>
                <Icon name="log" size={13} />本区运行记录
              </button>
            </div>
            {active ? (
              <Suspense fallback={<PanelFallback label="钩子" />}>
                <Deferred label="钩子"><HooksView /></Deferred>
              </Suspense>
            ) : (
              <div className="mod-hub-empty" data-testid="auto-hooks-empty" role="status">
                <p className="muted">钩子属于单个仓库（.git/hooks）。当前没有选中仓库。</p>
                <p className="muted">请在左侧边栏点击一个仓库，或先打开「工作区 → 仓库与扫描」找到仓库后再回来。</p>
                <p className="muted small">设置里的「Git 钩子」入口仍然保留。</p>
                <div className="mod-hub-empty-actions">
                  <button type="button" className="btn btn-sm" data-testid="auto-hooks-goto-repos" onClick={() => setView('repos')}>打开仓库与扫描</button>
                </div>
              </div>
            )}
          </section>
        )}
        {zone === 'tasks' && (
          <section className="mod-hub-sec" data-testid="ai-tasks">
            <div className="mod-hub-sec-head">
              <b title="按时间让 AI 在本机做只读分析：问题日报、安全扫描、依赖漏洞等">定时任务</b>
              <span className="muted small">本机运行 · 默认只读 · 运行记录在每个任务下方</span>
              <span className="spacer" />
              <button className="link small" onClick={() => setView('settings')} title="配置 AI 模型与服务商">AI 设置</button>
            </div>
            <Suspense fallback={<PanelFallback label="定时任务" />}>
              <Deferred label="定时任务"><TasksPanel /></Deferred>
            </Suspense>
          </section>
        )}
      </div>
    </div>
  )
}

export default AutomationView
