/** 0.6.5 知识图谱：本机邻接表（无 Neo4j / 无 sqlite 原生依赖） */

export type GraphNodeKind = 'file' | 'module' | 'symbol' | 'wiki'
export type GraphSymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'other'
export type GraphEdgeKind = 'CONTAINS' | 'IMPORTS' | 'CALLS' | 'DEFINES' | 'MENTIONS'
export type EdgeConfidence = 'exact' | 'same-file' | 'import-scoped' | 'name-fallback'

export interface GraphNode {
  id: string
  kind: GraphNodeKind
  label: string
  /** file path / module dir / symbol qname / wiki rel */
  path?: string
  line?: number
  endLine?: number
  symbolKind?: GraphSymbolKind
  lang?: string
  hash?: string
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  kind: GraphEdgeKind
  confidence: EdgeConfidence
  line?: number
}

export interface GraphMeta {
  projectId: string
  repo?: string
  builtAt: number
  fileCount: number
  nodeCount: number
  edgeCount: number
  sampleCap: number
  truncated: boolean
}

export interface GraphData {
  version: 1
  meta: GraphMeta
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** path → content hash for incremental rebuild */
  fileHashes: Record<string, string>
}

export interface GraphStatus {
  projectId: string
  path: string
  exists: boolean
  meta: GraphMeta | null
}

export interface GraphNeighbor {
  edge: GraphEdge
  node: GraphNode
  direction: 'in' | 'out'
}

export interface GraphSearchHit {
  node: GraphNode
  score: number
}
