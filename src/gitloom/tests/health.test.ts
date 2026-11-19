import { describe, it, expect } from 'vitest'
import { repoHealth, healthTip } from '../src/renderer/src/lib/health'
const base = { path: '/r', name: 'r', branch: 'main', changes: 0, ahead: 0, behind: 0, isWorktree: false, upstream: 'origin/main' }
describe('0.6.1 体检', () => {
  it('clean repo is healthy', () => { const h = repoHealth(base); expect(h.score).toBe(100); expect(h.grade).toBe('good') })
  it('conflicts + behind → needs action, tooltip lists issues', () => {
    const h = repoHealth({ ...base, conflicts: 2, behind: 3, changes: 4 })
    expect(h.grade).toBe('bad'); expect(h.issues.length).toBe(3); expect(healthTip(h)).toMatch(/冲突/)
  })
  it('no upstream and errors', () => {
    expect(repoHealth({ ...base, upstream: null }).issues[0].text).toMatch(/远程/)
    expect(repoHealth({ ...base, error: 'x' }).label).toBe('读取失败')
    expect(repoHealth(undefined).grade).toBe('na')
  })
})
