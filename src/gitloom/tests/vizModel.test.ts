// smaller building blocks: architecture layer inference, control-flow graphs + their diff, sequence item merge
import { describe, it, expect } from 'vitest'
import { componentOf, layerOf } from '../src/main/viz/diff'
import { buildCfg, diffCfg, cfgChanged } from '../src/main/viz/cfg'
import { mergeItems } from '../src/main/viz/seq'
import type { FlowStep } from '../src/main/viz/facts'
import type { SeqItem } from '../src/shared/viz'

describe('architecture inference', () => {
  it('component from path (src/, maven roots, com.* packages)', () => {
    expect(componentOf('src/api/orders.ts', new Set())).toBe('api')
    expect(componentOf('src/main/java/com/shop/svc/Pay.java', new Set())).toBe('svc')
    expect(componentOf('index.ts', new Set())).toBe('(根目录)')
    expect(componentOf('src/renderer/lib/x.ts', new Set(['renderer']))).toBe('renderer/lib')
  })
  it('layers by folder name, last segment first, loose words for flat projects', () => {
    expect(layerOf('ui')).toBe('ui'); expect(layerOf('api')).toBe('api'); expect(layerOf('services')).toBe('svc')
    expect(layerOf('db')).toBe('data'); expect(layerOf('util')).toBe('infra'); expect(layerOf('tests')).toBe('test')
    expect(layerOf('renderer/lib')).toBe('infra')
    expect(layerOf('PaymentGateway')).toBe('svc'); expect(layerOf('OrderController')).toBe('api'); expect(layerOf('zzz')).toBe('other')
  })
})

const S = (text: string, line: number): FlowStep => ({ t: 'stmt', text, line })
describe('control-flow graphs', () => {
  const v1: FlowStep[] = [S('const o = find(id)', 1), { t: 'if', line: 2, branches: [{ label: '!o', body: [{ t: 'throw', text: 'new Error()', line: 3 }] }] }, { t: 'return', text: 'o', line: 4 }]
  const v2: FlowStep[] = [S('const o = find(id)', 1), { t: 'if', line: 2, branches: [{ label: '!o', body: [{ t: 'throw', text: 'new Error()', line: 3 }] }] },
    { t: 'try', line: 4, body: [S('save(o)', 5)], catches: [{ label: 'catch (e)', body: [S('log(e)', 6)] }] }, { t: 'return', text: 'o', line: 7 }]
  it('buildCfg has start/end, a decision and labelled branch edges', () => {
    const c = buildCfg(v1, 'get')
    expect(c.nodes.some((n) => n.kind === 'start')).toBe(true); expect(c.nodes.some((n) => n.kind === 'end')).toBe(true)
    expect(c.nodes.some((n) => n.kind === 'decision')).toBe(true)
    expect(c.edges.some((e) => e.label)).toBe(true)
  })
  it('diffCfg marks the added try/catch; identical flows are unchanged', () => {
    const d = diffCfg(buildCfg(v1, 'get'), buildCfg(v2, 'get'))
    expect(cfgChanged(d)).toBe(true)
    expect(d.nodes.filter((n) => n.status === 'added').map((n) => n.label).join(' ')).toContain('save(o)')
    expect(d.nodes.find((n) => n.label.includes('find(id)'))?.status).toBe('unchanged')
    expect(cfgChanged(diffCfg(buildCfg(v1, 'get'), buildCfg(v1, 'get')))).toBe(false)
    expect(diffCfg(null, buildCfg(v1, 'get')).nodes.every((n) => n.status === 'added')).toBe(true)
  })
  it('loops get a back edge', () => {
    const c = buildCfg([{ t: 'loop', label: 'for x of xs', line: 1, body: [S('t += x', 2)] }], 'sum')
    expect(c.edges.some((e) => e.back)).toBe(true)
  })
})

describe('sequence merge', () => {
  const m = (from: string, to: string, label: string): SeqItem => ({ t: 'msg', from, to, label, status: 'unchanged' })
  it('LCS alignment: kept, removed and added messages in order', () => {
    const out = mergeItems([m('a', 'b', 'x()'), m('b', 'c', 'old()'), m('a', 'd', 'z()')], [m('a', 'b', 'x()'), m('b', 'e', 'new()'), m('a', 'd', 'z()')])
    expect(out.map((i) => (i.t === 'msg' ? `${i.label}:${i.status}` : ''))).toEqual(['x():unchanged', 'old():removed', 'new():added', 'z():unchanged'])
  })
})
