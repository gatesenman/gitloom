import { describe, it, expect } from 'vitest'
import {
  summarizeFindings, compareHealthReports, pickCompareTargets, plainCompareLine, findingFingerprint,
  type Finding, type HealthReport
} from '../src/shared/health'

const f = (over: Partial<Finding> = {}): Finding => ({
  id: over.id || 'f1', severity: over.severity || 'medium', category: over.category || 'static',
  title: over.title || 't', evidence: over.evidence || { path: 'a.ts', line: 1 },
  source: over.source || 'builtin', confidence: over.confidence || 'medium', status: over.status || 'open', ...over
})

function report(id: string, at: number, findings: Finding[]): HealthReport {
  return {
    id, createdAt: at, scope: 'working', repo: '/r', checksRun: ['static'],
    findings, summary: summarizeFindings(findings), durationMs: 1
  }
}

describe('0.6.9 health history compare', () => {
  it('fingerprint ignores id', () => {
    expect(findingFingerprint(f({ id: '1', title: '密钥' }))).toBe(findingFingerprint(f({ id: '2', title: '密钥' })))
  })

  it('compareHealthReports counts new/fixed and score delta', () => {
    const then = report('old', 1, [f({ id: 'a', title: '旧问题', severity: 'high' }), f({ id: 'b', title: '已修', severity: 'medium' })])
    const now = report('new', 2, [f({ id: 'a', title: '旧问题', severity: 'high' }), f({ id: 'c', title: '新问题', severity: 'low' })])
    const c = compareHealthReports(now, then)
    expect(c.newCount).toBe(1)
    expect(c.fixedCount).toBe(1)
    expect(c.scoreDelta).toBe(c.scoreNow - c.scoreThen)
  })

  it('pickCompareTargets previous and week-ago', () => {
    const now = Date.parse('2026-11-01T12:00:00+08:00')
    const metas = [
      { id: 'latest', createdAt: now },
      { id: 'prev', createdAt: now - 3600_000 },
      { id: 'week', createdAt: now - 7 * 86_400_000 }
    ]
    const t = pickCompareTargets(metas, { now, latestId: 'latest' })
    expect(t.previousId).toBe('prev')
    expect(t.weekAgoId).toBe('week')
  })

  it('plainCompareLine beginner Chinese', () => {
    const line = plainCompareLine('上次', {
      scoreNow: 90, scoreThen: 80, scoreDelta: 10, newCount: 1, fixedCount: 2, thenAt: 1, thenId: 'x'
    })
    expect(line).toMatch(/比上次/)
    expect(line).toMatch(/好了 10 分/)
    expect(line).toMatch(/新发现 1/)
    expect(line).toMatch(/已好转/)
  })
})
