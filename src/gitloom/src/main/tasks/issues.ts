// 线上问题日志日报: generic HTTP/JSON issue-platform connector. Full fetch (all pages, no sampling), keyword match,
// AI groups root causes; anything not confidently grouped goes to 待人工确认. Token is never logged or rendered.
import { redact } from './readonly'

export const KEYWORDS = ['卡顿', '卡死', '崩溃', '闪退', '无响应']
export interface IssueConnector { url: string; token: string; authHeader: string }
export interface Ticket { id: string; title: string; content: string }
export interface RootCause { cause: string; ids: string[]; conclusion: string; suspect?: { symbol: string; file?: string; line?: number } }

export const connectorReady = (c: Partial<IssueConnector> | null | undefined): boolean => !!c?.url && /^https?:\/\//i.test(c.url)
export function yesterday(now = new Date()): { since: Date; until: Date; label: string } {
  const until = new Date(now); until.setHours(0, 0, 0, 0)
  const since = new Date(until.getTime() - 86400000)
  return { since, until, label: since.toLocaleDateString('zh-CN') }
}
/** URL for one page: {since} {until} {page} {pageSize} placeholders, otherwise appended as query params */
export function pageUrl(base: string, since: Date, until: Date, page: number, pageSize: number): string {
  const vals: Record<string, string> = { since: since.toISOString(), until: until.toISOString(), page: String(page), pageSize: String(pageSize) }
  if (/\{(since|until|page|pageSize)\}/.test(base)) return base.replace(/\{(since|until|page|pageSize)\}/g, (_m, k: string) => encodeURIComponent(vals[k]))
  const u = new URL(base)
  for (const [k, v] of Object.entries(vals)) if (!u.searchParams.has(k)) u.searchParams.set(k, v)
  return u.toString()
}
export function parseTickets(json: unknown): Ticket[] {
  const arr = Array.isArray(json) ? json : (['items', 'data', 'list', 'records', 'issues', 'results', 'rows'].map((k) => (json as Record<string, unknown>)?.[k]).find(Array.isArray) as unknown[] | undefined) ?? ((json as { data?: Record<string, unknown> })?.data && ['items', 'list', 'records'].map((k) => (json as { data: Record<string, unknown> }).data[k]).find(Array.isArray) as unknown[] | undefined) ?? []
  return arr.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>
    const s = (k: string[]) => { for (const kk of k) if (o[kk] !== undefined && o[kk] !== null) return String(o[kk]); return '' }
    return { id: s(['id', 'key', 'number', 'ticketId', 'issueId', 'uuid']), title: s(['title', 'summary', 'subject', 'name']), content: s(['content', 'description', 'body', 'message', 'detail', 'log', 'stack']) }
  }).filter((t) => t.id)
}
export const matches = (t: Ticket, kw = KEYWORDS) => kw.some((k) => t.title.includes(k) || t.content.includes(k))

export type Fetcher = (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
/** fetch every page until a short/empty page or the platform repeats itself (no pagination support) */
export async function fetchAll(c: IssueConnector, since: Date, until: Date, f: Fetcher, pageSize = 100, maxPages = 500): Promise<Ticket[]> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (c.token) { const h = c.authHeader?.trim() || 'Authorization'; headers[h] = h.toLowerCase() === 'authorization' && !/^\w+\s/.test(c.token) ? `Bearer ${c.token}` : c.token }
  const all: Ticket[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= maxPages; page++) {
    let r: Awaited<ReturnType<Fetcher>>
    try { r = await f(pageUrl(c.url, since, until, page, pageSize), headers) } catch (e) { throw new Error(redact(`请求问题平台失败：${(e as Error).message}`, [c.token])) }
    if (!r.ok) throw new Error(`问题平台返回 HTTP ${r.status}`)
    const items = parseTickets(await r.json())
    const fresh = items.filter((t) => !seen.has(t.id))
    for (const t of fresh) { seen.add(t.id); all.push(t) }
    if (!fresh.length || items.length < pageSize) break
  }
  return all
}
export function issuesMarkdown(hits: Ticket[], causes: RootCause[], label: string, note = ''): string {
  if (!hits.length) return `## 昨日无命中上报\n\n${label} 的上报中没有包含「${KEYWORDS.join('/')}」的记录。`
  const grouped = new Set(causes.flatMap((c) => c.ids))
  const pending = hits.filter((h) => !grouped.has(h.id))
  const out = [`## 昨日命中 ${hits.length} 条 / 分成 ${causes.length} 类根因`, '', `统计日期：${label}；关键词：${KEYWORDS.join('、')}；全量拉取，未抽样。`, '']
  causes.slice().sort((a, b) => b.ids.length - a.ids.length).forEach((c, i) => {
    out.push(`### ${i + 1}. ${c.cause}（${c.ids.length} 条）`, `- 样例单号：\`${c.ids[0]}\``, `- 结论：${c.conclusion}`,
      `- 可疑位置：${c.suspect?.file ? `\`${c.suspect.file}:${c.suspect.line}\` · \`${c.suspect.symbol}\`` : c.suspect?.symbol ? `\`${c.suspect.symbol}\`（仓库中未找到，需人工确认）` : '未定位'}`, '')
  })
  if (pending.length) out.push(`### 待人工确认（${pending.length} 条）`, ...pending.slice(0, 50).map((p) => `- \`${p.id}\` ${p.title.slice(0, 80)}`), ...(pending.length > 50 ? [`- …另有 ${pending.length - 50} 条`] : []), '')
  if (note) out.push(`> ${note}`)
  out.push('> 只做分析，不会修改问题平台或代码。')
  return out.join('\n')
}
