/** Per-project event-trigger rules (localStorage; mirrors commitHistory / wiki settings pattern). */
import {
  type EventRulesState, type EventRule, type RuleLastRun,
  emptyState, normalizeState, upsertRule, toggleRule, removeRule, recordRun
} from '@shared/eventRules'

export const STORAGE_KEY = 'gitloom.eventRules'

type All = Record<string, EventRulesState>

function readAll(): All {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (!v) return {}
    const parsed = JSON.parse(v) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: All = {}
    for (const [k, raw] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = normalizeState(raw)
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(all: All): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)) } catch { /* quota / disabled */ }
}

export function loadRules(projectId: string): EventRulesState {
  if (!projectId) return emptyState()
  return readAll()[projectId] ?? emptyState()
}

export function saveRules(projectId: string, state: EventRulesState): EventRulesState {
  if (!projectId) return state
  const all = readAll()
  all[projectId] = normalizeState(state)
  writeAll(all)
  return all[projectId]
}

export function saveRule(projectId: string, rule: EventRule): EventRulesState {
  return saveRules(projectId, upsertRule(loadRules(projectId), rule))
}

export function setRuleEnabled(projectId: string, id: string, enabled?: boolean): EventRulesState {
  return saveRules(projectId, toggleRule(loadRules(projectId), id, enabled))
}

export function deleteRule(projectId: string, id: string): EventRulesState {
  return saveRules(projectId, removeRule(loadRules(projectId), id))
}

export function patchLastRun(projectId: string, id: string, lastRun: RuleLastRun): EventRulesState {
  return saveRules(projectId, recordRun(loadRules(projectId), id, lastRun))
}

/** Test helper: wipe all stored rules. */
export function clearAllRules(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* */ }
}
