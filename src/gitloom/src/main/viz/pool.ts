// Small pool of analysis workers (tree-sitter is CPU bound). Items are split into chunks across workers;
// if a worker cannot start (e.g. packaging problem) the caller falls back to in-process parsing.
import { Worker } from 'worker_threads'
import { cpus } from 'os'
import type { ParseItem } from './service'
import type { FileFacts } from './facts'

interface Job { resolve: (f: FileFacts[]) => void; reject: (e: Error) => void; progress?: (n: number) => void }

export class VizPool {
  private workers: Worker[] = []
  private jobs = new Map<number, Job>()
  private seq = 0
  private idle: ReturnType<typeof setTimeout> | null = null
  constructor(private script: string, private data: { grammarDir: string; runtimeWasm?: string }, private size = Math.max(1, Math.min(4, cpus().length - 1))) {}

  private ensure(): Worker[] {
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    while (this.workers.length < this.size) {
      const w = new Worker(this.script, { workerData: this.data })
      w.on('message', (m: { id: number; progress?: number; facts?: FileFacts[]; error?: string }) => {
        const j = this.jobs.get(m.id); if (!j) return
        if (m.progress !== undefined) { j.progress?.(m.progress); return }
        this.jobs.delete(m.id)
        if (m.error) j.reject(new Error(m.error)); else j.resolve(m.facts!)
      })
      w.on('error', (e) => { for (const [id, j] of this.jobs) { this.jobs.delete(id); j.reject(e) } this.workers = this.workers.filter((x) => x !== w) })
      w.on('exit', () => { this.workers = this.workers.filter((x) => x !== w) })
      this.workers.push(w)
    }
    return this.workers
  }

  private send(w: Worker, items: ParseItem[], progress?: (n: number) => void): Promise<FileFacts[]> {
    const id = ++this.seq
    return new Promise((resolve, reject) => { this.jobs.set(id, { resolve, reject, progress }); w.postMessage({ id, items }) })
  }

  async parseMany(items: ParseItem[], onProgress?: (done: number) => void): Promise<FileFacts[]> {
    const ws = this.ensure()
    const n = Math.min(ws.length, Math.max(1, Math.ceil(items.length / 40)))
    // contiguous chunks keep the result order trivial; balance by source size
    const total = items.reduce((s, x) => s + x.src.length, 0)
    const chunks: ParseItem[][] = Array.from({ length: n }, () => [])
    let acc = 0
    for (const it of items) { chunks[Math.min(n - 1, Math.floor((acc / Math.max(1, total)) * n))].push(it); acc += it.src.length }
    const done = new Array(n).fill(0)
    try {
      const parts = await Promise.all(chunks.map((c, i) => (c.length ? this.send(ws[i], c, (d) => { done[i] = d; onProgress?.(done.reduce((s, x) => s + x, 0)) }) : Promise.resolve([]))))
      return parts.flat()
    } finally {
      this.idle = setTimeout(() => { if (!this.jobs.size) this.dispose() }, 60_000) // free the wasm heaps when unused
    }
  }

  dispose(): void { for (const w of this.workers) void w.terminate(); this.workers = [] }
}
