/** .gitignore 解析与「为何忽略」说明（配合 git check-ignore -v） */
export interface IgnoreLine {
  line: number
  raw: string
  pattern?: string
  negated?: boolean
  comment?: boolean
  blank?: boolean
}

export interface IgnoreSource {
  /** 相对仓库根，或绝对路径（global / exclude） */
  path: string
  /** 白话来源名 */
  label: string
  lines: IgnoreLine[]
}

export function parseIgnoreContent(text: string): IgnoreLine[] {
  const lines = text.split(/\r?\n/)
  const out: IgnoreLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed) {
      out.push({ line: i + 1, raw, blank: true })
      continue
    }
    if (trimmed.startsWith('#')) {
      out.push({ line: i + 1, raw, comment: true })
      continue
    }
    const negated = trimmed.startsWith('!')
    const pattern = negated ? trimmed.slice(1) : trimmed
    out.push({ line: i + 1, raw, pattern, negated })
  }
  return out
}

/** git check-ignore -v 输出：source:line:pattern\tpath */
export function parseCheckIgnoreVerbose(stdout: string): {
  ignored: boolean
  source?: string
  line?: number
  pattern?: string
  path?: string
} {
  const t = stdout.trim()
  if (!t) return { ignored: false }
  // 可能多行；取最后一条有效
  const rows = t.split(/\r?\n/).filter(Boolean)
  const last = rows[rows.length - 1]
  // format: <source>:<lnum>:<pattern>\t<path>
  const m = /^([^:]+):(\d+):(.*)\t(.+)$/.exec(last)
  if (!m) return { ignored: true, pattern: last }
  return {
    ignored: true,
    source: m[1],
    line: Number(m[2]),
    pattern: m[3],
    path: m[4]
  }
}

export function explainIgnore(r: {
  ignored: boolean
  source?: string
  line?: number
  pattern?: string
}): string {
  if (!r.ignored) return '该路径当前不会被忽略（未被任何有效规则命中）。'
  const where = r.source ? `${r.source}${r.line != null ? ` 第 ${r.line} 行` : ''}` : '某条忽略规则'
  const pat = r.pattern ? `规则「${r.pattern}」` : '规则'
  return `会被忽略：命中 ${where} 的 ${pat}。`
}
