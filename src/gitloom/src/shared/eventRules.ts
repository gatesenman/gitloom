/** 0.6.6 事件触发规则 — 本地触发器（拉取/推送/抓取/提交成功后异步跑动作） */

export type TriggerEvent = 'pull' | 'push' | 'fetch' | 'commit'
export type RuleAction = 'health' | 'wiki' | 'log'
export type RuleRunStatus = 'ok' | 'skip' | 'err'

export interface RuleLastRun {
  at: number
  status: RuleRunStatus
  message?: string
}

export interface EventRule {
  id: string
  /** 显示名；空则用 event×action 默认文案 */
  name: string
  event: TriggerEvent
  action: RuleAction
  enabled: boolean
  createdAt: number
  lastRun?: RuleLastRun | null
}

export interface EventRulesState {
  rules: EventRule[]
}

export const EVENT_LABELS: Record<TriggerEvent, string> = {
  pull: '成功拉取后',
  push: '成功推送后',
  fetch: '成功抓取后',
  commit: '成功提交后'
}

export const ACTION_LABELS: Record<RuleAction, string> = {
  health: '跑一次体检',
  wiki: '刷新/轻量更新项目 Wiki',
  log: '写一条运行记录'
}

export const EVENT_FROM_LABEL: Record<string, TriggerEvent> = {
  '拉取': 'pull',
  '变基拉取': 'pull',
  '推送': 'push',
  '抓取': 'fetch',
  '提交': 'commit'
}

/** Map a `run(label, …)` success label to a trigger event (or null). */
export function eventFromRunLabel(label: string): TriggerEvent | null {
  return EVENT_FROM_LABEL[label] ?? null
}

export function defaultRuleName(event: TriggerEvent, action: RuleAction): string {
  return `${EVENT_LABELS[event]} · ${ACTION_LABELS[action]}`
}

export interface RulePreset {
  id: string
  name: string
  desc: string
  event: TriggerEvent
  action: RuleAction
}

export const RULE_PRESETS: RulePreset[] = [
  { id: 'pull-health', name: '拉取后体检', desc: '成功拉取后，对本仓库跑一轮安全默认体检', event: 'pull', action: 'health' },
  { id: 'push-health', name: '推送后体检', desc: '成功推送后跑体检（不拦截推送，失败只提示）', event: 'push', action: 'health' },
  { id: 'fetch-health', name: '抓取后体检', desc: '成功抓取远程后跑体检', event: 'fetch', action: 'health' },
  { id: 'pull-wiki', name: '拉取后更新 Wiki', desc: '成功拉取后轻量吸收最近提交到项目 Wiki', event: 'pull', action: 'wiki' },
  { id: 'commit-log', name: '提交后写运行记录', desc: '成功提交后在规则里记一条本地运行记录', event: 'commit', action: 'log' }
]

export function emptyState(): EventRulesState {
  return { rules: [] }
}

export function normalizeState(raw: unknown): EventRulesState {
  if (!raw || typeof raw !== 'object') return emptyState()
  const rulesIn = (raw as { rules?: unknown }).rules
  if (!Array.isArray(rulesIn)) return emptyState()
  const rules: EventRule[] = []
  for (const x of rulesIn) {
    if (!x || typeof x !== 'object') continue
    const o = x as Partial<EventRule>
    if (!o.id || typeof o.id !== 'string') continue
    if (o.event !== 'pull' && o.event !== 'push' && o.event !== 'fetch' && o.event !== 'commit') continue
    if (o.action !== 'health' && o.action !== 'wiki' && o.action !== 'log') continue
    rules.push({
      id: o.id,
      name: typeof o.name === 'string' ? o.name : defaultRuleName(o.event, o.action),
      event: o.event,
      action: o.action,
      enabled: o.enabled !== false,
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
      lastRun: o.lastRun && typeof o.lastRun === 'object' && typeof (o.lastRun as RuleLastRun).at === 'number'
        ? {
            at: (o.lastRun as RuleLastRun).at,
            status: (['ok', 'skip', 'err'] as RuleRunStatus[]).includes((o.lastRun as RuleLastRun).status)
              ? (o.lastRun as RuleLastRun).status
              : 'ok',
            message: typeof (o.lastRun as RuleLastRun).message === 'string' ? (o.lastRun as RuleLastRun).message : undefined
          }
        : null
    })
  }
  return { rules }
}

/** Whether a rule should fire for this event. */
export function shouldRun(rule: Pick<EventRule, 'enabled' | 'event'>, event: TriggerEvent): boolean {
  return !!rule.enabled && rule.event === event
}

export function rulesForEvent(rules: EventRule[], event: TriggerEvent): EventRule[] {
  return rules.filter((r) => shouldRun(r, event))
}

export function makeRule(partial: { event: TriggerEvent; action: RuleAction; name?: string; enabled?: boolean; id?: string }): EventRule {
  const event = partial.event
  const action = partial.action
  return {
    id: partial.id ?? `er-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: (partial.name?.trim() || defaultRuleName(event, action)),
    event,
    action,
    enabled: partial.enabled !== false,
    createdAt: Date.now(),
    lastRun: null
  }
}

export function fromPreset(p: RulePreset): EventRule {
  return makeRule({ event: p.event, action: p.action, name: p.name })
}

export function upsertRule(state: EventRulesState, rule: EventRule): EventRulesState {
  const i = state.rules.findIndex((r) => r.id === rule.id)
  if (i < 0) return { rules: [...state.rules, rule] }
  const rules = state.rules.slice()
  rules[i] = rule
  return { rules }
}

export function toggleRule(state: EventRulesState, id: string, enabled?: boolean): EventRulesState {
  return {
    rules: state.rules.map((r) => r.id === id ? { ...r, enabled: enabled ?? !r.enabled } : r)
  }
}

export function removeRule(state: EventRulesState, id: string): EventRulesState {
  return { rules: state.rules.filter((r) => r.id !== id) }
}

export function recordRun(state: EventRulesState, id: string, lastRun: RuleLastRun): EventRulesState {
  return {
    rules: state.rules.map((r) => r.id === id ? { ...r, lastRun } : r)
  }
}

/** Deduplicate: same event+action already present (for preset add). */
export function hasSameCombo(state: EventRulesState, event: TriggerEvent, action: RuleAction): boolean {
  return state.rules.some((r) => r.event === event && r.action === action)
}
