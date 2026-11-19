// Single-flight, cancellable, cached, frame-throttled AI runs (pure: no React / no window.api, unit-tested).
//
// Why: in 0.4.2 every click on an AI button started another streamed request. Overlapping streams all wrote into the
// same state (text jumped between their partial outputs), results of slow requests overwrote fast ones, and every token
// re-rendered the whole view. AIRun guarantees:
//   • one request per key at a time — repeated start() for the running key is a no-op (single-flight);
//   • starting another key, stop(), select(otherKey) and dispose() abort the running request (AbortController);
//   • streamed text is published at most once per animation frame; stale callbacks of aborted runs are ignored;
//   • finished results are cached per key (callers include repo + sha + provider/model in the key).

export type RunStatus = 'idle' | 'running' | 'done' | 'stopped' | 'error'
export interface RunState {
  status: RunStatus
  key: string | null
  text: string
  error?: string
  /** result came from the cache (no request) */
  cached?: boolean
}
export type StartFn = (signal: AbortSignal, onDelta: (full: string) => void) => Promise<string>
type Listener = () => void

/** Tiny LRU for results. */
export class LRU<V> {
  private m = new Map<string, V>()
  constructor(private max = 100) {}
  get(k: string): V | undefined { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v) } return v }
  has(k: string): boolean { return this.m.has(k) }
  set(k: string, v: V): void { this.m.delete(k); this.m.set(k, v); while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string) }
  delete(k: string): void { this.m.delete(k) }
  clear(): void { this.m.clear() }
  get size(): number { return this.m.size }
}

export const isAbortError = (e: unknown): boolean => {
  const x = e as { name?: string; message?: string } | null
  return !!x && (x.name === 'AbortError' || /已停止生成|aborted|AbortError/i.test(x.message ?? ''))
}
export const abortError = (): Error => { const e = new Error('已停止生成'); e.name = 'AbortError'; return e }

const defaultSchedule = (cb: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb())
  else setTimeout(cb, 16)
}

export class AIRun {
  private state: RunState = { status: 'idle', key: null, text: '' }
  private listeners = new Set<Listener>()
  private ctl: AbortController | null = null
  private seq = 0
  private pending: string | null = null
  private scheduled = false
  private readonly schedule: (cb: () => void) => void
  private readonly cache?: LRU<string>
  private readonly errText: (e: unknown) => string

  constructor(o: { cache?: LRU<string>; schedule?: (cb: () => void) => void; errText?: (e: unknown) => string } = {}) {
    this.cache = o.cache
    this.schedule = o.schedule ?? defaultSchedule
    this.errText = o.errText ?? ((e) => (e as Error)?.message ?? String(e))
  }

  subscribe = (l: Listener): (() => void) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  getState = (): RunState => this.state
  get running(): boolean { return this.state.status === 'running' }

  private set(s: RunState): void { this.state = s; for (const l of [...this.listeners]) l() }

  /** Point the runner at `key` without starting: shows a cached result, otherwise idle. Aborts a run for another key. */
  select(key: string | null): void {
    if (this.state.key === key) return
    if (this.running) this.abort()
    const hit = key ? this.cache?.get(key) : undefined
    this.set(hit !== undefined ? { status: 'done', key, text: hit, cached: true } : { status: 'idle', key, text: '' })
  }

  /**
   * Start (or join) a run for `key`. Returns true only when a new request was actually started.
   * Same key already running → no-op. Cached result → shown instantly unless `force` (重新生成).
   */
  start(key: string, fn: StartFn, o: { force?: boolean } = {}): boolean {
    if (this.running && this.state.key === key) return false
    if (!o.force) {
      const hit = this.cache?.get(key)
      if (hit !== undefined) { if (this.running) this.abort(); this.set({ status: 'done', key, text: hit, cached: true }); return false }
    }
    if (this.running) this.abort()
    const my = ++this.seq
    const ctl = new AbortController()
    this.ctl = ctl
    this.pending = null
    this.set({ status: 'running', key, text: '' })
    const onDelta = (full: string): void => {
      if (my !== this.seq) return
      this.pending = full
      if (this.scheduled) return
      this.scheduled = true
      this.schedule(() => {
        this.scheduled = false
        if (my !== this.seq || this.pending === null || !this.running) return
        const t = this.pending
        this.pending = null
        if (t !== this.state.text) this.set({ ...this.state, text: t })
      })
    }
    let p: Promise<string>
    try { p = fn(ctl.signal, onDelta) } catch (e) { p = Promise.reject(e) }
    p.then((text) => {
      if (my !== this.seq) return
      this.ctl = null
      this.pending = null
      this.cache?.set(key, text)
      this.set({ status: 'done', key, text })
    }, (e) => {
      if (my !== this.seq) return
      this.ctl = null
      const partial = this.pending ?? this.state.text
      this.pending = null
      if (ctl.signal.aborted || isAbortError(e)) this.set({ status: 'stopped', key, text: partial })
      else this.set({ status: 'error', key, text: partial, error: this.errText(e) })
    })
    return true
  }

  /** 停止: abort the running request, keep the partial text (not cached). */
  stop(): void {
    if (!this.running) return
    const partial = this.pending ?? this.state.text
    this.abort()
    this.set({ ...this.state, status: 'stopped', text: partial })
  }

  /** Forget the visible result (does not touch the cache unless asked). */
  reset(o: { dropCache?: boolean } = {}): void {
    if (this.running) this.abort()
    if (o.dropCache && this.state.key) this.cache?.delete(this.state.key)
    this.set({ status: 'idle', key: this.state.key, text: '' })
  }

  dispose(): void { if (this.running) this.abort(); this.listeners.clear() }

  private abort(): void {
    this.seq++                       // invalidate callbacks of the old run
    this.pending = null
    this.ctl?.abort()
    this.ctl = null
  }
}

/** Single-flight guard for plain async actions (git buttons, commit): concurrent calls with the same key share one run. */
export function singleFlight<A extends unknown[], R>(fn: (...a: A) => Promise<R>, keyOf: (...a: A) => string = () => ''): (...a: A) => Promise<R> {
  const inflight = new Map<string, Promise<R>>()
  return (...a: A) => {
    const k = keyOf(...a)
    const cur = inflight.get(k)
    if (cur) return cur
    const p = fn(...a).finally(() => inflight.delete(k))
    inflight.set(k, p)
    return p
  }
}

/** Identity of the provider/model a task would use — part of AI cache keys so switching model never shows stale text. */
export function aiTag(ai: { activeProfile?: string; model?: string; profiles?: { id: string; preset: string; model: string; azureDeployment?: string }[]; tasks?: Partial<Record<string, { profile?: string; model?: string }>> } | undefined, task: string): string {
  if (!ai) return 'none'
  const t = ai.tasks?.[task]
  const pid = t?.profile || ai.activeProfile || ''
  const p = ai.profiles?.find((x) => x.id === pid) ?? ai.profiles?.[0]
  const model = t?.model || p?.azureDeployment || p?.model || ai.model || ''
  return `${p?.preset ?? 'legacy'}:${p?.id ?? ''}:${model}`
}
