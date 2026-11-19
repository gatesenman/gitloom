/**
 * Export knowledge-graph / architecture graphs as Mermaid (required), DOT, Structurizr DSL.
 * Pure string builders — no DOM. Used by 架构与知识 toolbars.
 */
import type { DiffGraph, GNode, GEdge } from '@shared/viz'

export type KgNode = {
  id: string
  kind: string
  label: string
  path?: string
  symbolKind?: string
}
export type KgEdge = { id: string; from: string; to: string; kind: string; confidence?: string }
export type KgGraph = { nodes: KgNode[]; edges: KgEdge[]; meta?: { projectId?: string; repo?: string } }

const q = (s: string) => s.replace(/"/g, "'").replace(/[\n\r]+/g, ' ').replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'))
const mid = (id: string, ids: Map<string, string>) => {
  let v = ids.get(id)
  if (!v) { v = `n${ids.size}`; ids.set(id, v) }
  return v
}
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').slice(0, 64) || 'n'

const MERMAID_KIND: Record<string, string> = {
  file: '([',
  module: '[[',
  symbol: '[',
  wiki: '(['
}
const MERMAID_KIND_CLOSE: Record<string, string> = {
  file: '])',
  module: ']]',
  symbol: ']',
  wiki: '])'
}

export function knowledgeToMermaid(g: KgGraph, dir: 'LR' | 'TD' = 'LR'): string {
  const ids = new Map<string, string>()
  const out = [`flowchart ${dir}`, '  %% GitLoom 知识图谱']
  for (const n of g.nodes) {
    const id = mid(n.id, ids)
    const open = MERMAID_KIND[n.kind] ?? '['
    const close = MERMAID_KIND_CLOSE[n.kind] ?? ']'
    const lab = q(n.label) + (n.kind === 'symbol' && n.symbolKind ? ` «${n.symbolKind}»` : '')
    out.push(`  ${id}${open}"${lab}"${close}`)
    out.push(`  class ${id} ${n.kind}`)
  }
  for (const e of g.edges) {
    const a = mid(e.from, ids)
    const b = mid(e.to, ids)
    const lab = e.kind + (e.confidence && e.confidence !== 'exact' ? `·${e.confidence}` : '')
    out.push(`  ${a} -->|${q(lab)}| ${b}`)
  }
  out.push(
    '  classDef file fill:#dbeafe,stroke:#2563eb,color:#1e3a8a',
    '  classDef module fill:#f3e8ff,stroke:#7c3aed,color:#4c1d95',
    '  classDef symbol fill:#dcfce7,stroke:#16a34a,color:#14532d',
    '  classDef wiki fill:#fef3c7,stroke:#d97706,color:#78350f'
  )
  return out.join('\n')
}

export function knowledgeToDot(g: KgGraph): string {
  const ids = new Map<string, string>()
  const out = [
    'digraph GitLoomKnowledge {',
    '  rankdir=LR;',
    '  node [fontname="Microsoft YaHei", fontsize=11];',
    '  edge [fontname="Microsoft YaHei", fontsize=9];'
  ]
  for (const n of g.nodes) {
    const id = mid(n.id, ids)
    const shape = n.kind === 'module' ? 'folder' : n.kind === 'symbol' ? 'ellipse' : n.kind === 'wiki' ? 'note' : 'box'
    out.push(`  ${id} [label="${q(n.label)}", shape=${shape}, tooltip="${q(n.path || n.id)}"];`)
  }
  for (const e of g.edges) {
    out.push(`  ${mid(e.from, ids)} -> ${mid(e.to, ids)} [label="${q(e.kind)}"];`)
  }
  out.push('}')
  return out.join('\n')
}

/** Minimal Structurizr DSL: modules → containers, files → components. */
export function knowledgeToStructurizr(g: KgGraph, workspaceName = 'GitLoom'): string {
  const mods = g.nodes.filter((n) => n.kind === 'module')
  const files = g.nodes.filter((n) => n.kind === 'file')
  const imports = g.edges.filter((e) => e.kind === 'IMPORTS' || e.kind === 'CONTAINS')
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const out = [
    `workspace "${q(workspaceName)}" {`,
    '  model {',
    '    softwaresystem = softwareSystem "Application" {'
  ]
  for (const m of mods.slice(0, 40)) {
    out.push(`      ${safeId(m.id)} = container "${q(m.label)}" {`)
    for (const f of files.filter((f) => f.path?.startsWith((m.path || '') + '/') || (m.path === '.' && f.path && !f.path.includes('/')))) {
      out.push(`        ${safeId(f.id)} = component "${q(f.label)}"`)
    }
    out.push('      }')
  }
  // orphan files as components under a default container
  const covered = new Set(files.filter((f) => mods.some((m) => f.path?.startsWith((m.path || '') + '/') || (m.path === '.' && f.path && !f.path.includes('/')))).map((f) => f.id))
  const orphans = files.filter((f) => !covered.has(f.id)).slice(0, 30)
  if (orphans.length) {
    out.push('      default = container "其他" {')
    for (const f of orphans) out.push(`        ${safeId(f.id)} = component "${q(f.label)}"`)
    out.push('      }')
  }
  out.push('    }')
  for (const e of imports.slice(0, 80)) {
    const a = byId.get(e.from); const b = byId.get(e.to)
    if (!a || !b) continue
    if (a.kind === 'file' && b.kind === 'file') {
      out.push(`    ${safeId(a.id)} -> ${safeId(b.id)} "${e.kind}"`)
    }
  }
  out.push('  }', '  views {', '    container softwaresystem { include * autoLayout }', '    component softwaresystem { include * autoLayout }', '  }', '}')
  return out.join('\n')
}

export function archToDot(g: DiffGraph): string {
  const ids = new Map<string, string>()
  const out = [
    'digraph GitLoomArch {',
    '  rankdir=LR;',
    '  node [fontname="Microsoft YaHei", fontsize=11, shape=box];',
    '  edge [fontname="Microsoft YaHei", fontsize=9];'
  ]
  for (const n of g.nodes) {
    if (n.group) continue
    out.push(`  ${mid(n.id, ids)} [label="${q(n.label)}"];`)
  }
  for (const e of g.edges) {
    out.push(`  ${mid(e.source, ids)} -> ${mid(e.target, ids)}${e.label ? ` [label="${q(e.label)}"]` : ''};`)
  }
  out.push('}')
  return out.join('\n')
}

/** Structurizr DSL from arch DiffGraph (layers → containers, components → components). */
export function archToStructurizr(g: DiffGraph, systemName = 'Application'): string {
  const layers = g.nodes.filter((n) => n.kind === 'layer')
  const comps = g.nodes.filter((n) => n.kind === 'component')
  const deps = g.edges.filter((e) => e.kind === 'depends' || e.kind === 'import' || e.kind === 'uses')
  const out = [
    `workspace "GitLoom Arch" {`,
    '  model {',
    `    softwaresystem = softwareSystem "${q(systemName)}" {`
  ]
  if (layers.length) {
    for (const l of layers) {
      out.push(`      ${safeId(l.id)} = container "${q(l.label)}" {`)
      for (const c of comps.filter((c) => c.parent === l.id)) {
        out.push(`        ${safeId(c.id)} = component "${q(c.label)}"`)
      }
      out.push('      }')
    }
  } else {
    out.push('      app = container "App" {')
    for (const c of comps.slice(0, 60)) out.push(`        ${safeId(c.id)} = component "${q(c.label)}"`)
    out.push('      }')
  }
  out.push('    }')
  for (const e of deps.slice(0, 100)) {
    out.push(`    ${safeId(e.source)} -> ${safeId(e.target)}${e.label ? ` "${q(e.label)}"` : ''}`)
  }
  out.push('  }', '  views {', '    container softwaresystem { include * autoLayout }', '    component softwaresystem { include * autoLayout }', '  }', '}')
  return out.join('\n')
}

export type ExportFormat = 'mermaid' | 'dot' | 'dsl'

export function exportFilename(base: string, format: ExportFormat): string {
  const ext = format === 'mermaid' ? 'mmd' : format === 'dot' ? 'dot' : 'dsl'
  return `${base}.${ext}`
}

