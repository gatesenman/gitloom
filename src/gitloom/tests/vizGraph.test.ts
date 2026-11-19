// renderer-side graph helpers + deterministic layouts for 变更可视化
import { describe, it, expect } from 'vitest'
import { sideOf, focusGraph, collapse, autoCluster, searchNodes, countStatus, toMermaid, toPlantUML, seqToMermaid, seqToPlantUML, seqSide, visibleOn, presentGraph } from '../src/renderer/src/lib/vizGraph'
import { layoutGraph, layoutBands, nodeSize, textWidth } from '../src/renderer/src/lib/vizLayout'
import type { DiffGraph, GNode, GEdge, DiffStatus, SeqDiagram } from '../src/shared/viz'

const n = (id: string, status: DiffStatus = 'unchanged', extra: Partial<GNode> = {}): GNode => ({ id, label: id, kind: 'file', status, ...extra })
const e = (s: string, t: string, status: DiffStatus = 'unchanged'): GEdge => ({ id: `${s}>${t}`, source: s, target: t, kind: 'import', status })
// chain a - b - c - d - e with c changed, plus a removed x and an added y
const G: DiffGraph = { nodes: [n('a'), n('b'), n('c', 'modified'), n('d'), n('e'), n('x', 'removed'), n('y', 'added')], edges: [e('a', 'b'), e('b', 'c'), e('c', 'd'), e('d', 'e'), e('a', 'x', 'removed'), e('a', 'y', 'added')] }

function big(dirs: number, per: number, changedDirs = 2): DiffGraph {
  const nodes: GNode[] = []; const edges: GEdge[] = []
  for (let d = 0; d < dirs; d++) {
    nodes.push(n(`d${d}`, 'unchanged', { group: true, kind: 'folder' }))
    for (let i = 0; i < per; i++) nodes.push(n(`d${d}/f${i}`, d < changedDirs && i === 0 ? 'modified' : 'unchanged', { parent: `d${d}` }))
    if (d) edges.push(e(`d${d}/f0`, `d${d - 1}/f1`))
  }
  return { nodes, edges }
}
const shuffle = <T>(xs: T[], seed: number): T[] => { const a = [...xs]; let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }

describe('vizGraph helpers', () => {
  it('sides: removed only before, added only after', () => {
    expect(visibleOn('added', 'before')).toBe(false); expect(visibleOn('removed', 'after')).toBe(false)
    expect(sideOf(G, 'before').nodes.map((x) => x.id)).not.toContain('y')
    expect(sideOf(G, 'after').nodes.map((x) => x.id)).not.toContain('x')
    expect(sideOf(G, 'after').edges.map((x) => x.id)).not.toContain('a>x')
  })
  it('focus: changed + N hops', () => {
    const ids = (g: DiffGraph) => g.nodes.map((x) => x.id).sort()
    expect(ids(focusGraph(G, 0))).toEqual(['c', 'x', 'y'])
    expect(ids(focusGraph(G, 1))).toEqual(['a', 'b', 'c', 'd', 'x', 'y'])
    expect(ids(focusGraph(G, 1, 'e'))).toEqual(['d', 'e'])
    const f = focusGraph(G, 1); for (const ed of f.edges) expect(ids(f)).toEqual(expect.arrayContaining([ed.source, ed.target]))
  })
  it('collapse: group → cluster leaf, edges redirected and deduped, status merged', () => {
    const g = big(3, 4)
    const c = collapse(g, 'd1')
    const cl = c.nodes.find((x) => x.id === 'd1')!
    expect(cl.kind).toBe('cluster'); expect(cl.count).toBe(4); expect(cl.status).toBe('modified')
    expect(c.nodes.some((x) => x.parent === 'd1')).toBe(false)
    expect(c.edges.every((x) => c.nodes.some((y) => y.id === x.source) && c.nodes.some((y) => y.id === x.target))).toBe(true)
    expect(c.edges.some((x) => x.source === 'd1' || x.target === 'd1')).toBe(true)
  })
  it('autoCluster: above the limit untouched folders collapse first; expanded groups stay open', () => {
    const g = big(40, 6)                     // 240 leaves
    const { graph, collapsed } = autoCluster(g, 150)
    expect(graph.nodes.filter((x) => !x.group).length).toBeLessThanOrEqual(150)
    expect(collapsed).not.toContain('d0'); expect(collapsed).not.toContain('d1')   // changed dirs survive pass 1
    expect(autoCluster(g, 150, new Set(['d39'])).collapsed).not.toContain('d39')
    expect(autoCluster(big(5, 5), 150).collapsed).toEqual([])
    expect(JSON.stringify(autoCluster(g, 150))).toBe(JSON.stringify(autoCluster(g, 150)))
  })
  it('search + counts', () => {
    expect(searchNodes(G, ' C ')).toEqual(['c']); expect(searchNodes(G, '')).toEqual([])
    expect(countStatus(G)).toEqual({ added: 1, removed: 1, modified: 1, moved: 0, unchanged: 4 })
  })
  it('Mermaid / PlantUML exports carry status classes and are deterministic', () => {
    const m = toMermaid(G)
    expect(m.startsWith('flowchart LR')).toBe(true); expect(m).toContain('classDef added'); expect(m).toMatch(/:::removed|class .* removed/)
    expect(toMermaid(G)).toBe(m)
    const st: DiffGraph = { nodes: [n('i', 'unchanged', { kind: 'initial', label: '' }), n('s1', 'unchanged', { kind: 'state' }), n('s2', 'added', { kind: 'state' })], edges: [{ ...e('i', 's1'), kind: 'transition' }, { ...e('s1', 's2', 'added'), kind: 'transition', label: 'go' }] }
    const ms = toMermaid(st, 'state'); expect(ms.startsWith('stateDiagram-v2')).toBe(true); expect(ms).toContain('[*]'); expect(ms).toContain('go')
    const pu = toPlantUML(st, 'state'); expect(pu.startsWith('@startuml')).toBe(true); expect(pu.trim().endsWith('@enduml')).toBe(true); expect(pu).toContain('[*]')
    const cls: DiffGraph = { nodes: [n('A', 'added', { kind: 'class', members: [{ name: 'x', kind: 'field', status: 'added' }] })], edges: [] }
    expect(toMermaid(cls, 'class').startsWith('classDiagram')).toBe(true)
    expect(toPlantUML(cls, 'class')).toContain('class')
    expect(toMermaid({ nodes: [n('a"b<c>')], edges: [] })).not.toMatch(/a"b/)
  })
  it('sequence exports + side filtering of frames', () => {
    const d: SeqDiagram = { id: 's', title: 't', status: 'modified', source: 'static', participants: [{ id: 'u', label: '用户', kind: 'actor', status: 'unchanged' }, { id: 'a', label: 'api', status: 'unchanged' }, { id: 'n', label: 'new', status: 'added' }],
      items: [{ t: 'msg', from: 'u', to: 'a', label: 'call()', status: 'unchanged' }, { t: 'frame', kind: 'alt', label: 'ok?', status: 'added', branches: [{ label: '是', items: [{ t: 'msg', from: 'a', to: 'n', label: 'go()', status: 'added' }] }] }, { t: 'msg', from: 'a', to: 'u', label: 'old()', status: 'removed' }] }
    const m = seqToMermaid(d); expect(m.startsWith('sequenceDiagram')).toBe(true); expect(m).toContain('actor'); expect(m).toContain('alt'); expect(m).toContain('end'); expect(m).toContain('--x')
    const p = seqToPlantUML(d); expect(p).toContain('@startuml'); expect(p).toContain('dashed')
    expect(seqSide(d.items, 'before').length).toBe(2); expect(seqSide(d.items, 'after').length).toBe(2)
    expect(seqSide(d.items, 'after').some((x) => x.t === 'frame')).toBe(true)
  })
})

describe('vizLayout', () => {
  it('node sizes grow with text and members (capped)', () => {
    expect(textWidth('中文标签')).toBeGreaterThan(textWidth('abcd'))
    expect(nodeSize(n('a-very-long-file-name-for-testing.ts')).w).toBeGreaterThan(nodeSize(n('a.ts')).w)
    const many = n('K', 'unchanged', { kind: 'class', members: Array.from({ length: 30 }, (_, i) => ({ name: 'm' + i, kind: 'method' as const, status: 'unchanged' as const })) })
    expect(nodeSize(many).h).toBeLessThan(400)
  })
  it('deterministic: same graph in any input order → identical boxes', async () => {
    const g = big(6, 5)
    const a = await layoutGraph(g, 'modules')
    const b = await layoutGraph({ nodes: shuffle(g.nodes, 7), edges: shuffle(g.edges, 3) }, 'modules')
    expect(b).toEqual(a)
    for (const x of g.nodes) expect(a.boxes[x.id], x.id).toBeTruthy()
  })
  it('every kind lays out; children sit inside their parent', async () => {
    for (const k of ['modules', 'calls', 'classes', 'flow', 'state', 'impact'] as const) {
      const g = big(3, 3)
      const L = await layoutGraph(g, k)
      expect(L.width, k).toBeGreaterThan(0)
      const p = L.boxes.d1, c = L.boxes['d1/f1']
      // ELK child coordinates are relative to the parent
      expect(c.x + c.w, k).toBeLessThanOrEqual(p.w + 1); expect(c.y + c.h, k).toBeLessThanOrEqual(p.h + 1)
    }
  })
  it('orientation adapts to very wide graphs (no 6:1 strips)', async () => {
    const nodes = Array.from({ length: 14 }, (_, i) => n('c' + i)); const edges = nodes.slice(1).map((x, i) => e(nodes[i].id, x.id))
    const L = await layoutGraph({ nodes, edges }, 'state')
    expect(Math.max(L.width / L.height, L.height / L.width)).toBeLessThan(12)
    expect(L.dir).toBe('DOWN')
  })
  it('architecture bands: layer order top → bottom, deterministic', () => {
    const g: DiffGraph = { nodes: [
      n('L:infra', 'unchanged', { group: true, kind: 'layer', label: '基础层' }), n('L:ui', 'unchanged', { group: true, kind: 'layer', label: '表现层' }), n('L:svc', 'added', { group: true, kind: 'layer', label: '业务层' }),
      n('util', 'unchanged', { parent: 'L:infra', kind: 'component' }), n('ui', 'modified', { parent: 'L:ui', kind: 'component' }), n('svc', 'added', { parent: 'L:svc', kind: 'component' })], edges: [e('ui', 'svc'), e('svc', 'util')] }
    const L = layoutBands(g)
    expect(L.boxes['L:ui'].y).toBeLessThan(L.boxes['L:svc'].y); expect(L.boxes['L:svc'].y).toBeLessThan(L.boxes['L:infra'].y)
    expect(layoutBands({ nodes: [...g.nodes].reverse(), edges: g.edges })).toEqual(L)
  })
})

describe('presentGraph (架构与知识 HEAD-only)', () => {
  it('keeps after-side nodes and clears diff status', () => {
    const g: DiffGraph = {
      nodes: [
        n('a'), n('b', 'added'), n('c', 'removed')
      ],
      edges: [
        e('a', 'b', 'added'), e('a', 'c', 'removed')
      ]
    }
    const p = presentGraph(g)
    expect(p.nodes.map((x) => x.id).sort()).toEqual(sideOf(g, 'after').nodes.map((x) => x.id).sort())
    expect(p.nodes.every((x) => x.status === 'unchanged')).toBe(true)
    expect(p.edges.every((x) => x.status === 'unchanged')).toBe(true)
    expect(p.nodes.map((x) => x.id)).not.toContain('c')
  })
})
