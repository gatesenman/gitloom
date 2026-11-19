import { promises as fsp, existsSync } from 'fs'
import * as path from 'path'
import { projectIdOf } from '../wiki'
import type { GraphData, GraphStatus, GraphNode } from './types'
import { blastRadius, neighborsOf, searchNodes } from './build'

export function graphPath(projectRoot: string, userData: string): string {
  return path.join(userData, 'projects', projectIdOf(projectRoot), 'graph.json')
}

export async function loadGraph(projectRoot: string, userData: string): Promise<GraphData | null> {
  const p = graphPath(projectRoot, userData)
  if (!existsSync(p)) return null
  try {
    const raw = await fsp.readFile(p, 'utf8')
    const data = JSON.parse(raw) as GraphData
    if (data?.version !== 1 || !Array.isArray(data.nodes)) return null
    return data
  } catch {
    return null
  }
}

export async function saveGraph(projectRoot: string, userData: string, data: GraphData): Promise<string> {
  const p = graphPath(projectRoot, userData)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, JSON.stringify(data), 'utf8')
  return p
}

export async function graphStatus(projectRoot: string, userData: string): Promise<GraphStatus> {
  const id = projectIdOf(projectRoot)
  const p = graphPath(projectRoot, userData)
  const data = await loadGraph(projectRoot, userData)
  return { projectId: id, path: p, exists: !!data, meta: data?.meta ?? null }
}

export async function getNode(projectRoot: string, userData: string, id: string): Promise<{
  node: GraphNode
  inDegree: number
  outDegree: number
  neighbors: ReturnType<typeof neighborsOf>
} | null> {
  const data = await loadGraph(projectRoot, userData)
  if (!data) return null
  const node = data.nodes.find((n) => n.id === id)
  if (!node) return null
  const neighbors = neighborsOf(data, id)
  const inDegree = neighbors.filter((n) => n.direction === 'in').length
  const outDegree = neighbors.filter((n) => n.direction === 'out').length
  return { node, inDegree, outDegree, neighbors }
}

export async function search(projectRoot: string, userData: string, q: string, limit = 30) {
  const data = await loadGraph(projectRoot, userData)
  if (!data) return []
  return searchNodes(data, q, limit)
}

export async function neighbors(projectRoot: string, userData: string, id: string, limit = 80) {
  const data = await loadGraph(projectRoot, userData)
  if (!data) return []
  return neighborsOf(data, id, limit)
}

export async function blast(projectRoot: string, userData: string, id: string, opts?: { maxDepth?: number; cap?: number }) {
  const data = await loadGraph(projectRoot, userData)
  if (!data) return { ids: [] as string[], depth: {} as Record<string, number>, nodes: [] as GraphNode[] }
  const r = blastRadius(data, id, opts)
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  return { ...r, nodes: r.ids.map((i) => byId.get(i)!).filter(Boolean) }
}

/** Which tracked files need re-parse given previous hashes. */
export function filesNeedingParse(
  allPaths: string[],
  hashes: Record<string, string> | undefined,
  contentHash: (path: string) => string | null
): { changed: string[]; unchanged: string[] } {
  const changed: string[] = []
  const unchanged: string[] = []
  for (const p of allPaths) {
    const h = contentHash(p)
    if (!h) { changed.push(p); continue }
    if (hashes && hashes[p] === h) unchanged.push(p)
    else changed.push(p)
  }
  return { changed, unchanged }
}
