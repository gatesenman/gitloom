import { describe, it, expect } from 'vitest'
import {
  knowledgeToMermaid, knowledgeToDot, knowledgeToStructurizr,
  archToDot, archToStructurizr, exportFilename, type KgGraph
} from '../src/renderer/src/lib/knowledgeExport'
import type { DiffGraph } from '../src/shared/viz'

const kg: KgGraph = {
  nodes: [
    { id: 'file:src/a.ts', kind: 'file', label: 'a.ts', path: 'src/a.ts' },
    { id: 'module:src', kind: 'module', label: 'src', path: 'src' },
    { id: 'sym:helper', kind: 'symbol', label: 'helper', path: 'src/a.ts', symbolKind: 'function' }
  ],
  edges: [
    { id: 'e1', from: 'module:src', to: 'file:src/a.ts', kind: 'CONTAINS', confidence: 'exact' },
    { id: 'e2', from: 'file:src/a.ts', to: 'sym:helper', kind: 'DEFINES', confidence: 'exact' }
  ]
}

describe('knowledge export', () => {
  it('Mermaid flowchart with Chinese comment and kinds', () => {
    const m = knowledgeToMermaid(kg)
    expect(m).toContain('flowchart LR')
    expect(m).toContain('知识图谱')
    expect(m).toContain('helper')
    expect(m).toContain('CONTAINS')
    expect(m).toMatch(/classDef file/)
  })

  it('DOT digraph', () => {
    const d = knowledgeToDot(kg)
    expect(d).toContain('digraph GitLoomKnowledge')
    expect(d).toContain('->')
    expect(d).toContain('helper')
  })

  it('Structurizr DSL workspace', () => {
    const s = knowledgeToStructurizr(kg, 'Demo')
    expect(s).toContain('workspace "Demo"')
    expect(s).toContain('softwareSystem')
    expect(s).toContain('container')
  })

  it('exportFilename extensions', () => {
    expect(exportFilename('g', 'mermaid')).toBe('g.mmd')
    expect(exportFilename('g', 'dot')).toBe('g.dot')
    expect(exportFilename('g', 'dsl')).toBe('g.dsl')
  })
})

describe('arch export', () => {
  const arch: DiffGraph = {
    nodes: [
      { id: 'layer:ui', label: 'UI', kind: 'layer', status: 'unchanged', group: true },
      { id: 'c:a', label: 'A', kind: 'component', status: 'unchanged', parent: 'layer:ui', after: { file: 'a.ts', line: 1 } },
      { id: 'c:b', label: 'B', kind: 'component', status: 'unchanged', parent: 'layer:ui', after: { file: 'b.ts', line: 1 } }
    ],
    edges: [
      { id: 'e', source: 'c:a', target: 'c:b', kind: 'depends', status: 'unchanged', label: 'uses' }
    ]
  }

  it('DOT skips group nodes', () => {
    const d = archToDot(arch)
    expect(d).toContain('digraph GitLoomArch')
    expect(d).toContain('A')
    expect(d).not.toMatch(/label="UI"/)
  })

  it('Structurizr maps layers to containers', () => {
    const s = archToStructurizr(arch, 'App')
    expect(s).toContain('softwareSystem "App"')
    expect(s).toContain('container "UI"')
    expect(s).toContain('component "A"')
  })
})
