// Project manager: background scans (progress + cancel), incremental rescans, debounced fs watching.
// Electron-free: events are delivered through the `emit` callback.
import { watch, type FSWatcher } from 'fs'
import * as path from 'path'
import type { DiscoveredRepo, RawRepo, ScanOptions, ScanProgress, WatchEvent } from '../shared/types'
import { classifyRepos, depthOf, ignoreMatcher, mergeRaws, scanFolder } from './git/discovery'
import type { GitService } from './git/service'

const MAX_DIR_WATCHERS = 5000

export class ProjectManager {
  private raws = new Map<string, RawRepo[]>()
  private final = new Map<string, DiscoveredRepo[]>()
  private dirs = new Map<string, Set<string>>()
  private scans = new Map<string, { aborted: boolean }>()
  private watchers = new Map<string, FSWatcher[]>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingDirs = new Map<string, Set<string>>()

  constructor(private git: GitService, private emit: (channel: 'scan:progress' | 'watch:event' | 'project:updated', payload: unknown) => void, private opts: () => ScanOptions & { concurrency: number; watch: boolean; slowMs?: number }) {}

  /** Start a (sub)scan in the background; resolves with the final repo list. */
  async scan(scanId: string, root: string, sub?: string): Promise<DiscoveredRepo[]> {
    root = path.resolve(root)
    if (sub && !this.raws.has(root)) sub = undefined
    const signal = { aborted: false }
    this.scans.set(scanId, signal)
    const o = this.opts()
    const start = sub ? path.resolve(sub) : root
    const base = sub ? depthOf(root, start) : 0
    const send = (p: Partial<ScanProgress>) => this.emit('scan:progress', { scanId, root, sub, dirs: 0, found: 0, current: '', done: false, ...p } satisfies ScanProgress)
    try {
      const res = await scanFolder(start, { maxDepth: o.maxDepth, ignore: o.ignore, followSymlinks: o.followSymlinks }, {
        signal, slowMs: o.slowMs, onProgress: (p) => send({ dirs: p.dirs, found: p.found, current: p.current })
      }, base)
      if (res.cancelled) { send({ done: true, cancelled: true, dirs: res.visited, found: res.raws.length }); return this.repos(root) }
      const prev = this.raws.get(root)
      const raws = sub && prev ? mergeRaws(prev, start, res.raws) : res.raws
      this.raws.set(root, raws)
      const dirSet = sub && this.dirs.get(root) ? this.dirs.get(root)! : new Set<string>()
      for (const d of res.dirs) dirSet.add(d)
      this.dirs.set(root, dirSet)
      const repos = await this.finalize(root)
      this.final.set(root, repos)
      send({ done: true, dirs: res.visited, found: repos.length, repos, watchDirs: Math.min(dirSet.size, MAX_DIR_WATCHERS) })
      if (o.watch) this.watch(root)
      return repos
    } catch (e) {
      send({ done: true, error: (e as Error).message })
      throw e
    } finally {
      this.scans.delete(scanId)
    }
  }

  cancel(scanId: string): void { const s = this.scans.get(scanId); if (s) s.aborted = true }

  /** Last known classified repo list for a root (without rescanning). */
  repos(root: string): DiscoveredRepo[] { const k = path.resolve(root); const f = this.final.get(k); if (f) return f; const r = this.raws.get(k); return r ? classifyRepos(k, r) : [] }

  private async finalize(root: string): Promise<DiscoveredRepo[]> {
    const repos = classifyRepos(root, this.raws.get(root) ?? [])
    const nested = repos.filter((r) => r.kind === 'nested' && r.parent)
    let i = 0
    const worker = async () => { while (i < nested.length) { const r = nested[i++]; r.parentTracking = await this.git.parentTracking(r.parent!, r.path).catch(() => undefined) } }
    await Promise.all(Array.from({ length: Math.min(6, nested.length) }, worker))
    return repos
  }

  // ---------------------------------------------------------------- watching
  watch(root: string): void {
    root = path.resolve(root)
    this.unwatch(root)
    const list: FSWatcher[] = []
    const ignored = ignoreMatcher(this.opts().ignore)
    const dirs = [...(this.dirs.get(root) ?? [root])].slice(0, MAX_DIR_WATCHERS)
    for (const d of dirs) {
      try {
        const w = watch(d, { persistent: false }, (ev, name) => {
          if (ev !== 'rename' || !name) return
          const n = String(name)
          if (ignored(n) || n.endsWith('.lock') || n.endsWith('~')) return
          this.queueStructure(root, n === '.git' ? path.dirname(path.join(d, n)) : d)
        })
        w.on('error', () => undefined)
        list.push(w)
      } catch { /* dir vanished or watcher limit reached */ }
    }
    for (const r of this.raws.get(root) ?? []) {
      const gd = r.git === 'bare' ? null : r.gitDir
      if (!gd) continue
      try {
        const w = watch(gd, { persistent: false }, (_ev, name) => {
          const n = String(name ?? '')
          if (!/^(index|HEAD|MERGE_HEAD|ORIG_HEAD|FETCH_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|packed-refs|refs)$/.test(n)) return
          this.debounce(`s:${r.path}`, 400, () => this.emit('watch:event', { root, kind: 'status', path: r.path } satisfies WatchEvent))
        })
        w.on('error', () => undefined)
        list.push(w)
      } catch { /* ignore */ }
    }
    this.watchers.set(root, list)
  }

  unwatch(root: string): void {
    for (const w of this.watchers.get(path.resolve(root)) ?? []) { try { w.close() } catch { /* ignore */ } }
    this.watchers.delete(path.resolve(root))
  }

  dispose(): void { for (const r of [...this.watchers.keys()]) this.unwatch(r); for (const t of this.timers.values()) clearTimeout(t) }

  private queueStructure(root: string, dir: string): void {
    const set = this.pendingDirs.get(root) ?? new Set<string>()
    set.add(dir)
    this.pendingDirs.set(root, set)
    this.debounce(`d:${root}`, 900, async () => {
      const pending = [...(this.pendingDirs.get(root) ?? [])]
      this.pendingDirs.delete(root)
      // rescan the shallowest changed folders only (children are covered)
      const tops = pending.filter((p) => !pending.some((q) => q !== p && p.startsWith(q + path.sep)))
      for (const t of tops) await this.scan(`watch-${Date.now()}`, root, t).catch(() => undefined)
      this.emit('project:updated', { root, repos: this.repos(root), dirs: tops })
    })
  }

  private debounce(key: string, ms: number, fn: () => void): void {
    clearTimeout(this.timers.get(key))
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); fn() }, ms))
  }
}
