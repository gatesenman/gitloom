/** Build graph nodes/edges from FileFacts (+ optional wiki pages). Pure. */
import { posix } from 'path'
import type { FileFacts } from '../viz/facts'
import { SideModel, fnIdOf, declIdOf } from '../viz/model'
import type { EdgeConfidence, GraphData, GraphEdge, GraphMeta, GraphNode, GraphSymbolKind } from './types'

const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|\.git)(\/|$)/i

function eid(kind: string, from: string, to: string): string {
  return `${kind}:${from}->${to}`
}

function moduleId(dir: string): string {
  return `mod:${dir || '.'}`
}

function fileId(p: string): string {
  return `file:${p}`
}

function symKindOf(kind: string, hasOwner: boolean): GraphSymbolKind {
  if (hasOwner && kind === 'function') return 'method'
  if (kind === 'function') return 'function'
  if (kind === 'class' || kind === 'interface' || kind === 'type' || kind === 'enum') return kind
  return 'other'
}

export interface BuildInput {
  projectId: string
  repo?: string
  facts: FileFacts[]
  wikiPages?: { path: string; title: string; content?: string }[]
  sampleCap?: number
  truncated?: boolean
}

export function buildGraphFromFacts(input: BuildInput): GraphData {
  const cap = input.sampleCap ?? 800
  const facts = input.facts.filter((f) => !SKIP.test(f.path)).slice(0, cap)
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const seenE = new Set<string>()
  const fileHashes: Record<string, string> = {}

  const addN = (n: GraphNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n) }
  const addE = (e: GraphEdge) => {
    if (seenE.has(e.id)) return
    seenE.add(e.id)
    edges.push(e)
  }

  // modules + files + CONTAINS(module→file)
  for (const f of facts) {
    const p = f.path.replace(/\\/g, '/')
    fileHashes[p] = f.hash
    const dir = posix.dirname(p)
    const mid = moduleId(dir === '.' ? '' : dir)
    addN({ id: mid, kind: 'module', label: dir === '.' ? '(root)' : dir, path: dir === '.' ? '.' : dir })
    addN({ id: fileId(p), kind: 'file', label: posix.basename(p), path: p, lang: f.lang, hash: f.hash })
    addE({ id: eid('CONTAINS', mid, fileId(p)), from: mid, to: fileId(p), kind: 'CONTAINS', confidence: 'exact' })

    // parent module chain (shallow)
    if (dir && dir !== '.') {
      const parts = dir.split('/')
      for (let i = 1; i < parts.length; i++) {
        const child = parts.slice(0, i + 1).join('/')
        const parent = parts.slice(0, i).join('/')
        const cid = moduleId(child)
        const pid = moduleId(parent)
        addN({ id: cid, kind: 'module', label: child, path: child })
        addN({ id: pid, kind: 'module', label: parent || '(root)', path: parent || '.' })
        addE({ id: eid('CONTAINS', pid, cid), from: pid, to: cid, kind: 'CONTAINS', confidence: 'exact' })
      }
    }

    for (const d of f.decls) {
      const id = `sym:${declIdOf(p, d)}`
      addN({
        id, kind: 'symbol', label: d.owner ? `${d.owner}.${d.name}` : d.name,
        path: p, line: d.line, endLine: d.endLine, symbolKind: symKindOf(d.kind, !!d.owner), lang: f.lang
      })
      addE({ id: eid('DEFINES', fileId(p), id), from: fileId(p), to: id, kind: 'DEFINES', confidence: 'exact', line: d.line })
      addE({ id: eid('CONTAINS', fileId(p), id), from: fileId(p), to: id, kind: 'CONTAINS', confidence: 'exact', line: d.line })
    }
    for (const fn of f.fns) {
      const id = `sym:${fnIdOf(p, fn)}`
      addN({
        id, kind: 'symbol', label: fn.owner ? `${fn.owner}.${fn.name}` : fn.name,
        path: p, line: fn.line, endLine: fn.endLine, symbolKind: symKindOf('function', !!fn.owner), lang: f.lang
      })
      addE({ id: eid('DEFINES', fileId(p), id), from: fileId(p), to: id, kind: 'DEFINES', confidence: 'exact', line: fn.line })
      addE({ id: eid('CONTAINS', fileId(p), id), from: fileId(p), to: id, kind: 'CONTAINS', confidence: 'exact', line: fn.line })
    }
  }

  // IMPORTS + CALLS via SideModel resolution
  const model = new SideModel(facts)
  for (const [from, tos] of model.imports) {
    for (const [to, line] of tos) {
      addE({
        id: eid('IMPORTS', fileId(from), fileId(to)),
        from: fileId(from), to: fileId(to), kind: 'IMPORTS', confidence: 'exact', line
      })
    }
  }
  for (const [fromFn, callees] of model.calls) {
    for (const [toFn, line] of callees) {
      const conf: EdgeConfidence = fromFn.split('#')[0] === toFn.split('#')[0] ? 'same-file' : 'exact'
      addE({
        id: eid('CALLS', `sym:${fromFn}`, `sym:${toFn}`),
        from: `sym:${fromFn}`, to: `sym:${toFn}`, kind: 'CALLS', confidence: conf, line
      })
      // ensure callee node exists (may be missing if outside sample)
      if (!nodes.has(`sym:${toFn}`)) {
        const [fp, name] = toFn.split('#')
        addN({ id: `sym:${toFn}`, kind: 'symbol', label: name || toFn, path: fp, symbolKind: 'function' })
      }
      if (!nodes.has(`sym:${fromFn}`)) {
        const [fp, name] = fromFn.split('#')
        addN({ id: `sym:${fromFn}`, kind: 'symbol', label: name || fromFn, path: fp, symbolKind: 'function' })
      }
    }
  }

  // optional wiki MENTIONS
  for (const w of input.wikiPages || []) {
    const wid = `wiki:${w.path}`
    addN({ id: wid, kind: 'wiki', label: w.title || w.path, path: w.path })
    const body = `${w.title}\n${w.content || ''}`
    for (const f of facts) {
      const p = f.path.replace(/\\/g, '/')
      const base = posix.basename(p)
      if (body.includes(p) || body.includes(base)) {
        addE({
          id: eid('MENTIONS', wid, fileId(p)),
          from: wid, to: fileId(p), kind: 'MENTIONS', confidence: body.includes(p) ? 'exact' : 'name-fallback'
        })
      }
    }
  }

  const meta: GraphMeta = {
    projectId: input.projectId,
    repo: input.repo,
    builtAt: Date.now(),
    fileCount: facts.length,
    nodeCount: nodes.size,
    edgeCount: edges.length,
    sampleCap: cap,
    truncated: !!(input.truncated || input.facts.length > cap)
  }
  return { version: 1, meta, nodes: [...nodes.values()], edges, fileHashes }
}

/** BFS blast radius on directed CALLS+IMPORTS (+ optional CONTAINS reverse). Pure. */
export function blastRadius(
  data: GraphData,
  startId: string,
  opts: { maxDepth?: number; cap?: number; kinds?: GraphEdge['kind'][] } = {}
): { ids: string[]; depth: Record<string, number> } {
  const maxDepth = opts.maxDepth ?? 4
  const cap = opts.cap ?? 200
  const kinds = new Set(opts.kinds ?? ['CALLS', 'IMPORTS', 'CONTAINS'])
  const adj = new Map<string, string[]>()
  for (const e of data.edges) {
    if (!kinds.has(e.kind)) continue
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push(e.to)
  }
  const depth: Record<string, number> = { [startId]: 0 }
  const q = [startId]
  const ids: string[] = []
  while (q.length && ids.length < cap) {
    const cur = q.shift()!
    if (cur !== startId) ids.push(cur)
    const d = depth[cur] ?? 0
    if (d >= maxDepth) continue
    for (const nxt of adj.get(cur) || []) {
      if (nxt in depth) continue
      depth[nxt] = d + 1
      q.push(nxt)
    }
  }
  return { ids, depth }
}

export function searchNodes(data: GraphData, q: string, limit = 30): { node: GraphNode; score: number }[] {
  const terms = q.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const hits: { node: GraphNode; score: number }[] = []
  for (const n of data.nodes) {
    const hay = `${n.label} ${n.path || ''} ${n.id}`.toLowerCase()
    let score = 0
    for (const t of terms) {
      if (n.label.toLowerCase() === t) score += 10
      else if (n.label.toLowerCase().includes(t)) score += 5
      else if (hay.includes(t)) score += 2
    }
    if (score > 0) hits.push({ node: n, score })
  }
  hits.sort((a, b) => b.score - a.score || a.node.label.localeCompare(b.node.label))
  return hits.slice(0, limit)
}

export function neighborsOf(data: GraphData, id: string, limit = 80): { edge: GraphEdge; node: GraphNode; direction: 'in' | 'out' }[] {
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const out: { edge: GraphEdge; node: GraphNode; direction: 'in' | 'out' }[] = []
  for (const e of data.edges) {
    if (e.from === id) {
      const n = byId.get(e.to)
      if (n) out.push({ edge: e, node: n, direction: 'out' })
    } else if (e.to === id) {
      const n = byId.get(e.from)
      if (n) out.push({ edge: e, node: n, direction: 'in' })
    }
    if (out.length >= limit) break
  }
  return out
}
