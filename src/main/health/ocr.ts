/** QA-2：若 detectTools 找到 ocr，尝试调用并解析 JSON→Finding；失败回退说明 */
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import type { Finding, FindingSeverity } from '../../shared/health'
import { ocrExecutable } from '../tools/detect'

function fid(...p: string[]): string {
  return 'ocr-' + createHash('sha1').update(p.join('|')).digest('hex').slice(0, 12)
}

function sev(s: unknown): FindingSeverity {
  const t = String(s || '').toLowerCase()
  if (/critical|error|严重/.test(t)) return 'critical'
  if (/high|高/.test(t)) return 'high'
  if (/medium|warn|中/.test(t)) return 'medium'
  if (/low|低/.test(t)) return 'low'
  return 'info'
}

export function parseOcrJson(raw: string, repo?: string): Finding[] {
  let data: unknown
  try { data = JSON.parse(raw) } catch {
    // try extract JSON block
    const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(raw)
    if (!m) return []
    try { data = JSON.parse(m[0]) } catch { return [] }
  }
  const list: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { findings?: unknown }).findings)
      ? (data as { findings: unknown[] }).findings
      : Array.isArray((data as { issues?: unknown }).issues)
        ? (data as { issues: unknown[] }).issues
        : Array.isArray((data as { results?: unknown }).results)
          ? (data as { results: unknown[] }).results
          : []
  const out: Finding[] = []
  for (const item of list.slice(0, 100)) {
    const o = item as Record<string, unknown>
    const title = String(o.title || o.message || o.rule || o.check || 'OCR 发现').slice(0, 120)
    const path = (o.path || o.file || o.filename || (o.location as { path?: string })?.path) as string | undefined
    const line = Number(o.line || o.startLine || (o.location as { line?: number })?.line || 0) || undefined
    out.push({
      id: fid(title, path || '', String(line || 0)),
      severity: sev(o.severity || o.level || o.priority),
      category: 'review',
      title,
      detail: String(o.detail || o.description || o.body || '').slice(0, 1000) || undefined,
      evidence: { path, line, snippet: String(o.snippet || o.code || '').slice(0, 200) || undefined },
      fix: o.fix ? String(o.fix) : undefined,
      source: 'ocr',
      confidence: 'medium',
      status: 'open',
      repo
    })
  }
  return out
}

export async function runOcr(repo: string, signal?: AbortSignal): Promise<{ findings: Finding[]; note?: string }> {
  const tryArgs = [
    ['--json', '.'],
    ['review', '--json', '.'],
    ['--format', 'json', '.']
  ]
  for (const args of tryArgs) {
    if (signal?.aborted) return { findings: [], note: '已取消' }
    const r = await spawnCapture(ocrExecutable(), args, repo, 60000, signal)
    if (r.code === 0 && r.out.trim()) {
      const findings = parseOcrJson(r.out, repo)
      if (findings.length) return { findings }
      if (r.out.trim().startsWith('{') || r.out.trim().startsWith('[')) {
        return { findings: [], note: 'ocr 已运行但未解析到发现项' }
      }
    }
  }
  return { findings: [], note: 'ocr 调用失败或输出无法解析，已跳过（可改用 AI 审查）' }
}

function spawnCapture(cmd: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const fin = (code: number | null) => { if (!done) { done = true; resolve({ code, out }) } }
    try {
      const useShell = process.platform === 'win32' && (/\.cmd$/i.test(cmd) || !/[\\/]/.test(cmd))
      const c = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: useShell, windowsHide: true })
      const t = setTimeout(() => { c.kill(); fin(null) }, timeoutMs)
      const onAbort = () => { c.kill(); clearTimeout(t); fin(null) }
      signal?.addEventListener('abort', onAbort, { once: true })
      c.stdout?.on('data', (d) => { out += d })
      c.stderr?.on('data', (d) => { out += d })
      c.on('error', () => { clearTimeout(t); fin(null) })
      c.on('close', (code) => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); fin(code) })
    } catch { fin(null) }
  })
}
