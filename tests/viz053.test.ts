import { describe, expect, it } from 'vitest'
import { visMark, memberDisplay, stereoOf, EDGE_NOTE, TAB_NOTATION } from '../src/renderer/src/lib/vizSe'
import { nodeSize } from '../src/renderer/src/lib/vizLayout'
import type { GNode, Member } from '../src/shared/viz'

describe('0.5.3 SE notation helpers', () => {
  it('parses UML visibility', () => {
    expect(visMark({ name: 'x', kind: 'field', status: 'unchanged', sig: 'private x: number' })).toBe('-')
    expect(visMark({ name: 'm', kind: 'method', status: 'unchanged', sig: 'public m()' })).toBe('+')
    expect(visMark({ name: 'p', kind: 'field', status: 'unchanged', sig: 'protected p' })).toBe('#')
    expect(memberDisplay({ name: 'foo', kind: 'method', status: 'unchanged' })).toBe('foo()')
  })

  it('exposes Chinese stereotypes and tab blurbs', () => {
    expect(stereoOf('layer')).toBe('容器')
    expect(stereoOf('component')).toBe('组件')
    expect(stereoOf('final')).toBe('终态')
    expect(stereoOf('class', true)).toBeNull()
    expect(TAB_NOTATION.classes).toMatch(/UML/)
    expect(EDGE_NOTE.extends).toMatch(/泛化/)
  })

  it('sizes UML final state and class compartments', () => {
    const fin = { id: 's:done', label: 'done', kind: 'final', status: 'unchanged' } as GNode
    expect(nodeSize(fin).h).toBeGreaterThanOrEqual(28)
    const members: Member[] = [
      { name: 'a', kind: 'field', status: 'unchanged', sig: 'private a' },
      { name: 'b', kind: 'field', status: 'added' },
      { name: 'm', kind: 'method', status: 'modified', sig: 'public m()' },
    ]
    const n = { id: 'c:1', label: 'Foo', kind: 'class', status: 'modified', members } as GNode
    const s = nodeSize(n)
    expect(s.h).toBeGreaterThan(44 + 18)
    expect(s.w).toBeGreaterThanOrEqual(160)
  })
})
