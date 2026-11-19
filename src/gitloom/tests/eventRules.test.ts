import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  shouldRun, normalizeState, makeRule, fromPreset, RULE_PRESETS,
  eventFromRunLabel, hasSameCombo, upsertRule, toggleRule, emptyState, rulesForEvent
} from '../src/shared/eventRules'

describe('eventRules shared', () => {
  it('maps run labels to trigger events', () => {
    expect(eventFromRunLabel('拉取')).toBe('pull')
    expect(eventFromRunLabel('变基拉取')).toBe('pull')
    expect(eventFromRunLabel('推送')).toBe('push')
    expect(eventFromRunLabel('抓取')).toBe('fetch')
    expect(eventFromRunLabel('提交')).toBe('commit')
    expect(eventFromRunLabel('储藏')).toBeNull()
  })
  it('shouldRun respects enabled + event', () => {
    expect(shouldRun({ enabled: true, event: 'pull' }, 'pull')).toBe(true)
    expect(shouldRun({ enabled: false, event: 'pull' }, 'pull')).toBe(false)
    expect(shouldRun({ enabled: true, event: 'push' }, 'pull')).toBe(false)
  })
  it('normalizeState drops bad rows', () => {
    const st = normalizeState({ rules: [{ id: 'a', event: 'pull', action: 'health', enabled: true }, { id: 'b', event: 'nope', action: 'health' }, null] })
    expect(st.rules).toHaveLength(1)
    expect(st.rules[0].id).toBe('a')
  })
  it('presets and combo dedupe', () => {
    expect(RULE_PRESETS.length).toBeGreaterThanOrEqual(4)
    let st = emptyState()
    const r = fromPreset(RULE_PRESETS[0])
    st = upsertRule(st, r)
    expect(hasSameCombo(st, r.event, r.action)).toBe(true)
    st = toggleRule(st, r.id, false)
    expect(rulesForEvent(st.rules, r.event)).toHaveLength(0)
  })
  it('makeRule fills defaults', () => {
    const r = makeRule({ event: 'fetch', action: 'wiki' })
    expect(r.enabled).toBe(true)
    expect(r.name).toContain('抓取')
  })
})

describe('eventRulesStore localStorage (mocked)', () => {
  const mem = new Map<string, string>()
  beforeEach(() => {
    mem.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v) },
      removeItem: (k: string) => { mem.delete(k) }
    })
  })
  it('persists per project', async () => {
    const { loadRules, saveRule, setRuleEnabled, deleteRule, clearAllRules } = await import('../src/renderer/src/lib/eventRulesStore')
    clearAllRules()
    const r = makeRule({ event: 'push', action: 'health', name: '推送后体检' })
    saveRule('proj-1', r)
    expect(loadRules('proj-1').rules).toHaveLength(1)
    expect(loadRules('proj-2').rules).toHaveLength(0)
    setRuleEnabled('proj-1', r.id, false)
    expect(loadRules('proj-1').rules[0].enabled).toBe(false)
    deleteRule('proj-1', r.id)
    expect(loadRules('proj-1').rules).toHaveLength(0)
  })
})
