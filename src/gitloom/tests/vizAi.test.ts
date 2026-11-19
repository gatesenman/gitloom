// AI enrichment: JSON repair, strict schema with referential checks, conversion into diff graphs / sequences / states
import { describe, it, expect } from 'vitest'
import { repairJson, validateAI, convertAI, VizAISchema } from '../src/main/viz/ai'
import { AI_JSON } from './fixtures/vizAi'
import type { VizResult } from '../src/shared/viz'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const R = { key: 'k1' } as unknown as VizResult

describe('repairJson', () => {
  it('plain JSON is untouched', () => { expect(repairJson('{"a":1}')).toEqual({ value: { a: 1 }, repaired: false }) })
  it('markdown fence + chatter', () => {
    const r = repairJson('好的，结果如下：\n```json\n{"a": [1, 2]}\n```\n希望有帮助')
    expect(r.value).toEqual({ a: [1, 2] }); expect(r.repaired).toBe(true)
  })
  it('trailing commas, comments, unquoted keys, smart quotes', () => {
    expect(repairJson('{a: 1, "b": [1,2,], // note\n c: \u201cx\u201d,}').value).toEqual({ a: 1, b: [1, 2], c: 'x' })
  })
  it('truncated answer gets its brackets balanced', () => {
    expect(repairJson('{"a": {"b": [1, 2').value).toEqual({ a: { b: [1, 2] } })
    expect(repairJson('{"a": "unterminated').value).toEqual({ a: 'unterminated' })
  })
  it('URLs inside strings survive comment stripping', () => { expect(repairJson('{"u": "http://x/y",}').value).toEqual({ u: 'http://x/y' }) })
  it('hopeless input throws', () => { expect(() => repairJson('no json here')).toThrow() })
})

describe('validateAI (zod schema)', () => {
  it('accepts the reference answer', () => {
    const r = validateAI(JSON.stringify(AI_JSON)); expect(r.ok).toBe(true)
    expect(VizAISchema.safeParse(AI_JSON).success).toBe(true)
  })
  it('accepts null sides (added / removed diagrams) and an empty object', () => {
    const j = clone(AI_JSON) as any; j.sequences[0].before = null; j.flows[0].after = null
    expect(validateAI(JSON.stringify(j)).ok).toBe(true); expect(validateAI('{}').ok).toBe(true)
  })
  it('rejects undeclared participants / states / nodes / components with readable paths', () => {
    const j = clone(AI_JSON) as any
    j.sequences[0].after.steps[2].branches[0].steps.push({ type: 'msg', from: 'ghost', to: 'svc', label: 'x' })
    j.states[0].after.transitions.push({ from: 'paid', to: 'lost', event: 'x' })
    j.flows[0].after.edges.push({ from: 'nope', to: 'e' })
    j.architecture.links.push({ from: 'ui', to: 'missing', status: 'added' })
    const r = validateAI(JSON.stringify(j))
    expect(r.ok).toBe(false)
    const errs = (r as { errors: string[] }).errors.join('\n')
    for (const w of ['ghost', 'lost', 'nope', 'missing']) expect(errs).toContain(w)
    expect(errs).toContain('sequences.0.after')
  })
  it('wildcard * is a valid transition source', () => {
    const j = clone(AI_JSON) as any; j.states[0].after.transitions.push({ from: '*', to: 'cancelled', event: 'abort' })
    expect(validateAI(JSON.stringify(j)).ok).toBe(true)
  })
  it('rejects wrong enums and oversized labels', () => {
    const j = clone(AI_JSON) as any; j.risk = 'extreme'
    expect(validateAI(JSON.stringify(j)).ok).toBe(false)
    const k = clone(AI_JSON) as any; k.headline = 'x'.repeat(200)
    expect(validateAI(JSON.stringify(k)).ok).toBe(false)
  })
  it('repairs then validates fenced output', () => {
    const r = validateAI('```json\n' + JSON.stringify(AI_JSON) + ',\n```')
    expect(r.ok && r.repaired).toBe(true)
  })
})

describe('convertAI', () => {
  const out = convertAI(VizAISchema.parse(AI_JSON), R, 'Mock · m1')
  it('architecture: layers become groups, components keep status, links reference components', () => {
    expect(out.key).toBe('k1'); expect(out.model).toBe('Mock · m1'); expect(out.risk).toBe('medium')
    const g = out.arch!
    expect(g.nodes.filter((n) => n.group).map((n) => n.label)).toEqual(['表现层', '接口层', '业务层', '数据层'])
    expect(g.nodes.find((n) => n.id === 'L:svc')?.status).toBe('added')
    expect(g.nodes.find((n) => n.id === 'L:data')?.status).toBe('modified')
    for (const e of g.edges) { expect(g.nodes.some((n) => n.id === e.source)).toBe(true); expect(g.nodes.some((n) => n.id === e.target)).toBe(true) }
  })
  it('sequence: participants merged, removed / added messages, alt frame kept', () => {
    const s = out.sequences[0]
    expect(s.source).toBe('ai'); expect(s.participants.map((p) => p.id)).toEqual(expect.arrayContaining(['u', 'api', 'repo', 'svc', 'w']))
    const flat = JSON.stringify(s.items)
    expect(flat).toContain('"removed"'); expect(flat).toContain('"added"'); expect(flat).toContain('状态校验')
  })
  it('state machine + business flow statuses', () => {
    const st = out.states[0]
    expect(st.status).toBe('modified')
    expect(st.graph.nodes.filter((n) => n.status === 'added').map((n) => n.label).sort()).toEqual(['cancelled', 'refunded'])
    expect(st.graph.nodes.some((n) => n.kind === 'initial')).toBe(true)
    const f = out.flows[0]
    expect(f.status).toBe('modified')
    expect(f.graph.nodes.find((n) => n.label === '是否取消?')).toMatchObject({ kind: 'decision', status: 'added' })
    expect(f.graph.nodes.find((n) => n.label === '支付')?.status).toBe('unchanged')
  })
  it('added-only diagrams', () => {
    const j = clone(AI_JSON) as any; j.states[0].before = null; j.flows[0].before = null
    const o = convertAI(VizAISchema.parse(j), R, 'm')
    expect(o.states[0].status).toBe('added'); expect(o.flows[0].status).toBe('added')
    expect(o.states[0].graph.nodes.every((n) => n.status === 'added')).toBe(true)
  })
})
