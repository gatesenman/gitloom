import { describe, it, expect } from 'vitest'
import {
  emptySummary, summarizeFindings, healthScore, plainConclusions, PLAIN_SEV,
  type Finding, type HealthReport
} from '../src/shared/health'

const baseFinding = (over: Partial<Finding> = {}): Finding => ({
  id: over.id || 'f1',
  severity: over.severity || 'medium',
  category: over.category || 'static',
  title: over.title || 't',
  evidence: over.evidence || {},
  source: over.source || 'builtin',
  confidence: over.confidence || 'medium',
  status: over.status || 'open',
  ...over
})

function report(findings: Finding[], extra: Partial<HealthReport> = {}): HealthReport {
  return {
    id: 'r1', createdAt: 0, scope: 'working', repo: '/r', checksRun: ['secret', 'static'],
    findings, summary: summarizeFindings(findings), durationMs: 10, ...extra
  }
}

describe('0.6.6 quality beginner helpers', () => {
  it('PLAIN_SEV uses 严重/注意/提示', () => {
    expect(PLAIN_SEV.critical).toBe('严重')
    expect(PLAIN_SEV.high).toBe('严重')
    expect(PLAIN_SEV.medium).toBe('注意')
    expect(PLAIN_SEV.low).toBe('提示')
    expect(PLAIN_SEV.info).toBe('提示')
  })

  it('healthScore is 100 when no open findings', () => {
    expect(healthScore(report([]))).toBe(100)
    expect(healthScore(report([baseFinding({ status: 'fixed', severity: 'critical' })]))).toBe(100)
  })

  it('healthScore drops with severe open findings', () => {
    const s = healthScore(report([
      baseFinding({ id: 'a', severity: 'critical' }),
      baseFinding({ id: 'b', severity: 'high' })
    ]))
    expect(s).toBeLessThan(100)
    expect(s).toBe(60) // 100-25-15
  })

  it('plainConclusions mentions secrets and severe in 白话', () => {
    const lines = plainConclusions(report([
      baseFinding({ id: 's', severity: 'critical', category: 'secret', title: '密钥' }),
      baseFinding({ id: 'h', severity: 'high', category: 'static' })
    ]))
    expect(lines.some((l) => /密钥/.test(l))).toBe(true)
    expect(lines.some((l) => /严重/.test(l))).toBe(true)
  })

  it('plainConclusions clean report', () => {
    const lines = plainConclusions(report([]))
    expect(lines[0]).toMatch(/没发现明显问题/)
    expect(emptySummary().open).toBe(0)
  })
})
