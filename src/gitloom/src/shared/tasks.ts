// 0.6.1 AI 定时任务: shared types (main ↔ renderer).
export type TemplateId =
  | 'issues' | 'security' | 'branches'
  | 'deps' | 'stale-pr' | 'bigfiles' | 'changelog' | 'coverage' | 'license' | 'secrets-drift' | 'release-checklist'
export type Schedule =
  | { kind: 'manual' }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
export interface TaskScope { kind: 'repo' | 'project' | 'group'; label: string; repos: string[] }
export interface AiTaskDef {
  id: string
  name: string
  prompt: string
  template?: TemplateId | null
  scope: TaskScope
  schedule: Schedule
  /** desktop notification when a run finishes */
  notify: boolean
  /** analysis-only unless explicitly enabled per task */
  allowWrite: boolean
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  /** due times up to here have been handled (ran or marked missed) */
  handledUntil?: number
  /** a due time that passed while the app was closed / busy */
  missedAt?: number | null
}
export type RunTrigger = 'manual' | 'schedule' | 'missed'
export interface TaskRun {
  id: string
  taskId: string
  trigger: RunTrigger
  startedAt: number
  finishedAt?: number
  status: 'running' | 'ok' | 'error' | 'blocked'
  markdown: string
  /** machine-readable result (e.g. security finding keys for the next run's diff) */
  data?: unknown
}
export interface IssueConnectorView { url: string; authHeader: string; hasToken: boolean }
export interface TasksState { tasks: AiTaskDef[]; runs: TaskRun[]; connector: IssueConnectorView; running: string[] }

/** Templates with dedicated deterministic runners (do not require AI to start). */
export const DETERMINISTIC_TEMPLATES: ReadonlySet<TemplateId> = new Set(['issues', 'security', 'branches'])
