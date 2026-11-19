/**
 * 工作区 · 概览 — 今日待办 + 批量同步结果摘要.
 */
import { describe, it, expect } from 'vitest'
import type { DiscoveredRepo, RepoSummary } from '../src/shared/types'
import { summarizeBulkResults, todayTodos } from '../src/renderer/src/lib/dashOverview'

const R = (path: string, extra: Partial<DiscoveredRepo> = {}): DiscoveredRepo => ({
  path, rel: path.replace(/^\/p\/?/, ''), kind: 'normal', initialized: true, ...extra
})
const S = (path: string, x: Partial<RepoSummary> = {}): RepoSummary => ({
  path, name: path.split('/').pop()!, branch: 'main', changes: 0, ahead: 0, behind: 0,
  isWorktree: false, upstream: 'origin/main', ...x
})

const repos: DiscoveredRepo[] = [
  R('/p/clean'),
  R('/p/ahead', { rel: 'ahead' }),
  R('/p/behind', { rel: 'behind' }),
  R('/p/conflict', { rel: 'conflict' }),
  R('/p/dirty', { rel: 'dirty' }),
  R('/p/op', { rel: 'op' }),
  R('/p/bare', { rel: 'bare', kind: 'bare' }),
  R('/p/uninit', { rel: 'uninit', initialized: false })
]
const sums: Record<string, RepoSummary | undefined> = {
  '/p/clean': S('/p/clean'),
  '/p/ahead': S('/p/ahead', { ahead: 2 }),
  '/p/behind': S('/p/behind', { behind: 3 }),
  '/p/conflict': S('/p/conflict', { conflicts: 2, operation: 'MERGING', changes: 3 }),
  '/p/dirty': S('/p/dirty', { changes: 5 }),
  '/p/op': S('/p/op', { operation: 'REBASING' }),
  '/p/bare': S('/p/bare'),
  '/p/uninit': undefined
}

describe('todayTodos', () => {
  it('prioritizes conflict → push → behind; one card per repo', () => {
    const todos = todayTodos(repos, sums)
    expect(todos.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'conflict:conflict',
      'conflict:op',
      'push:ahead',
      'behind:behind'
    ])
    expect(todos.every((t) => t.view === 'changes')).toBe(true)
    expect(todos.find((t) => t.kind === 'conflict')!.label).toBe('有冲突')
    expect(todos.find((t) => t.kind === 'push')!.label).toBe('未推送')
    expect(todos.find((t) => t.kind === 'behind')!.label).toBe('落后上游')
  })
  it('optionally includes dirty repos as 有未提交', () => {
    const todos = todayTodos(repos, sums, { includeDirty: true })
    expect(todos.some((t) => t.kind === 'dirty' && t.name === 'dirty')).toBe(true)
    expect(todos.find((t) => t.kind === 'dirty')!.label).toBe('有未提交')
  })
  it('skips bare / uninitialized / errored', () => {
    const withErr = { ...sums, '/p/ahead': S('/p/ahead', { ahead: 1, error: 'boom' }) }
    const todos = todayTodos(repos, withErr)
    expect(todos.map((t) => t.name)).not.toContain('ahead')
    expect(todos.map((t) => t.name)).not.toContain('bare')
    expect(todos.map((t) => t.name)).not.toContain('uninit')
  })
})

describe('summarizeBulkResults', () => {
  it('counts success / fail / skip and builds one-liners (errors first)', () => {
    const s = summarizeBulkResults({
      '/p/a': { state: 'ok', message: '已是最新' },
      '/p/b': { state: 'err', message: '网络错误' },
      '/p/c': { state: 'skip', message: '没有上游分支' },
      '/p/d': { state: 'ok', message: '已推送 2 个提交' }
    }, { label: '批量同步' })
    expect(s.ok).toBe(2)
    expect(s.err).toBe(1)
    expect(s.skip).toBe(1)
    expect(s.countsLine).toBe('成功 2 · 失败 1 · 跳过 1')
    expect(s.title).toBe('批量同步结果')
    expect(s.tone).toBe('mixed')
    expect(s.lines[0]).toMatchObject({ path: '/p/b', state: 'err' })
  })
  it('tone is running while pending; ok when all succeed', () => {
    expect(summarizeBulkResults({
      '/p/a': { state: 'running' },
      '/p/b': { state: 'ok', message: 'ok' }
    }).tone).toBe('running')
    expect(summarizeBulkResults({
      '/p/a': { state: 'ok', message: 'ok' },
      '/p/b': { state: 'ok', message: 'ok' }
    }).tone).toBe('ok')
    expect(summarizeBulkResults({
      '/p/a': { state: 'err', message: 'fail' }
    }).tone).toBe('err')
  })
})
