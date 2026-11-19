/** 体检报告短缓存 + 历史持久化 `<userData>/health-reports/<repoId>/` */
import { createHash } from 'crypto'
import { promises as fsp, existsSync, mkdirSync } from 'fs'
import * as path from 'path'
import type { Finding, FindingStatus, HealthReport, HealthReportMeta } from '../../shared/health'
import { summarizeFindings } from '../../shared/health'

const MAX_HISTORY = 20
const CACHE_TTL_MS = 90_000

export function repoIdOf(repo: string): string {
  const n = path.resolve(repo).replace(/\\/g, '/').toLowerCase()
  return createHash('sha1').update(n).digest('hex').slice(0, 16)
}

export function reportsDir(userData: string, repo: string): string {
  return path.join(userData, 'health-reports', repoIdOf(repo))
}

interface CacheEntry { key: string; report: HealthReport; at: number }

export class HealthStore {
  private cache = new Map<string, CacheEntry>()
  constructor(private userData: string) {}

  cacheKey(repo: string, scope: string, checks: string[], contentHash: string): string {
    return createHash('sha1').update([repoIdOf(repo), scope, checks.slice().sort().join(','), contentHash].join('|')).digest('hex')
  }

  getCached(key: string): HealthReport | null {
    const e = this.cache.get(key)
    if (!e) return null
    if (Date.now() - e.at > CACHE_TTL_MS) { this.cache.delete(key); return null }
    return structuredClone(e.report)
  }

  setCached(key: string, report: HealthReport): void {
    this.cache.set(key, { key, report: structuredClone(report), at: Date.now() })
  }

  async save(report: HealthReport): Promise<void> {
    if (!report.repo) return
    const dir = reportsDir(this.userData, report.repo)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${report.id}.json`)
    await fsp.writeFile(file, JSON.stringify(report, null, 2), 'utf8')
    await this.trim(dir)
  }

  private async trim(dir: string): Promise<void> {
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse()
    for (const f of files.slice(MAX_HISTORY)) {
      try { await fsp.unlink(path.join(dir, f)) } catch { /* */ }
    }
  }

  async list(repo: string): Promise<HealthReportMeta[]> {
    const dir = reportsDir(this.userData, repo)
    if (!existsSync(dir)) return []
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse()
    const out: HealthReportMeta[] = []
    for (const f of files) {
      try {
        const r = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) as HealthReport
        out.push({ id: r.id, createdAt: r.createdAt, scope: r.scope, repo: r.repo, summary: r.summary, durationMs: r.durationMs, cancelled: r.cancelled })
      } catch { /* */ }
    }
    out.sort((a, b) => b.createdAt - a.createdAt)
    return out.slice(0, MAX_HISTORY)
  }

  async get(repo: string, id: string): Promise<HealthReport | null> {
    const file = path.join(reportsDir(this.userData, repo), `${id}.json`)
    if (!existsSync(file)) return null
    try { return JSON.parse(await fsp.readFile(file, 'utf8')) as HealthReport } catch { return null }
  }

  async latest(repo: string): Promise<HealthReport | null> {
    const list = await this.list(repo)
    if (!list[0]) return null
    return this.get(repo, list[0].id)
  }

  async setFindingStatus(repo: string, reportId: string, findingId: string, status: FindingStatus): Promise<HealthReport | null> {
    const r = await this.get(repo, reportId)
    if (!r) return null
    const f = r.findings.find((x) => x.id === findingId)
    if (!f) return null
    f.status = status
    r.summary = summarizeFindings(r.findings)
    await this.save(r)
    // invalidate cache entries for this repo
    for (const [k, e] of this.cache) if (e.report.repo === repo) this.cache.delete(k)
    return r
  }
}

export function contentHashOf(parts: string[]): string {
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16)
}

export function newReportId(): string {
  const t = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}-${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 6)}`
}
