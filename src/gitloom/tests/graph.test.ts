import { describe, it, expect } from 'vitest'
import { layoutGraph } from '../src/renderer/src/lib/graph'

describe('commit graph layout', () => {
  it('linear history stays in lane 0', () => {
    const l = layoutGraph([{ hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }])
    expect(l.rows.map((r) => r.col)).toEqual([0, 0, 0])
    expect(l.maxCols).toBe(1)
  })
  it('branch + merge uses a second lane and converges', () => {
    // m merges f into main; history: m(p: b, f) f(p: a) b(p: a) a
    const l = layoutGraph([
      { hash: 'm', parents: ['b', 'f'] },
      { hash: 'f', parents: ['a'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] }
    ])
    expect(l.rows[0].col).toBe(0)
    expect(l.rows[1].col).toBe(1) // feature commit on lane 1
    expect(l.rows[2].col).toBe(0)
    expect(l.rows[3].col).toBe(0)
    // the feature lane is pulled back into lane 0 below 'b' (both lanes converge on 'a')
    expect(l.rows[2].segments.some((s) => s.x1 === 1 && s.x2 === 0 && s.y1 === 0 && s.y2 === 1)).toBe(true)
    expect(l.rows[3].segments.every((s) => s.x1 === 0 && s.x2 === 0)).toBe(true)
    expect(l.maxCols).toBe(2)
  })
  it('two branch tips get separate lanes', () => {
    const l = layoutGraph([{ hash: 'x', parents: ['a'] }, { hash: 'y', parents: ['a'] }, { hash: 'a', parents: [] }])
    expect(l.rows[0].col).toBe(0)
    expect(l.rows[1].col).toBe(1)
    expect(l.rows[2].col).toBe(0)
  })
})
