/** 0.6.4 统一体检报告 · 发现项与报告数据模型 */

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type FindingCategory =
  | 'review' | 'static' | 'secret' | 'security' | 'architecture' | 'design' | 'harness' | 'tool' | 'hygiene' | 'wiki'
export type FindingSource = 'builtin' | 'ai' | 'ocr' | 'semgrep' | 'eslint' | 'wiki' | string
export type FindingConfidence = 'high' | 'medium' | 'low' | 'unknown'
export type FindingStatus = 'open' | 'fixed' | 'ignored' | 'false_positive'
export type HealthScopeKind = 'working' | 'staged' | 'refs' | 'repo' | 'project'
export type HealthCheckId = 'static' | 'secret' | 'ai' | 'ocr' | 'tools' | 'hygiene' | 'wiki' | 'design'

export interface FindingEvidence {
  path?: string
  line?: number
  endLine?: number
  sha?: string
  snippet?: string
}

export interface Finding {
  id: string
  severity: FindingSeverity
  category: FindingCategory
  title: string
  detail?: string
  evidence: FindingEvidence
  current?: string
  expected?: string
  impact?: string
  fix?: string
  verify?: string
  source: FindingSource
  confidence: FindingConfidence
  status: FindingStatus
  repo?: string
}

export interface HealthSummary {
  bySeverity: Record<FindingSeverity, number>
  byCategory: Partial<Record<FindingCategory, number>>
  open: number
  total: number
}

export interface HealthReport {
  id: string
  createdAt: number
  scope: HealthScopeKind
  repo?: string
  projectRoot?: string
  checksRun: HealthCheckId[]
  findings: Finding[]
  summary: HealthSummary
  durationMs: number
  cancelled?: boolean
  notes?: string[]
  contentHash?: string
}

export interface HealthRunOptions {
  repo: string
  projectRoot?: string
  scope?: HealthScopeKind
  checks?: HealthCheckId[]
  /** refs scope: base..head */
  base?: string
  head?: string
  reqId?: string
}

export interface HealthReportMeta {
  id: string
  createdAt: number
  scope: HealthScopeKind
  repo?: string
  summary: HealthSummary
  durationMs: number
  cancelled?: boolean
}

export const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info']
export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4
}
export const DEFAULT_CHECKS: HealthCheckId[] = ['static', 'secret', 'ai', 'ocr', 'tools', 'hygiene', 'wiki', 'design']
/** 默认全开其中「安全」的：无 AI/ocr 也能跑的项；ai/ocr 也默认勾选但无配置时跳过 */
export const SAFE_DEFAULT_CHECKS: HealthCheckId[] = ['static', 'secret', 'tools', 'hygiene', 'wiki', 'design', 'ai', 'ocr']

export const CHECK_LABELS: Record<HealthCheckId, string> = {
  static: '内置静态分析',
  secret: '密钥泄露扫描',
  ai: 'AI 审查',
  ocr: 'OpenCodeReview',
  tools: '工具状态',
  hygiene: '工作区卫生',
  wiki: 'Wiki Lint',
  design: '设计审查'
}

export const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  critical: '严重', high: '高', medium: '中', low: '低', info: '信息'
}

export const CATEGORY_LABELS: Record<FindingCategory, string> = {
  review: '审查', static: '静态', secret: '密钥', security: '安全',
  architecture: '架构', design: '设计', harness: 'Harness', tool: '工具',
  hygiene: '卫生', wiki: 'Wiki'
}

export function emptySummary(): HealthSummary {
  return {
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    byCategory: {},
    open: 0,
    total: 0
  }
}

export function summarizeFindings(findings: Finding[]): HealthSummary {
  const s = emptySummary()
  s.total = findings.length
  for (const f of findings) {
    s.bySeverity[f.severity]++
    s.byCategory[f.category] = (s.byCategory[f.category] ?? 0) + 1
    if (f.status === 'open') s.open++
  }
  return s
}

export function highestSeverity(findings: Finding[]): FindingSeverity | null {
  let best: FindingSeverity | null = null
  for (const f of findings) {
    if (f.status !== 'open') continue
    if (!best || SEVERITY_RANK[f.severity] < SEVERITY_RANK[best]) best = f.severity
  }
  return best
}

export function sortFindings(findings: Finding[]): Finding[] {
  return findings.slice().sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || a.category.localeCompare(b.category)
    || (a.evidence.path ?? '').localeCompare(b.evidence.path ?? '')
    || (a.evidence.line ?? 0) - (b.evidence.line ?? 0)
  )
}

export function reportToMarkdown(r: HealthReport): string {
  const lines: string[] = [
    `# GitLoom 体检报告`,
    '',
    `- 时间：${new Date(r.createdAt).toISOString()}`,
    `- 范围：${r.scope}${r.repo ? ` · ${r.repo}` : ''}`,
    `- 耗时：${r.durationMs} ms`,
    `- 检查项：${r.checksRun.map((c) => CHECK_LABELS[c] ?? c).join('、') || '（无）'}`,
    `- 发现：共 ${r.summary.total} 条（未关闭 ${r.summary.open}）· 严重 ${r.summary.bySeverity.critical} / 高 ${r.summary.bySeverity.high} / 中 ${r.summary.bySeverity.medium} / 低 ${r.summary.bySeverity.low} / 信息 ${r.summary.bySeverity.info}`,
    ''
  ]
  if (r.cancelled) lines.push('> 本次运行已取消，结果可能不完整。', '')
  if (r.notes?.length) {
    for (const n of r.notes) lines.push(`> ${n}`)
    lines.push('')
  }
  const sorted = sortFindings(r.findings)
  for (const sev of SEVERITY_ORDER) {
    const xs = sorted.filter((f) => f.severity === sev)
    if (!xs.length) continue
    lines.push(`## ${SEVERITY_LABELS[sev]}（${xs.length}）`, '')
    for (const f of xs) {
      const loc = f.evidence.path
        ? `\`${f.evidence.path}${f.evidence.line != null ? `:${f.evidence.line}` : ''}\``
        : ''
      lines.push(`### ${f.title}`)
      lines.push(`- 类别：${CATEGORY_LABELS[f.category] ?? f.category} · 来源：${f.source} · 置信度：${f.confidence} · 状态：${f.status}`)
      if (loc) lines.push(`- 位置：${loc}`)
      if (f.detail) lines.push(`- 说明：${f.detail}`)
      if (f.evidence.snippet) lines.push(`- 证据：\`${f.evidence.snippet.replace(/`/g, "'")}\``)
      if (f.current) lines.push(`- 现状：${f.current}`)
      if (f.expected) lines.push(`- 期望：${f.expected}`)
      if (f.impact) lines.push(`- 影响：${f.impact}`)
      if (f.fix) lines.push(`- 修复：${f.fix}`)
      if (f.verify) lines.push(`- 验证：${f.verify}`)
      lines.push('')
    }
  }
  if (!sorted.length) lines.push('未发现问题。', '')
  lines.push('---', '_由 GitLoom 体检引擎生成_')
  return lines.join('\n')
}

export function reportSummaryText(r: HealthReport): string {
  const h = highestSeverity(r.findings.filter((f) => f.status === 'open'))
  return [
    `体检 ${r.summary.total} 条（开 ${r.summary.open}）`,
    `严重${r.summary.bySeverity.critical}/高${r.summary.bySeverity.high}/中${r.summary.bySeverity.medium}/低${r.summary.bySeverity.low}/信息${r.summary.bySeverity.info}`,
    h ? `最高：${SEVERITY_LABELS[h]}` : '无未关闭问题',
    `范围 ${r.scope} · ${r.durationMs}ms`
  ].join(' · ')
}


/** 界面白话严重度（导出 Markdown 仍用 SEVERITY_LABELS） */
export const PLAIN_SEV: Record<FindingSeverity, string> = {
  critical: '严重', high: '严重', medium: '注意', low: '提示', info: '提示'
}

/** 0–100 健康分：未关闭问题越重分越低 */
export function healthScore(report: HealthReport): number {
  const open = report.findings.filter((f) => f.status === 'open')
  if (!open.length) return 100
  let deduct = 0
  for (const f of open) {
    if (f.severity === 'critical') deduct += 25
    else if (f.severity === 'high') deduct += 15
    else if (f.severity === 'medium') deduct += 8
    else if (f.severity === 'low') deduct += 3
    else deduct += 1
  }
  return Math.max(0, Math.min(100, 100 - deduct))
}

/** 几条白话结论，供质量页顶部摘要 */
export function plainConclusions(report: HealthReport): string[] {
  const open = report.findings.filter((f) => f.status === 'open')
  const lines: string[] = []
  if (!open.length) {
    lines.push('这轮没发现明显问题，可以继续写代码或提交。')
    if (report.cancelled) lines.push('体检中途取消过，结果可能不完整。')
    return lines
  }
  const secrets = open.filter((f) => f.category === 'secret').length
  const severe = open.filter((f) => f.severity === 'critical' || f.severity === 'high').length
  const medium = open.filter((f) => f.severity === 'medium').length
  if (secrets) lines.push(`有 ${secrets} 条像是密钥/口令泄露，提交前先处理。`)
  if (severe) lines.push(`有 ${severe} 条「严重」项，建议先看再提交。`)
  else if (medium) lines.push(`有 ${medium} 条「注意」项，抽空改一改更稳妥。`)
  const covered = secrets + severe + (severe ? 0 : medium)
  if (open.length > covered && lines.length < 3) lines.push('另有一些「提示」，可按需展开查看。')
  if (!lines.length) lines.push(`共 ${open.length} 条未关闭发现，展开下方详情查看。`)
  if (report.cancelled) lines.push('体检中途取消过，结果可能不完整。')
  return lines.slice(0, 4)
}


/** 发现项指纹：跨次体检比对「新增 / 已修好」用 */
export function findingFingerprint(f: Pick<Finding, 'category' | 'title' | 'evidence'>): string {
  const path = f.evidence.path ?? ''
  const line = f.evidence.line ?? ''
  return `${f.category}|${f.title}|${path}|${line}`
}

export interface HealthCompareResult {
  scoreNow: number
  scoreThen: number
  /** 当前分 − 对照分；正数=变好 */
  scoreDelta: number
  newCount: number
  fixedCount: number
  thenAt: number
  thenId: string
}

/** 比对照报告：分数差、新发现、已修好（均按未关闭项指纹） */
export function compareHealthReports(now: HealthReport, then: HealthReport): HealthCompareResult {
  const openNow = new Set(now.findings.filter((f) => f.status === 'open').map(findingFingerprint))
  const openThen = new Set(then.findings.filter((f) => f.status === 'open').map(findingFingerprint))
  let newCount = 0
  let fixedCount = 0
  for (const k of openNow) if (!openThen.has(k)) newCount++
  for (const k of openThen) if (!openNow.has(k)) fixedCount++
  const scoreNow = healthScore(now)
  const scoreThen = healthScore(then)
  return {
    scoreNow,
    scoreThen,
    scoreDelta: scoreNow - scoreThen,
    newCount,
    fixedCount,
    thenAt: then.createdAt,
    thenId: then.id
  }
}

const DAY = 86_400_000

/** 从历史元数据里挑「上次」（非当前最新）与「约一周前」的报告 id */
export function pickCompareTargets(
  metas: { id: string; createdAt: number }[],
  opts: { now?: number; latestId?: string } = {}
): { previousId: string | null; weekAgoId: string | null } {
  const now = opts.now ?? Date.now()
  const sorted = metas.slice().sort((a, b) => b.createdAt - a.createdAt)
  const rest = opts.latestId ? sorted.filter((m) => m.id !== opts.latestId) : sorted.slice(1)
  const previousId = rest[0]?.id ?? null
  const weekTarget = now - 7 * DAY
  const older = sorted.filter((m) => m.createdAt <= now - 6 * DAY)
  if (!older.length) return { previousId, weekAgoId: null }
  let best = older[0]
  let bestDist = Math.abs(best.createdAt - weekTarget)
  for (const m of older) {
    const d = Math.abs(m.createdAt - weekTarget)
    if (d < bestDist) { best = m; bestDist = d }
  }
  return { previousId, weekAgoId: best.id }
}

/** 白话一句：分数涨了/掉了、新问题、修好了多少 */
export function plainCompareLine(kind: '上次' | '上周', c: HealthCompareResult): string {
  const delta = c.scoreDelta
  const scoreBit = delta === 0
    ? `分数还是 ${c.scoreNow} 分`
    : delta > 0
      ? `分数 ${c.scoreThen} → ${c.scoreNow}（好了 ${delta} 分）`
      : `分数 ${c.scoreThen} → ${c.scoreNow}（差了 ${Math.abs(delta)} 分）`
  const parts = [`比${kind}：${scoreBit}`]
  if (c.newCount) parts.push(`新发现 ${c.newCount} 条`)
  if (c.fixedCount) parts.push(`已好转/消失 ${c.fixedCount} 条`)
  if (!c.newCount && !c.fixedCount) parts.push('未关闭项没变')
  return parts.join(' · ')
}
