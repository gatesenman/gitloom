// Hand-off from other views (历史 / 比较 / 变更 / 跨仓库变更 / 改动摘要) to 变更可视化: the request is parked in sessionStorage and
// announced with an event, so it works whether the view is already mounted or not.
import type { VizScope } from '../../../shared/viz'

export interface VizHandoff { repo: string; scope: VizScope; filter?: string }
const KEY = 'gitloom.viz'
const SOFT = 'gitloom.viz.soft'
export function parkViz(h: VizHandoff): void {
  sessionStorage.setItem(KEY, JSON.stringify(h))
  softParkViz(h)
  window.dispatchEvent(new CustomEvent('gitloom:viz', { detail: h }))
}
/** Remember last summary scope so strip 「可视化」 can reuse it without forcing re-select. */
export function softParkViz(h: VizHandoff): void {
  sessionStorage.setItem(SOFT, JSON.stringify(h))
}
export function takeViz(repo: string | null): VizHandoff | null {
  const raw = sessionStorage.getItem(KEY)
  if (!raw) return null
  sessionStorage.removeItem(KEY)
  try { const h = JSON.parse(raw) as VizHandoff; return !repo || h.repo === repo ? h : null } catch { return null }
}
/** Non-consuming peek of soft-parked scope (same repo). */
export function peekSoftViz(repo: string | null): VizHandoff | null {
  const raw = sessionStorage.getItem(SOFT)
  if (!raw) return null
  try { const h = JSON.parse(raw) as VizHandoff; return !repo || h.repo === repo ? h : null } catch { return null }
}
