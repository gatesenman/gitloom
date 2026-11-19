// Multi-repo discovery: recursive, symlink-safe, cancellable filesystem scan + pure classification.
// Kept free of Electron so it can be unit-tested directly.
import { promises as fsp } from 'fs'
import * as path from 'path'
import type { DiscoveredRepo, RawRepo, ScanOptions } from '../../shared/types'

export const DEFAULT_IGNORE = ['node_modules', '.venv', 'venv', 'dist', 'target', 'build', 'out', 'vendor', '.cache', '__pycache__', '.next', '.nuxt', '.gradle', '.idea', 'Pods', '.terraform', 'coverage', 'bower_components']

export interface ScanCallbacks {
  signal?: { aborted: boolean }
  onProgress?: (p: { dirs: number; found: number; current: string }) => void
  /** demo/screenshot only: artificial delay per directory */
  slowMs?: number
}
export interface ScanResult { raws: RawRepo[]; dirs: string[]; cancelled: boolean; visited: number }

/** Compile ignore entries (basename or simple `*` globs, e.g. `*.egg-info`) into a matcher. */
export function ignoreMatcher(list: string[]): (name: string) => boolean {
  const exact = new Set<string>()
  const globs: RegExp[] = []
  for (const raw of list) {
    const s = raw.trim().replace(/\/+$/, '')
    if (!s) continue
    if (s.includes('*') || s.includes('?')) globs.push(new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'))
    else exact.add(s)
  }
  return (name) => exact.has(name) || globs.some((g) => g.test(name))
}

/** Parse a .gitmodules file into submodule entries. */
export function parseGitmodules(text: string): { name: string; path: string; url?: string }[] {
  const out: { name: string; path: string; url?: string }[] = []
  let cur: { name: string; path?: string; url?: string } | null = null
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[submodule\s+"(.+)"\]\s*$/.exec(line)
    if (sec) { if (cur?.path) out.push(cur as { name: string; path: string }); cur = { name: sec[1] }; continue }
    if (/^\s*\[/.test(line)) { if (cur?.path) out.push(cur as { name: string; path: string }); cur = null; continue }
    const kv = /^\s*(\w+)\s*=\s*(.*?)\s*$/.exec(line)
    if (kv && cur) { if (kv[1] === 'path') cur.path = kv[2].replace(/\/+$/, ''); if (kv[1] === 'url') cur.url = kv[2] }
  }
  if (cur?.path) out.push(cur as { name: string; path: string })
  return out
}

async function readText(p: string): Promise<string | null> { try { return await fsp.readFile(p, 'utf8') } catch { return null } }
async function isDir(p: string): Promise<boolean> { try { return (await fsp.stat(p)).isDirectory() } catch { return false } }

/** Inspect a directory: is it a repository root (non-bare / gitfile / bare)? */
export async function probeRepo(dir: string): Promise<RawRepo | null> {
  const dotgit = path.join(dir, '.git')
  let st: import('fs').Stats | null = null
  try { st = await fsp.lstat(dotgit) } catch { st = null }
  if (st?.isDirectory() || (st?.isSymbolicLink() && (await isDir(dotgit)))) {
    const raw: RawRepo = { path: dir, git: 'dir', gitDir: dotgit }
    await addRepoExtras(raw, dotgit)
    return raw
  }
  if (st?.isFile()) {
    const txt = (await readText(dotgit)) ?? ''
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(txt)
    if (!m) return null
    const gitDir = path.resolve(dir, m[1])
    const raw: RawRepo = { path: dir, git: 'gitfile', gitDir }
    const common = await readText(path.join(gitDir, 'commondir'))
    if (common !== null || /[\\/]worktrees[\\/][^\\/]+$/.test(gitDir)) {
      raw.git = 'worktree'
      const commonDir = path.resolve(gitDir, (common ?? '../..').trim())
      raw.mainRepo = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir
    } else if (/[\\/]modules[\\/]/.test(gitDir)) raw.git = 'modules'
    await addRepoExtras(raw, gitDir)
    return raw
  }
  // bare repository: HEAD + objects/ + refs/ directly in the folder, config says bare
  const head = await readText(path.join(dir, 'HEAD'))
  if (head && /^(ref: |[0-9a-f]{40})/.test(head) && (await isDir(path.join(dir, 'objects'))) && (await isDir(path.join(dir, 'refs')))) {
    const cfg = (await readText(path.join(dir, 'config'))) ?? ''
    if (/bare\s*=\s*true/i.test(cfg)) return { path: dir, git: 'bare', gitDir: dir }
  }
  return null
}

async function addRepoExtras(raw: RawRepo, gitDir: string): Promise<void> {
  const gm = await readText(path.join(raw.path, '.gitmodules'))
  if (gm) { const subs = parseGitmodules(gm); if (subs.length) raw.gitmodules = subs }
  if (raw.git === 'dir') {
    try {
      const names = await fsp.readdir(path.join(gitDir, 'worktrees'))
      const wts: string[] = []
      for (const n of names) {
        const g = await readText(path.join(gitDir, 'worktrees', n, 'gitdir'))
        if (g) wts.push(path.dirname(path.resolve(gitDir, 'worktrees', n, g.trim())))
      }
      if (wts.length) raw.worktrees = wts
    } catch { /* no linked worktrees */ }
  }
}

/**
 * Walk `root` breadth-first up to `maxDepth` levels, collecting repositories at any depth
 * (repos inside repos are kept). Ignored folder names are never entered; symlinked folders
 * are followed once (real-path de-duplication prevents loops). Bare repos are not descended.
 */
export async function scanFolder(root: string, opts: ScanOptions, cb: ScanCallbacks = {}, baseDepth = 0): Promise<ScanResult> {
  const ignored = ignoreMatcher(opts.ignore)
  const follow = opts.followSymlinks !== false
  const seen = new Set<string>()
  const raws: RawRepo[] = []
  const dirs: string[] = []
  let visited = 0
  let lastEmit = 0
  const queue: { dir: string; depth: number }[] = [{ dir: path.resolve(root), depth: baseDepth }]
  const CONCURRENCY = 8
  const worker = async (): Promise<void> => {
    while (queue.length) {
      if (cb.signal?.aborted) return
      const { dir, depth } = queue.shift()!
      let real: string
      try { real = await fsp.realpath(dir) } catch { continue }
      if (seen.has(real)) continue
      seen.add(real)
      visited++
      dirs.push(dir)
      const now = Date.now()
      if (cb.onProgress && now - lastEmit > 80) { lastEmit = now; cb.onProgress({ dirs: visited, found: raws.length, current: dir }) }
      if (cb.slowMs) await new Promise((r) => setTimeout(r, cb.slowMs))
      const repo = await probeRepo(dir)
      if (repo) raws.push(repo)
      if (repo?.git === 'bare') continue
      if (depth >= opts.maxDepth) continue
      let entries: import('fs').Dirent[]
      try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.name === '.git' || ignored(e.name)) continue
        const child = path.join(dir, e.name)
        if (e.isDirectory()) queue.push({ dir: child, depth: depth + 1 })
        else if (e.isSymbolicLink() && follow && (await isDir(child))) queue.push({ dir: child, depth: depth + 1 })
      }
    }
  }
  // run a small worker pool; new work may be queued by any worker, so loop until drained
  while (queue.length && !cb.signal?.aborted) await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  // declared submodules are probed explicitly, even inside ignored folders (e.g. vendor/) or beyond maxDepth
  if (!cb.signal?.aborted) {
    const have = new Set(raws.map((r) => path.resolve(r.path)))
    const todo = raws.flatMap((r) => (r.gitmodules ?? []).map((m) => path.resolve(r.path, m.path)))
    while (todo.length) {
      const p = todo.shift()!
      if (have.has(p)) continue
      have.add(p)
      const hit = await probeRepo(p)
      if (hit) { raws.push(hit); for (const m of hit.gitmodules ?? []) todo.push(path.resolve(hit.path, m.path)) }
    }
  }
  cb.onProgress?.({ dirs: visited, found: raws.length, current: '' })
  raws.sort((a, b) => a.path.localeCompare(b.path))
  return { raws, dirs, cancelled: !!cb.signal?.aborted, visited }
}

const norm = (p: string) => path.resolve(p)
const isInside = (child: string, parent: string) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r) }

/**
 * Turn raw scan hits into typed repositories:
 * - submodule: declared in an enclosing repo's .gitmodules (uninitialized ones are synthesized)
 * - worktree: linked worktree (inside the folder, or registered by a scanned repo but living outside)
 * - nested: independent repo inside another repo's working tree
 * - bare / normal
 */
export function classifyRepos(root: string, raws: RawRepo[]): DiscoveredRepo[] {
  root = norm(root)
  const byPath = new Map<string, RawRepo>()
  for (const r of raws) byPath.set(norm(r.path), r)
  // submodule declarations: abs path → owner + entry
  const declared = new Map<string, { owner: string; name: string; url?: string }>()
  for (const r of raws) for (const s of r.gitmodules ?? []) declared.set(norm(path.join(r.path, s.path)), { owner: norm(r.path), name: s.name, url: s.url })
  // outside worktrees registered by scanned repos
  const extra: RawRepo[] = []
  for (const r of raws) for (const wt of r.worktrees ?? []) {
    const p = norm(wt)
    if (!byPath.has(p) && !isInside(p, root) && p !== root) { const x: RawRepo = { path: p, git: 'worktree', mainRepo: norm(r.path) }; byPath.set(p, x); extra.push(x) }
  }
  const all = [...raws, ...extra]
  const nonBare = all.filter((r) => r.git !== 'bare').map((r) => norm(r.path))
  const enclosing = (p: string): string | undefined => {
    let best: string | undefined
    for (const q of nonBare) if (isInside(p, q) && (!best || q.length > best.length)) best = q
    return best
  }
  const out: DiscoveredRepo[] = []
  for (const r of all) {
    const p = norm(r.path)
    const rel = path.relative(root, p).split(path.sep).join('/')
    const base: DiscoveredRepo = { path: p, rel, kind: 'normal', initialized: true }
    const decl = declared.get(p)
    if (r.git === 'bare') base.kind = 'bare'
    else if (r.git === 'worktree') { base.kind = 'worktree'; base.mainRepo = r.mainRepo ? norm(r.mainRepo) : undefined; if (!isInside(p, root) && p !== root) base.outside = true }
    else if (decl || r.git === 'modules') {
      base.kind = 'submodule'
      base.parent = decl?.owner ?? enclosing(p)
      base.parentTracking = 'submodule'
      if (decl) base.submodule = { name: decl.name, url: decl.url }
    } else {
      const enc = enclosing(p)
      if (enc) { base.kind = 'nested'; base.parent = enc }
    }
    if (base.kind === 'worktree' && !base.outside) { const enc = enclosing(p); if (enc && enc !== base.mainRepo) base.parent = enc }
    out.push(base)
  }
  // declared but not checked out → uninitialized submodule entries
  for (const [p, d] of declared) {
    if (byPath.has(p)) continue
    if (!isInside(p, root) && p !== root) continue
    out.push({ path: p, rel: path.relative(root, p).split(path.sep).join('/'), kind: 'submodule', parent: d.owner, initialized: false, parentTracking: 'submodule', submodule: { name: d.name, url: d.url } })
  }
  out.sort((a, b) => (a.outside === b.outside ? a.rel.localeCompare(b.rel) : a.outside ? 1 : -1))
  return out
}

/** Merge an incremental rescan of folder `sub` (raw hits) into the cached raw list of the project. */
export function mergeRaws(prev: RawRepo[], sub: string, next: RawRepo[]): RawRepo[] {
  const s = norm(sub)
  const keep = prev.filter((r) => !(norm(r.path) === s || isInside(norm(r.path), s)))
  const seen = new Set(keep.map((r) => norm(r.path)))
  return [...keep, ...next.filter((r) => !seen.has(norm(r.path)))].sort((a, b) => a.path.localeCompare(b.path))
}

/** Depth of `sub` below `root` (0 for the root itself). */
export function depthOf(root: string, sub: string): number {
  const r = path.relative(norm(root), norm(sub))
  return r ? r.split(path.sep).length : 0
}
