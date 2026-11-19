// VizService end-to-end on real git fixtures: scopes, diff views, flows (CFG), sequences, state machines, impact,
// parse cache, cancellation, AI enrichment (schema retry once, cache, single-flight), patches / snippets.
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { VizService, type VizChat } from '../src/main/viz/service'
import { localDeps } from '../src/main/viz/local'
// @ts-expect-error plain .mjs fixture builder shared with the e2e
import { makeTsService, makePy, makeJava } from '../scripts/viz-fixtures.mjs'
import type { VizResult, DiffGraph } from '../src/shared/viz'
import { AI_JSON } from './fixtures/vizAi'

const root = mkdtempSync(join(tmpdir(), 'viz-svc-'))
let TS = '', PY = '', JAVA = ''
const deps = localDeps('node_modules/tree-sitter-wasms/out', 'node_modules/web-tree-sitter/tree-sitter.wasm')
let parsed = 0
const svc = new VizService({ ...deps, parseMany: async (items, p) => { parsed += items.length; return deps.parseMany(items, p) } })
const leaf = (g: DiffGraph, label: string) => g.nodes.find((n) => !n.group && n.label === label)
let head: VizResult

beforeAll(async () => {
  TS = makeTsService(join(root, 'ts')); PY = makePy(join(root, 'py')); JAVA = makeJava(join(root, 'java'))
  head = await svc.analyze({ repo: TS, scope: { kind: 'commit', sha: 'HEAD' } })
}, 120000)

describe('VizService on fixtures', () => {
  it('commit scope: summary counts match the refactor', () => {
    expect(head.summary.files).toMatchObject({ added: 5, removed: 1, modified: 4 })
    expect(head.summary.states.modified).toBe(1)
    expect(head.stats.langs).toMatchObject({ typescript: 9, tsx: 1 })
  })
  it('modules: added service file, removed repo file, edges carry status', () => {
    const m = head.modules
    expect(m.nodes.find((n) => n.id.includes('orderService.ts'))?.status).toBe('added')
    expect(m.nodes.find((n) => n.id.includes('orderRepo.ts'))?.status).toBe('removed')
    expect(m.edges.some((e) => e.status === 'added')).toBe(true); expect(m.edges.some((e) => e.status === 'removed')).toBe(true)
    for (const e of m.edges) { expect(m.nodes.some((n) => n.id === e.source)).toBe(true); expect(m.nodes.some((n) => n.id === e.target)).toBe(true) }
  })
  it('architecture: directory layers with a new 业务层', () => {
    const svcLayer = head.arch.nodes.find((n) => n.group && n.label === '业务层')
    expect(svcLayer?.status).toBe('added')
    expect(leaf(head.arch, 'ui')?.parent).toBe('L:ui')
    expect(leaf(head.arch, 'util')?.parent).toBe('L:infra')
  })
  it('calls + classes', () => {
    expect(head.calls.nodes.some((n) => n.label.includes('OrderService') || n.id.includes('OrderService'))).toBe(true)
    const svcCls = head.classes.nodes.find((n) => n.label === 'OrderService')
    expect(svcCls?.status).toBe('added'); expect(svcCls?.members?.length).toBeGreaterThan(3)
    expect(head.classes.nodes.find((n) => n.label === 'Order')?.members?.some((m) => m.status === 'added')).toBe(true)
  })
  it('state machine: cancelled / refunded added with event labels from literals', () => {
    const st = head.states.find((s) => s.name === 'OrderStatus')!
    expect(st.status).toBe('modified')
    const added = st.graph.nodes.filter((n) => n.status === 'added').map((n) => n.label).sort()
    expect(added).toEqual(['cancelled', 'refunded'])
    expect(st.graph.edges.filter((e) => e.status === 'added').map((e) => e.label).sort()).toEqual(['cancel', 'refund'])
    expect(head.states.some((s) => s.name === 'OrderEvent')).toBe(false)
  })
  it('flows (CFG) + sequences', () => {
    const f = head.flows.find((x) => x.label === 'reduce')!
    expect(f.status).toBe('modified'); expect(f.graph.nodes.some((n) => n.kind === 'decision' || n.kind === 'start')).toBe(true)
    expect(head.flows.find((x) => x.label === 'OrderService.cancel')?.status).toBe('added')
    const s = head.sequences.find((x) => x.title.startsWith('payOrder'))!
    expect(s.status).toBe('modified'); expect(s.participants.length).toBeGreaterThan(2)
  })
  it('impact: changed nodes are distance 0 and edges survive', () => {
    expect(head.impact.nodes.some((n) => n.dist === 0)).toBe(true)
    expect(head.impact.edges.length).toBeGreaterThan(0)
  })
  it('range / refs / working / path filter scopes', async () => {
    const range = await svc.analyze({ repo: TS, scope: { kind: 'range', from: 'HEAD~1', to: 'HEAD' } })
    expect(range.summary.files).toEqual(head.summary.files)
    const refs = await svc.analyze({ repo: TS, scope: { kind: 'refs', base: 'main', head: 'refactor/service-layer' } })
    expect(refs.summary.files.added).toBeGreaterThanOrEqual(5) // merge-base diff: main's README commit is not part of it
    const work = await svc.analyze({ repo: TS, scope: { kind: 'working' } })
    expect(work.files.map((f) => f.path)).toEqual(['src/util/log.ts'])
    const filt = await svc.analyze({ repo: TS, scope: { kind: 'commit', sha: 'HEAD' }, filter: 'src/services' })
    expect(filt.files.every((f) => f.path.startsWith('src/services/'))).toBe(true)
  })
  it('parse cache: re-analysing parses nothing new', async () => {
    const n0 = parsed
    const again = await svc.analyze({ repo: TS, scope: { kind: 'commit', sha: 'HEAD' } })
    expect(parsed).toBe(n0); expect(again.key).toBe(head.key); expect(again.stats.cached).toBeGreaterThan(0)
  })
  it('cancellation rejects with an abort', async () => {
    const c = new AbortController(); c.abort()
    await expect(svc.analyze({ repo: PY, scope: { kind: 'commit', sha: 'HEAD' } }, undefined, c.signal)).rejects.toThrow()
  })
  it('Python + Java fixtures', async () => {
    const py = await svc.analyze({ repo: PY, scope: { kind: 'commit', sha: 'HEAD' } })
    expect(py.classes.nodes.find((n) => n.label === 'Admin')?.status).toBe('added')
    expect(py.states.some((s) => s.graph.nodes.some((n) => n.label === 'DELETED' && n.status === 'added'))).toBe(true)
    expect(py.arch.nodes.filter((n) => !n.group).length).toBeGreaterThan(1)
    const java = await svc.analyze({ repo: JAVA, scope: { kind: 'commit', sha: 'HEAD' } })
    expect(java.classes.nodes.find((n) => n.label === 'PaymentGateway')?.status).toBe('added')
    expect(java.classes.edges.some((e) => e.kind === 'implements' || e.kind === 'extends')).toBe(true)
  })
  it('patch + snippet for the side panel (incl. untracked files)', async () => {
    head = await svc.analyze({ repo: TS, scope: { kind: 'commit', sha: 'HEAD' } })
    const patch = await svc.patch(head.id, 'src/services/orderService.ts')
    expect(patch).toContain('+export class OrderService')
    const sn = await svc.snippet(head.id, { after: { file: 'src/services/orderService.ts', line: 1, endLine: 6 } })
    expect(sn.lines.length).toBeGreaterThan(2)
    writeFileSync(join(TS, 'src/new.ts'), 'export const x = 1\n')
    const w = await svc.analyze({ repo: TS, scope: { kind: 'working' } })
    expect(w.files.map((f) => f.path)).toContain('src/new.ts')
    expect(await svc.patch(w.id, 'src/new.ts')).toContain('+export const x = 1')
  })
})

describe('VizService AI enrichment', () => {
  beforeAll(async () => { head = await svc.analyze({ repo: TS, scope: { kind: 'commit', sha: 'HEAD' } }) })
  const answer = JSON.stringify(AI_JSON)
  const broken = (() => { const b = JSON.parse(answer); b.sequences[0].after.steps.push({ type: 'msg', from: 'ghost', to: 'api', label: 'x' }); return '```json\n' + JSON.stringify(b) + '\n```' })()
  it('invalid first answer → exactly one retry with the validation errors, then cached', async () => {
    const msgs: string[][] = []
    const chat: VizChat = async (m) => { msgs.push(m.map((x) => x.content)); return msgs.length === 1 ? broken : answer }
    const r = await svc.ai(head.id, 'mock', chat)
    expect(msgs.length).toBe(2); expect(msgs[1].join('\n')).toContain('ghost'); expect(r.attempts).toBe(2)
    expect(r.headline).toBe(AI_JSON.headline)
    expect(r.arch?.nodes.find((n) => n.id === 'a:svc')?.status).toBe('added')
    expect(r.states[0].graph.nodes.filter((n) => n.status === 'added').map((n) => n.label).sort()).toEqual(['cancelled', 'refunded'])
    expect(r.sequences[0].items.length).toBeGreaterThan(1)
    expect(svc.aiCached(head.id, 'mock')).toBeTruthy()
    const again = await svc.ai(head.id, 'mock', async () => { throw new Error('must not be called') })
    expect(again.cached).toBe(true)
  })
  it('two invalid answers → error, nothing cached', async () => {
    let n = 0
    await expect(svc.ai(head.id, 'other', async () => { n++; return 'sorry, no JSON' })).rejects.toThrow()
    expect(n).toBe(2); expect(svc.aiCached(head.id, 'other')).toBeFalsy()
  })
  it('single-flight: concurrent requests share one model call', async () => {
    let n = 0
    const chat: VizChat = async () => { n++; await new Promise((r) => setTimeout(r, 50)); return answer }
    const [a, b] = await Promise.all([svc.ai(head.id, 'sf', chat), svc.ai(head.id, 'sf', chat)])
    expect(n).toBe(1); expect(a.headline).toBe(b.headline)
  })
  it('abort signal cancels the AI call', async () => {
    const c = new AbortController()
    const p = svc.ai(head.id, 'abort', (_m, sig) => new Promise((_ok, bad) => sig?.addEventListener('abort', () => bad(Object.assign(new Error('aborted'), { name: 'AbortError' })))), c.signal)
    setTimeout(() => c.abort(), 20)
    await expect(p).rejects.toThrow(); expect(svc.aiCached(head.id, 'abort')).toBeFalsy()
  })
})
