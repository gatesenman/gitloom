import { describe, it, expect } from 'vitest'
import type { GraphData, GraphNode } from '../src/main/graph/types'
import {
  detectStaleNodes, detectArchStale, filterByStale, textHasSymbol, symbolNameOf,
  staleEvidenceFiles, isNodeStale, type StaleChecks
} from '../src/main/graph/stale'

const node = (over: Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind' | 'label'>): GraphNode => ({
  id: over.id, kind: over.kind, label: over.label,
  path: over.path, line: over.line, endLine: over.endLine, symbolKind: over.symbolKind, lang: over.lang
})

const emptyMeta = {
  projectId: 'p', builtAt: 1, fileCount: 0, nodeCount: 0, edgeCount: 0, sampleCap: 100, truncated: false
}

function graph(nodes: GraphNode[]): GraphData {
  return {
    version: 1,
    nodes,
    edges: [],
    fileHashes: {},
    meta: { ...emptyMeta, nodeCount: nodes.length }
  }
}

describe('symbolNameOf / textHasSymbol', () => {
  it('takes last segment of dotted label', () => {
    expect(symbolNameOf('Foo.bar')).toBe('bar')
    expect(symbolNameOf('helper')).toBe('helper')
  })

  it('finds common declarations', () => {
    expect(textHasSymbol('export function helper() {}', 'helper')).toBe(true)
    expect(textHasSymbol('class Foo {}\n', 'Foo')).toBe(true)
    expect(textHasSymbol('const bar = 1', 'bar')).toBe(true)
    expect(textHasSymbol('def run():\n  pass\n', 'run')).toBe(true)
    expect(textHasSymbol('fn compute() {}', 'compute')).toBe(true)
  })

  it('marks missing symbol as absent', () => {
    expect(textHasSymbol('export function other() {}', 'helper')).toBe(false)
  })

  it('does not stale non-identifier labels', () => {
    expect(textHasSymbol('anything', 'a-b')).toBe(true)
  })
})

describe('detectStaleNodes', () => {
  const checks = (exist: Set<string>, symbols?: Set<string>): StaleChecks => ({
    pathExists: (p) => exist.has(p),
    symbolExists: symbols
      ? (p, label) => exist.has(p) && symbols.has(`${p}::${label}`)
      : undefined,
    wikiExists: (p) => exist.has('wiki:' + p)
  })

  it('marks missing file / dir / wiki', () => {
    const g = graph([
      node({ id: 'f1', kind: 'file', label: 'a.ts', path: 'src/a.ts' }),
      node({ id: 'f2', kind: 'file', label: 'gone.ts', path: 'src/gone.ts' }),
      node({ id: 'm1', kind: 'module', label: 'src', path: 'src' }),
      node({ id: 'm2', kind: 'module', label: 'old', path: 'old' }),
      node({ id: 'w1', kind: 'wiki', label: 'Intro', path: 'pages/intro.md' }),
      node({ id: 'w2', kind: 'wiki', label: 'Lost', path: 'pages/lost.md' })
    ])
    const r = detectStaleNodes(g, checks(new Set(['src/a.ts', 'src', 'wiki:pages/intro.md'])))
    expect(r.staleIds.sort()).toEqual(['f2', 'm2', 'w2'].sort())
    expect(r.hits.find((h) => h.id === 'f2')?.reason).toBe('missing-path')
    expect(r.hits.find((h) => h.id === 'm2')?.reason).toBe('missing-dir')
    expect(r.hits.find((h) => h.id === 'w2')?.reason).toBe('missing-wiki')
  })

  it('marks symbol when path gone or symbolExists false', () => {
    const g = graph([
      node({ id: 's1', kind: 'symbol', label: 'helper', path: 'src/a.ts' }),
      node({ id: 's2', kind: 'symbol', label: 'ghost', path: 'src/a.ts' }),
      node({ id: 's3', kind: 'symbol', label: 'x', path: 'missing.ts' })
    ])
    const r = detectStaleNodes(
      g,
      checks(new Set(['src/a.ts']), new Set(['src/a.ts::helper']))
    )
    expect(r.staleIds.sort()).toEqual(['s2', 's3'].sort())
    expect(r.hits.find((h) => h.id === 's2')?.reason).toBe('missing-symbol')
    expect(r.hits.find((h) => h.id === 's3')?.reason).toBe('missing-path')
  })

  it('skips module path "." and wiki without wikiExists', () => {
    const g = graph([
      node({ id: 'm', kind: 'module', label: 'root', path: '.' }),
      node({ id: 'w', kind: 'wiki', label: 'W', path: 'x.md' })
    ])
    const r = detectStaleNodes(g, { pathExists: () => false })
    expect(r.staleIds).toEqual([])
  })
})

describe('isNodeStale / filterByStale', () => {
  it('file without path is missing-path', () => {
    expect(isNodeStale(node({ id: 'f', kind: 'file', label: 'x' }), { pathExists: () => true })).toBe('missing-path')
  })

  it('filterByStale keeps only stale or fresh', () => {
    const g = graph([
      node({ id: 'a', kind: 'file', label: 'a', path: 'a.ts' }),
      node({ id: 'b', kind: 'file', label: 'b', path: 'b.ts' })
    ])
    g.edges = [
      { id: 'e1', from: 'a', to: 'b', kind: 'IMPORTS', confidence: 'exact' },
      { id: 'e2', from: 'b', to: 'a', kind: 'CALLS', confidence: 'exact' }
    ]
    const stale = filterByStale(g, new Set(['a']), 'stale')
    expect(stale.nodes.map((n) => n.id)).toEqual(['a'])
    expect(stale.edges).toEqual([])
    const fresh = filterByStale(g, new Set(['a']), 'fresh')
    expect(fresh.nodes.map((n) => n.id)).toEqual(['b'])
    expect(filterByStale(g, new Set(['a']), 'all').nodes.length).toBe(2)
  })
})

describe('detectArchStale / staleEvidenceFiles', () => {
  it('marks arch nodes whose after.file is gone', () => {
    const r = detectArchStale(
      [
        { id: 'n1', label: 'A', after: { file: 'src/a.ts' } },
        { id: 'n2', label: 'B', after: { file: 'gone.ts' } },
        { id: 'n3', label: 'Layer' } // no file → never stale
      ],
      (p) => p === 'src/a.ts'
    )
    expect(r.staleIds).toEqual(['n2'])
    expect(r.hits[0].reason).toBe('missing-path')
  })

  it('filters missing evidence files', () => {
    const miss = staleEvidenceFiles(
      [{ file: 'ok.ts' }, { file: 'nope.ts', line: 3 }],
      (p) => p === 'ok.ts'
    )
    expect(miss).toEqual([{ file: 'nope.ts', line: 3 }])
  })
})
