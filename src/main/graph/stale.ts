/**
 * Deterministic 过时 (stale) detection for knowledge-graph / architecture nodes.
 * Pure: callers supply existence / symbol predicates (fs or in-memory for tests).
 */
import type { GraphData, GraphNode, GraphNodeKind } from './types'

export type StaleReason =
  | 'missing-path'
  | 'missing-dir'
  | 'missing-symbol'
  | 'missing-wiki'

export interface StaleHit {
  id: string
  kind: GraphNodeKind
  label: string
  path?: string
  reason: StaleReason
}

export interface StaleReport {
  staleIds: string[]
  hits: StaleHit[]
  checkedAt: number
}

export interface StaleChecks {
  /** repo-relative file or directory exists at HEAD / working tree */
  pathExists: (relPath: string) => boolean
  /**
   * Symbol still defined in file. Prefer tree-sitter / AST; simple text match is OK.
   * Only called when pathExists(path) is true.
   */
  symbolExists?: (relPath: string, symbolLabel: string, opts?: { line?: number; endLine?: number; symbolKind?: string }) => boolean
  /** Wiki page exists (project wiki relative path). Default: treat as not stale if omitted. */
  wikiExists?: (relPath: string) => boolean
}

/** Extract bare symbol name from labels like `Foo.bar` or `helper`. */
export function symbolNameOf(label: string): string {
  const t = label.trim()
  if (!t) return ''
  const parts = t.split('.')
  return parts[parts.length - 1] || t
}

/**
 * Cheap deterministic symbol presence: word-boundary match of the symbol name in source.
 * Skips comment-only false positives loosely; good enough for stale badge (not a compiler).
 */
export function textHasSymbol(src: string, symbolLabel: string): boolean {
  const name = symbolNameOf(symbolLabel)
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return true // non-identifier → don't mark stale
  // common declaration forms across TS/JS/Python/Go/Java/Rust-ish
  const re = new RegExp(
    `(?:^|[\\s({,;]|\\b)(?:(?:export|declare|async|public|private|protected|static|abstract|override|const|let|var|function|class|interface|type|enum|def|fn|func|fun|struct|trait|impl)\\s+)*${name.replace(/\$/g, '\\$')}\\b`,
    'm'
  )
  if (re.test(src)) return true
  // method shorthand / property assignment
  const re2 = new RegExp(`(?:^|[\\s,{])${name.replace(/\$/g, '\\$')}\\s*[:=(]`, 'm')
  return re2.test(src)
}

export function isNodeStale(node: GraphNode, checks: StaleChecks): StaleReason | null {
  const p = (node.path || '').replace(/\\/g, '/')
  if (node.kind === 'wiki') {
    if (!p) return null
    if (checks.wikiExists && !checks.wikiExists(p)) return 'missing-wiki'
    return null
  }
  if (node.kind === 'module') {
    if (!p || p === '.') return null
    if (!checks.pathExists(p)) return 'missing-dir'
    return null
  }
  if (node.kind === 'file') {
    if (!p) return 'missing-path'
    if (!checks.pathExists(p)) return 'missing-path'
    return null
  }
  if (node.kind === 'symbol') {
    if (!p) return 'missing-path'
    if (!checks.pathExists(p)) return 'missing-path'
    if (checks.symbolExists) {
      if (!checks.symbolExists(p, node.label, { line: node.line, endLine: node.endLine, symbolKind: node.symbolKind })) {
        return 'missing-symbol'
      }
    }
    return null
  }
  return null
}

export function detectStaleNodes(data: GraphData, checks: StaleChecks): StaleReport {
  const hits: StaleHit[] = []
  for (const n of data.nodes) {
    const reason = isNodeStale(n, checks)
    if (reason) hits.push({ id: n.id, kind: n.kind, label: n.label, path: n.path, reason })
  }
  hits.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  return { staleIds: hits.map((h) => h.id), hits, checkedAt: Date.now() }
}

/** Filter graph to only stale (or only fresh) nodes + incident edges. Pure. */
export function filterByStale(data: GraphData, staleIds: ReadonlySet<string>, mode: 'stale' | 'fresh' | 'all'): GraphData {
  if (mode === 'all') return data
  const keep = new Set(
    data.nodes.filter((n) => (mode === 'stale' ? staleIds.has(n.id) : !staleIds.has(n.id))).map((n) => n.id)
  )
  return {
    ...data,
    nodes: data.nodes.filter((n) => keep.has(n.id)),
    edges: data.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    meta: {
      ...data.meta,
      nodeCount: keep.size,
      edgeCount: data.edges.filter((e) => keep.has(e.from) && keep.has(e.to)).length
    }
  }
}

/** Loc-like refs used by arch / C4 DiffGraph nodes. */
export interface LocRef {
  file?: string
  line?: number
}

export interface ArchNodeRef {
  id: string
  label: string
  kind?: string
  after?: LocRef | null
  before?: LocRef | null
}

/**
 * Architecture / C4 DiffGraph: a node is 过时 when its HEAD (`after`) file path is gone.
 * Layer/group nodes without a file ref are never stale.
 */
export function detectArchStale(
  nodes: ArchNodeRef[],
  pathExists: (relPath: string) => boolean
): StaleReport {
  const hits: StaleHit[] = []
  for (const n of nodes) {
    const file = (n.after?.file || n.before?.file || '').replace(/\\/g, '/')
    if (!file) continue
    if (!pathExists(file)) {
      hits.push({
        id: n.id,
        kind: 'file',
        label: n.label,
        path: file,
        reason: 'missing-path'
      })
    }
  }
  hits.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  return { staleIds: hits.map((h) => h.id), hits, checkedAt: Date.now() }
}

/** Evidence rows (C4): mark when evidence.file is missing. */
export function staleEvidenceFiles(
  evidence: { file: string; line?: number }[],
  pathExists: (relPath: string) => boolean
): { file: string; line?: number }[] {
  return evidence.filter((e) => e.file && !pathExists(e.file.replace(/\\/g, '/')))
}
