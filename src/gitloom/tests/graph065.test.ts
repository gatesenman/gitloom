import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import type { FileFacts, FnFact } from '../src/main/viz/facts'
import { buildGraphFromFacts, searchNodes, neighborsOf, blastRadius } from '../src/main/graph/build'
import { saveGraph, loadGraph, graphStatus, search, neighbors, blast } from '../src/main/graph/store'

const fn = (name: string, over: Partial<FnFact> = {}): FnFact => ({
  name, line: over.line ?? 1, endLine: over.endLine ?? 5, sig: over.sig ?? name,
  params: '', calls: over.calls ?? [], flow: [], size: over.size ?? 5, owner: over.owner
})

const ff = (p: string, over: Partial<FileFacts> = {}): FileFacts => ({
  path: p, lang: 'typescript', hash: over.hash ?? 'abc', lines: 20,
  imports: over.imports ?? [], decls: over.decls ?? [], fns: over.fns ?? [],
  states: [], routes: [], events: [], idents: over.idents ?? [], shallow: over.shallow
})

describe('0.6.5 knowledge graph', () => {
  let userData: string
  let projectRoot: string
  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'gl-graph-ud-'))
    projectRoot = mkdtempSync(path.join(tmpdir(), 'gl-graph-proj-'))
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('buildGraphFromFacts creates File/Module/Symbol + CONTAINS/DEFINES', () => {
    const facts = [
      ff('src/a.ts', {
        imports: [{ spec: './b', names: ['helper'], line: 1 }],
        fns: [fn('main', { calls: [{ name: 'helper', line: 3 }] })],
        decls: [{ name: 'A', kind: 'class', line: 5, endLine: 10, ext: [], impl: [], members: [], sig: 'A', uses: [] }]
      }),
      ff('src/b.ts', {
        fns: [fn('helper')],
        decls: []
      })
    ]
    const g = buildGraphFromFacts({ projectId: 'p1', repo: '/r', facts, sampleCap: 100 })
    expect(g.nodes.some((n) => n.kind === 'file' && n.path === 'src/a.ts')).toBe(true)
    expect(g.nodes.some((n) => n.kind === 'module')).toBe(true)
    expect(g.nodes.some((n) => n.kind === 'symbol' && n.label.includes('helper'))).toBe(true)
    expect(g.edges.some((e) => e.kind === 'CONTAINS')).toBe(true)
    expect(g.edges.some((e) => e.kind === 'DEFINES')).toBe(true)
    expect(g.meta.nodeCount).toBe(g.nodes.length)
    expect(g.meta.edgeCount).toBe(g.edges.length)
  })

  it('wiki pages become Wiki nodes with MENTIONS', () => {
    const g = buildGraphFromFacts({
      projectId: 'p1',
      facts: [ff('src/x.ts', { fns: [fn('run')] })],
      wikiPages: [{ path: 'pages/intro.md', title: 'Intro', content: 'see src/x.ts and run()' }]
    })
    expect(g.nodes.some((n) => n.kind === 'wiki')).toBe(true)
    expect(g.edges.some((e) => e.kind === 'MENTIONS')).toBe(true)
  })

  it('save/load + store search/neighbors/blast round-trip', async () => {
    const g = buildGraphFromFacts({
      projectId: 'p1',
      facts: [
        ff('m/foo.ts', { fns: [fn('alpha'), fn('beta', { calls: [{ name: 'alpha', line: 2 }] })] })
      ]
    })
    await saveGraph(projectRoot, userData, g)
    const st = await graphStatus(projectRoot, userData)
    expect(st.exists).toBe(true)
    expect(st.meta?.nodeCount).toBeGreaterThan(0)
    const loaded = await loadGraph(projectRoot, userData)
    expect(loaded!.nodes.length).toBe(g.nodes.length)

    const pureHits = searchNodes(loaded!, 'alpha')
    expect(pureHits.length).toBeGreaterThan(0)
    const center = pureHits[0].node
    expect(neighborsOf(loaded!, center.id).length).toBeGreaterThan(0)
    expect(blastRadius(loaded!, center.id, { maxDepth: 2, cap: 20 }).ids.length).toBeGreaterThanOrEqual(0)

    const hits = await search(projectRoot, userData, 'alpha')
    expect(hits.length).toBeGreaterThan(0)
    const nb = await neighbors(projectRoot, userData, center.id)
    expect(Array.isArray(nb)).toBe(true)
    const br = await blast(projectRoot, userData, center.id, { maxDepth: 2, cap: 20 })
    expect(Array.isArray(br.nodes)).toBe(true)
  })
})
