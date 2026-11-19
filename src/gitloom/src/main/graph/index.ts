/** 0.6.5 Knowledge graph service — FactParser → local adjacency JSON. */
import { createHash } from 'crypto'
import { promises as fsp, existsSync } from 'fs'
import * as path from 'path'
import type { FileFacts } from '../viz/facts'
import { fnv } from '../viz/facts'
import { langOf } from '../viz/langs'
import { projectIdOf } from '../wiki'
import * as wiki from '../wiki'
import { buildGraphFromFacts } from './build'
import * as store from './store'
import type { GraphData, GraphStatus } from './types'

export * from './types'
export * from './build'
export { graphPath, loadGraph, graphStatus, getNode, search, neighbors, blast, saveGraph } from './store'

const CODE_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.py', '*.go', '*.java', '*.rs', '*.kt', '*.cs']
const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|\.git|__tests__|__mocks__|\.test\.|\.spec\.)/i

export interface GraphBuildDeps {
  gitRaw: (repo: string, args: string[]) => Promise<{ output: string; ok?: boolean }>
  parseMany: (items: { path: string; lang: string; src: string }[], onProgress?: (done: number, total: number) => void) => Promise<FileFacts[]>
}

export interface GraphBuildOpts {
  projectRoot: string
  userData: string
  repo: string
  sampleCap?: number
  signal?: AbortSignal
  onProgress?: (p: { phase: string; done: number; total: number; text?: string }) => void
  /** force full rebuild ignoring hashes */
  force?: boolean
}

export async function buildKnowledgeGraph(deps: GraphBuildDeps, opts: GraphBuildOpts): Promise<GraphData> {
  const { projectRoot, userData, repo } = opts
  const sampleCap = opts.sampleCap ?? 600
  const aborted = () => !!opts.signal?.aborted
  const progress = (phase: string, done: number, total: number, text?: string) => {
    opts.onProgress?.({ phase, done, total, text })
  }

  progress('list', 0, 1, '列举源文件…')
  const r = await deps.gitRaw(repo, ['ls-files', '-z', ...CODE_GLOBS])
  let paths = r.output.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')).filter((p) => !SKIP.test(p))
  paths.sort()
  const truncated = paths.length > sampleCap
  if (truncated) paths = paths.slice(0, sampleCap)

  const prev = opts.force ? null : await store.loadGraph(projectRoot, userData)
  const prevByPath = new Map((prev?.nodes || []).filter((n) => n.kind === 'file' && n.path).map((n) => [n.path!, n]))

  // decide which to reparse
  const toParse: { path: string; lang: string; src: string }[] = []
  const reused: FileFacts[] = []
  const total = paths.length
  let i = 0
  for (const p of paths) {
    if (aborted()) throw new Error('已取消')
    i++
    if (i % 40 === 0) progress('hash', i, total, `读取 ${i}/${total}`)
    const full = path.join(repo, p)
    if (!existsSync(full)) continue
    let src: string
    try {
      src = await fsp.readFile(full, 'utf8')
    } catch { continue }
    if (src.includes('\0') || src.length > 500_000) continue
    const h = fnv(src)
    const lang = langOf(p) || 'javascript'
    if (!opts.force && prev?.fileHashes?.[p] === h) {
      // reconstruct minimal FileFacts from previous? We don't store full facts — must reparse OR keep stub.
      // For incremental: if hash matches, still need facts for CALLS. Persist lightweight facts cache.
      const cachePath = path.join(userData, 'projects', projectIdOf(projectRoot), 'graph-facts', createHash('sha1').update(p).digest('hex').slice(0, 12) + '.json')
      if (existsSync(cachePath)) {
        try {
          const f = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as FileFacts
          if (f.hash === h) { reused.push(f); continue }
        } catch { /* */ }
      }
    }
    void prevByPath
    toParse.push({ path: p, lang, src })
  }

  progress('parse', 0, toParse.length, `解析 ${toParse.length} 个文件…`)
  let parsed: FileFacts[] = []
  if (toParse.length) {
    parsed = await deps.parseMany(toParse, (done, tot) => {
      if (aborted()) throw new Error('已取消')
      progress('parse', done, tot, `tree-sitter ${done}/${tot}`)
    })
    // cache facts
    const cacheDir = path.join(userData, 'projects', projectIdOf(projectRoot), 'graph-facts')
    await fsp.mkdir(cacheDir, { recursive: true })
    for (const f of parsed) {
      const cachePath = path.join(cacheDir, createHash('sha1').update(f.path).digest('hex').slice(0, 12) + '.json')
      // strip heavy flow to keep cache small
      const slim: FileFacts = {
        ...f,
        fns: f.fns.map((fn) => ({ ...fn, flow: [] })),
        idents: f.idents.slice(0, 80)
      }
      await fsp.writeFile(cachePath, JSON.stringify(slim), 'utf8').catch(() => undefined)
    }
  }

  const facts = [...reused, ...parsed]
  progress('wiki', 0, 1, '关联 Wiki…')
  let wikiPages: { path: string; title: string; content?: string }[] = []
  try {
    const pages = await wiki.listWikiPages(projectRoot, userData)
    for (const pg of pages.slice(0, 40)) {
      let content = ''
      try { content = (await wiki.readWikiPage(projectRoot, userData, pg.path)).content.slice(0, 4000) } catch { /* */ }
      wikiPages.push({ path: pg.path, title: pg.title, content })
    }
  } catch { /* */ }

  if (aborted()) throw new Error('已取消')
  progress('link', 0, 1, '构建节点与边…')
  const data = buildGraphFromFacts({
    projectId: projectIdOf(projectRoot),
    repo,
    facts,
    wikiPages,
    sampleCap,
    truncated
  })
  await store.saveGraph(projectRoot, userData, data)
  progress('done', 1, 1, `完成 · ${data.meta.nodeCount} 节点 · ${data.meta.edgeCount} 边`)
  return data
}

export { checkKnowledgeStale, loadGraphData, missingPathsInRepo, pathExistsInRepo } from './checkStale'
export { detectStaleNodes, detectArchStale, filterByStale, textHasSymbol, isNodeStale } from './stale'
export type { StaleHit, StaleReport, StaleReason, StaleChecks } from './stale'
