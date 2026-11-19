// Pure schedule math (local time): 每天 / 工作日 / 每周 + HH:MM, manual. Used by the scheduler and the UI.
import type { Schedule, AiTaskDef } from './tasks'

const DAY = 86400000
export const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']
const hm = (t: string): [number, number] => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); if (!m) return [9, 0]; return [Math.min(23, +m[1]), Math.min(59, +m[2])] }
const daysOf = (s: Schedule): number[] => s.kind === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : s.kind === 'weekdays' ? [1, 2, 3, 4, 5] : s.kind === 'weekly' ? (s.days.length ? s.days : [1]) : []
const at = (dayStart: Date, t: string) => { const [h, m] = hm(t); const d = new Date(dayStart); d.setHours(h, m, 0, 0); return d.getTime() }

/** first due time strictly after `from` (ms), or null for manual */
export function nextRun(s: Schedule, from: number): number | null {
  if (s.kind === 'manual') return null
  const days = daysOf(s)
  const d0 = new Date(from); d0.setHours(0, 0, 0, 0)
  for (let i = 0; i <= 8; i++) {
    const d = new Date(d0.getTime() + i * DAY + 3 * 3600000); d.setHours(0, 0, 0, 0) // DST-safe day stepping
    if (!days.includes(d.getDay())) continue
    const t = at(d, s.time)
    if (t > from) return t
  }
  return null
}
/** latest due time ≤ now, or null */
export function lastDue(s: Schedule, now: number): number | null {
  if (s.kind === 'manual') return null
  const days = daysOf(s)
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0)
  for (let i = 0; i <= 8; i++) {
    const d = new Date(d0.getTime() - i * DAY + 3 * 3600000); d.setHours(0, 0, 0, 0)
    if (!days.includes(d.getDay())) continue
    const t = at(d, s.time)
    if (t <= now) return t
  }
  return null
}
/** what the scheduler should do for a task at `now`: run it, record a missed run, or nothing.
 *  A due time within `graceMs` runs; older unhandled due times (app was closed) become "missed". */
export function decide(t: Pick<AiTaskDef, 'schedule' | 'enabled' | 'handledUntil' | 'createdAt'>, now: number, graceMs = 5 * 60000): { action: 'run' | 'missed' | 'none'; due?: number } {
  if (!t.enabled) return { action: 'none' }
  const due = lastDue(t.schedule, now)
  if (due === null || due <= (t.handledUntil ?? t.createdAt)) return { action: 'none' }
  return now - due <= graceMs ? { action: 'run', due } : { action: 'missed', due }
}
export function scheduleLabel(s: Schedule): string {
  if (s.kind === 'manual') return '仅手动运行'
  if (s.kind === 'daily') return `每天 ${s.time}`
  if (s.kind === 'weekdays') return `工作日 ${s.time}`
  return `每周${(s.days.length ? s.days : [1]).slice().sort().map((d) => WEEK_CN[d]).join('、')} ${s.time}`
}
