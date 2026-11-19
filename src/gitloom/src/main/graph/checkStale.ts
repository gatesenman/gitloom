/** Main-process: check persisted knowledge graph against repo working tree. */
import { existsSync, readFileSync } from 'fs'
import * as path from 'path'
import { wikiRoot } from '../wiki'
import { loadGraph } from './store'
import { detectStaleNodes, textHasSymbol, type StaleReport } from './stale'
import type { GraphData } from './types'

export async function checkKnowledgeStale(
  projectRoot: string,
  userData: string,
  repo: string
): Promise<StaleReport & { nodeCount: number }> {
  const data = await loadGraph(projectRoot, userData)
  if (!data) return { staleIds: [], hits: [], checkedAt: Date.now(), nodeCount: 0 }
  const report = detectStaleNodes(data, {
    pathExists: (rel) => {
      try { return existsSync(path.join(repo, rel)) } catch { return false }
    },
    symbolExists: (rel, label) => {
      try {
        const src = readFileSync(path.join(repo, rel), 'utf8')
        if (src.length > 800_000) return true
        return textHasSymbol(src, label)
      } catch { return false }
    },
    wikiExists: (rel) => {
      try { return existsSync(path.join(wikiRoot(projectRoot, userData), rel)) } catch { return true }
    }
  })
  return { ...report, nodeCount: data.nodes.length }
}

export async function loadGraphData(projectRoot: string, userData: string): Promise<GraphData | null> {
  return loadGraph(projectRoot, userData)
}

export function pathExistsInRepo(repo: string, rel: string): boolean {
  try {
    return existsSync(path.join(repo, rel.replace(/\\/g, '/')))
  } catch { return false }
}

export function missingPathsInRepo(repo: string, paths: string[]): string[] {
  const miss: string[] = []
  const seen = new Set<string>()
  for (const p of paths) {
    const rel = p.replace(/\\/g, '/')
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    if (!pathExistsInRepo(repo, rel)) miss.push(rel)
  }
  return miss
}
