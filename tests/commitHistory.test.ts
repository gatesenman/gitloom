import { describe, it, expect } from 'vitest'
import { pushHistory, filterHistory, splitMessage, HISTORY_MAX } from '../src/renderer/src/lib/commitHistory'

describe('commit message history', () => {
  it('puts newest first and de-duplicates', () => {
    let l: string[] = []
    l = pushHistory(l, 'feat: a')
    l = pushHistory(l, 'fix: b')
    l = pushHistory(l, '  feat: a  ')
    expect(l).toEqual(['feat: a', 'fix: b'])
  })
  it('ignores empty messages', () => {
    expect(pushHistory(['x'], '   ')).toEqual(['x'])
  })
  it('caps the list', () => {
    let l: string[] = []
    for (let i = 0; i < 30; i++) l = pushHistory(l, `m${i}`)
    expect(l.length).toBe(HISTORY_MAX)
    expect(l[0]).toBe('m29')
  })
  it('filters case-insensitively and splits summary/body', () => {
    expect(filterHistory(['Feat: Login', 'fix: x'], 'login')).toEqual(['Feat: Login'])
    expect(filterHistory(['a', 'b'], '')).toEqual(['a', 'b'])
    expect(splitMessage('feat: x\n\nline1\nline2')).toEqual({ summary: 'feat: x', body: 'line1\nline2' })
  })
})
