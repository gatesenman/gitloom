/** 将 AI 审查文本解析/映射为 Finding[] */
import { createHash } from 'crypto'
import type { Finding, FindingSeverity } from '../../shared/health'

function fid(...p: string[]): string {
  return 'ai-' + createHash('sha1').update(p.join('|')).digest('hex').slice(0, 12)
}

function parseSeverity(s: string): FindingSeverity {
  const t = s.toLowerCase()
  if (/critical|严重|阻断/.test(t)) return 'critical'
  if (/high|高危|高\b|major/.test(t)) return 'high'
  if (/medium|中危|中\b|moderate/.test(t)) return 'medium'
  if (/low|低危|低\b|minor/.test(t)) return 'low'
  if (/info|信息|建议|nit/.test(t)) return 'info'
  return 'medium'
}

const LOC = /[`(]?([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)(?::(\d+))?[`)]?/

/** 尝试从 Markdown 审查意见中抽取结构化发现；失败则生成摘要级发现 */
export function parseAiReview(text: string, repo?: string): Finding[] {
  const out: Finding[] = []
  const chunks = text.split(/\n(?=#{1,3}\s|(?:^|\n)[-*]\s+\*\*|^\d+\.\s)/m).map((s) => s.trim()).filter((s) => s.length > 12)
  for (const chunk of chunks.slice(0, 40)) {
    const sevM = /(?:严重级别|severity|级别|等级)[:：\s]*[*`]*(critical|high|medium|low|info|严重|高危|高|中危|中|低危|低|信息|建议)[*`]*/i.exec(chunk)
      || /^#{1,3}\s*\[?(critical|high|medium|low|info|严重|高|中|低|信息)\]?/i.exec(chunk)
      || /\*\*(critical|high|medium|low|严重|高危|中危|低危)\*\*/i.exec(chunk)
    const locM = /(?:文件|位置|path|file)[:：\s]*[`(]?([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)(?::(\d+))?/i.exec(chunk) || LOC.exec(chunk)
    const titleLine = chunk.split(/\n/).find((l) => l.replace(/^#+\s*/, '').trim().length > 4) || chunk.slice(0, 80)
    const title = titleLine.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').replace(/\*\*/g, '').trim().slice(0, 120)
    if (!sevM && !locM && chunk.length < 40) continue
    // skip pure headers like "审查总结"
    if (/^(审查|总结|概述|summary|overview)/i.test(title) && !locM) continue
    const severity = sevM ? parseSeverity(sevM[1]) : (locM ? 'medium' : 'info')
    const path = locM?.[1]
    const line = locM?.[2] ? Number(locM[2]) : undefined
    out.push({
      id: fid(title, path || '', String(line || 0)),
      severity,
      category: 'review',
      title: title.slice(0, 100) || 'AI 审查意见',
      detail: chunk.slice(0, 800),
      evidence: path ? { path, line, snippet: chunk.split(/\n/).find((l) => l.includes(path))?.trim().slice(0, 160) } : {},
      source: 'ai',
      confidence: locM ? 'medium' : 'low',
      status: 'open',
      repo
    })
  }
  if (!out.length && text.trim()) {
    out.push({
      id: fid('summary', text.slice(0, 200)),
      severity: 'info',
      category: 'review',
      title: 'AI 审查摘要',
      detail: text.slice(0, 2000),
      evidence: {},
      source: 'ai',
      confidence: 'low',
      status: 'open',
      repo
    })
  }
  return out
}
