/** QA-4 P0：密钥泄露扫描（误报可控；匹配行进 evidence；snippet 已脱敏） */
import { createHash } from 'crypto'
import type { Finding, FindingSeverity } from '../../shared/health'

interface SecretRule {
  id: string
  title: string
  re: RegExp
  severity: FindingSeverity
  fix: string
}

const RULES: SecretRule[] = [
  { id: 'secret-aws', title: '疑似 AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/, severity: 'critical', fix: '立即吊销该密钥，改为环境变量或密钥管理服务，并清理 Git 历史。' },
  { id: 'secret-pk', title: '疑似私钥内容', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |OPENSSH )?PRIVATE KEY-----/, severity: 'critical', fix: '将私钥移出仓库并轮换；视为已泄露。' },
  { id: 'secret-gh', title: '疑似 GitHub PAT', re: /\b(ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/, severity: 'critical', fix: '在 GitHub 吊销该令牌，改为 CI/本地密钥注入。' },
  { id: 'secret-openai', title: '疑似 OpenAI / 同类 API Key', re: /\bsk-[A-Za-z0-9]{20,}\b/, severity: 'high', fix: '吊销并改为环境变量；勿提交到仓库。' },
  { id: 'secret-slack', title: '疑似 Slack Token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, severity: 'high', fix: '在 Slack 吊销该令牌并轮换。' },
  { id: 'secret-gl', title: '疑似 GitLab Token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/, severity: 'high', fix: '在 GitLab 吊销该令牌并改为密钥注入。' },
  { id: 'secret-assign', title: '代码中写死的密码/密钥赋值', re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i, severity: 'medium', fix: '改为从环境变量或配置中心读取。' }
]

const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|\.git|third_party|coverage|__snapshots__)\//
const TESTY = /(^|\/)(tests?|__tests__|spec|fixtures?|e2e|examples?)\//i
const BIN = /\.(min\.js|map|lock|svg|png|jpg|gif|ico|pdf|zip|woff2?|wasm)$/i

export function maskSecret(line: string): string {
  return line
    .replace(/(["'])([^"']{6,})\1/g, (_m, q, v: string) => `${q}${v.slice(0, 2)}${'*'.repeat(Math.min(12, v.length - 4))}${v.slice(-2)}${q}`)
    .replace(/\b(AKIA[0-9A-Z]{2})[0-9A-Z]{14}\b/g, '$1**************')
    .replace(/\b(ghp_|github_pat_|xox[abprs]-|sk-|glpat-)[A-Za-z0-9_-]{6,}/g, '$1********')
}

function fid(rule: string, file: string, text: string): string {
  return 'sec-' + createHash('sha1').update(`${rule}|${file}|${text.trim().replace(/\s+/g, ' ')}`).digest('hex').slice(0, 12)
}

/** 扫描单个文件文本 → Finding[]（纯函数，可单测） */
export function scanSecretsInText(file: string, text: string, repo?: string): Finding[] {
  if (SKIP.test(file) || BIN.test(file)) return []
  const out: Finding[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.length > 2000) continue
    for (const r of RULES) {
      if (!r.re.test(l)) continue
      // reset lastIndex for global-ish reuse
      r.re.lastIndex = 0
      if (r.id === 'secret-assign' && /(example|placeholder|changeme|your[_-]|xxx|\*\*\*|<.*>|\$\{|process\.env|os\.environ|getenv)/i.test(l)) continue
      let sev = r.severity
      if (TESTY.test(file) && (sev === 'critical' || sev === 'high')) sev = 'medium'
      out.push({
        id: fid(r.id, file, l),
        severity: sev,
        category: 'secret',
        title: r.title,
        detail: `规则 ${r.id} 在 ${file}:${i + 1} 命中`,
        evidence: { path: file, line: i + 1, snippet: maskSecret(l.trim()).slice(0, 200) },
        fix: r.fix,
        verify: '确认该值非真实密钥，或已吊销并改用密钥注入后，将本条标为已修复/误报。',
        source: 'builtin',
        confidence: r.id === 'secret-assign' ? 'medium' : 'high',
        status: 'open',
        repo
      })
    }
  }
  return out
}

/** 从 unified diff 中扫新增行（+ 开头，非 +++） */
export function scanSecretsInDiff(diff: string, repo?: string): Finding[] {
  const out: Finding[] = []
  let file = ''
  let newLine = 0
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('+++ b/')) { file = raw.slice(6).trim(); newLine = 0; continue }
    if (raw.startsWith('+++ ')) { file = raw.slice(4).trim(); if (file.startsWith('b/')) file = file.slice(2); newLine = 0; continue }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) { newLine = Number(hunk[1]); continue }
    if (!file || file === '/dev/null') continue
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const text = raw.slice(1)
      const hits = scanSecretsInText(file, text, repo)
      for (const h of hits) {
        h.evidence.line = newLine || h.evidence.line
        h.id = fid(h.title, file, `${newLine}|${text}`)
        out.push(h)
      }
      newLine++
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      /* deleted line — skip */
    } else if (!raw.startsWith('\\')) {
      newLine++
    }
  }
  return out
}

export const SECRET_RULE_IDS = RULES.map((r) => r.id)
