// 主动安全扫描: deterministic static rules first (every finding has file + line), dependency audit, then (optionally)
// AI judges real exploitability. Secrets are masked everywhere. Fix suggestions only — nothing is modified.
import { createHash } from 'crypto'
import type { Tools } from './tools'

export type Level = '高' | '中' | '低'
export interface Finding { key: string; rule: string; category: string; title: string; file: string; line: number; excerpt: string; level: Level; fix: string; reason?: string; isNew?: boolean; repo?: string }
interface Rule { id: string; category: string; title: string; re: RegExp; level: Level; fix: string; exts?: RegExp; secret?: boolean }

const CODE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|java|kt|rb|php|cs|rs|scala|vue|svelte)$/i
const RULES: Rule[] = [
  { id: 'secret-aws', category: '硬编码密钥', title: 'AWS 访问密钥', re: /\bAKIA[0-9A-Z]{16}\b/, level: '高', fix: '立即吊销该密钥，改为从环境变量或密钥管理服务读取，并从 Git 历史中清除。', secret: true },
  { id: 'secret-pk', category: '硬编码密钥', title: '私钥文件内容', re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, level: '高', fix: '把私钥移出仓库，改用密钥管理；视为已泄露并轮换。', secret: true },
  { id: 'secret-token', category: '硬编码密钥', title: '平台令牌', re: /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{24,}|glpat-[A-Za-z0-9_-]{20})\b/, level: '高', fix: '吊销令牌并改为运行时注入（环境变量 / 密钥管理）。', secret: true },
  { id: 'secret-assign', category: '硬编码密钥', title: '代码中写死的密码/密钥', re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i, level: '中', fix: '改为从环境变量或配置中心读取，不要提交到仓库。', secret: true },
  { id: 'cmd-concat', category: '命令拼接', title: '用拼接的字符串执行系统命令', re: /\b(exec|execSync|spawnSync|os\.system|os\.popen|subprocess\.(call|run|Popen|check_output)|Runtime\.getRuntime\(\)\.exec|shell_exec|system|passthru)\s*\(\s*(f["']|`[^`]*\$\{|["'][^"']*["']\s*\+|\w+\s*\+|.*\bshell\s*=\s*True)/, level: '高', fix: '改用参数数组调用（不经过 shell），并对外部输入做白名单校验。', exts: CODE },
  { id: 'sql-concat', category: 'SQL 拼接', title: '用拼接字符串构造 SQL', re: /(["'`]\s*(SELECT|INSERT|UPDATE|DELETE)\b[^"'`]*\b(FROM|INTO|SET|WHERE)\b[^"'`]*(["']+\s*\+|\$\{|%s["']\s*%|\{[a-z_]+\}))|(\b(query|execute|exec|raw)\s*\(\s*f["'](SELECT|INSERT|UPDATE|DELETE))/i, level: '高', fix: '改用参数化查询（占位符 ? / $1 / :name），不要拼接用户输入。', exts: CODE },
  { id: 'deser', category: '不安全反序列化', title: '反序列化不可信数据', re: /\b(pickle\.loads?|cPickle\.loads?|marshal\.loads|yaml\.load\s*\((?![^)]*SafeLoader)|yaml\.unsafe_load|unserialize\s*\(|ObjectInputStream\s*\(|Marshal\.load|BinaryFormatter\s*\(\s*\)\.Deserialize|node-serialize|\.unserialize\()/, level: '高', fix: '改用 JSON 等安全格式；Python 用 yaml.safe_load；不要反序列化来自外部的数据。', exts: CODE },
  { id: 'eval', category: '不安全反序列化', title: '执行动态代码 (eval)', re: /(^|[^\w.])(eval|new Function)\s*\(\s*(req|request|params|input|data|body|query|argv|process\.argv)/, level: '高', fix: '不要对外部输入调用 eval / new Function，改用 JSON.parse 或白名单分派。', exts: CODE },
  { id: 'path-trav', category: '路径穿越', title: '用请求参数直接拼文件路径', re: /\b(readFile(Sync)?|createReadStream|sendFile|open|send_file|unlink(Sync)?|writeFile(Sync)?|path\.join|os\.path\.join|res\.download)\s*\([^)]*\b(req\.(query|params|body)|request\.(args|form|GET|POST|query_params)|params\[)/, level: '高', fix: '用 path.resolve 后校验结果仍在允许的目录内（或用白名单文件名），拒绝包含 .. 的路径。', exts: CODE }
]
const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|\.git|third_party|coverage|__snapshots__)\//
const TESTY = /(^|\/)(tests?|__tests__|spec|fixtures?|e2e|examples?)\//i

export function mask(line: string): string {
  return line.replace(/(["'])([^"']{6,})\1/g, (_m, q, v: string) => `${q}${v.slice(0, 2)}${'*'.repeat(Math.min(12, v.length - 4))}${v.slice(-2)}${q}`)
    .replace(/\b(AKIA[0-9A-Z]{2})[0-9A-Z]{14}\b/g, '$1**************').replace(/\b(ghp_|github_pat_|xox[abprs]-|sk-|glpat-)[A-Za-z0-9_-]{6,}/g, '$1********')
}
const keyOf = (rule: string, file: string, text: string) => createHash('sha1').update(`${rule}|${file}|${text.trim().replace(/\s+/g, ' ')}`).digest('hex').slice(0, 16)

/** pure: scan one file's text */
export function scanText(file: string, text: string): Finding[] {
  if (SKIP.test(file) || /\.(min\.js|map|lock|svg|png|jpg|gif|ico|pdf|zip|woff2?)$/i.test(file)) return []
  const out: Finding[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.length > 2000) continue
    for (const r of RULES) {
      if (r.exts && !r.exts.test(file)) continue
      if (!r.re.test(l)) continue
      if (r.id === 'secret-assign' && /(example|placeholder|changeme|your[_-]|xxx|\*\*\*|<.*>|\$\{|process\.env|os\.environ|getenv)/i.test(l)) continue
      const lvl: Level = TESTY.test(file) && r.level === '高' ? '中' : r.level
      out.push({ key: keyOf(r.id, file, l), rule: r.id, category: r.category, title: r.title, file, line: i + 1, excerpt: mask(l.trim()).slice(0, 200), level: lvl, fix: r.fix })
    }
  }
  return out
}
/** npm audit JSON (v7+) → high/critical findings located at the package's line in package.json / package-lock.json */
export function auditFindings(json: unknown, manifest: string | null, lock: string | null): Finding[] {
  const vulns = (json as { vulnerabilities?: Record<string, { severity: string; via: unknown[]; fixAvailable?: unknown; isDirect?: boolean }> })?.vulnerabilities ?? {}
  const out: Finding[] = []
  for (const [name, v] of Object.entries(vulns)) {
    if (v.severity !== 'high' && v.severity !== 'critical') continue
    const where = (txt: string | null, f: string) => { if (!txt) return null; const i = txt.split('\n').findIndex((l) => l.includes(`"${name}"`) || l.includes(`node_modules/${name}"`)); return i >= 0 ? { file: f, line: i + 1 } : null }
    const loc = where(manifest, 'package.json') ?? where(lock, 'package-lock.json')
    if (!loc) continue // every finding must have file + line
    const adv = (v.via ?? []).find((x) => typeof x === 'object') as { title?: string; url?: string } | undefined
    out.push({ key: keyOf('dep', name, v.severity), rule: 'dep-vuln', category: '高危依赖漏洞', title: `${name}：${adv?.title ?? '已知高危漏洞'}`, file: loc.file, line: loc.line, excerpt: `${name}（${v.severity === 'critical' ? '严重' : '高危'}）${adv?.url ? ` ${adv.url}` : ''}`, level: v.severity === 'critical' ? '高' : '中', fix: v.fixAvailable ? '升级到已修复的版本（npm audit 显示有可用修复）。' : '暂无官方修复：评估是否替换该依赖或隔离使用。' })
  }
  return out
}
/** pure: mark findings not present in the previous run as new */
export function diffFindings(cur: Finding[], prevKeys: string[] | null): Finding[] {
  const prev = new Set(prevKeys ?? [])
  return cur.map((f) => ({ ...f, isNew: prevKeys === null ? true : !prev.has(f.key) }))
}
const ORDER: Record<Level, number> = { 高: 0, 中: 1, 低: 2 }
export const rank = (fs: Finding[]) => fs.slice().sort((a, b) => ORDER[a.level] - ORDER[b.level] || Number(!!b.isNew) - Number(!!a.isNew) || a.file.localeCompare(b.file) || a.line - b.line)

export async function scanRepo(t: Tools, repo: string, withAudit = true): Promise<{ findings: Finding[]; notes: string[]; files: number }> {
  const ls = (await t.git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout.split('\0').filter(Boolean)
  const findings: Finding[] = []
  let n = 0
  for (const f of ls) {
    if (SKIP.test(f)) continue
    const txt = await t.read(repo, f)
    if (txt === null || txt.includes('\0')) continue
    n++
    findings.push(...scanText(f, txt))
  }
  const notes: string[] = []
  if (withAudit) {
    const a = await t.audit(repo)
    if (a.ok) findings.push(...auditFindings(a.json, await t.read(repo, 'package.json'), await t.read(repo, 'package-lock.json', 20 * 1024 * 1024)))
    else if (a.note) notes.push(a.note)
  }
  return { findings, notes, files: n }
}
export function securityMarkdown(fs: Finding[], notes: string[], multi: boolean, aiNote: string): string {
  const r = rank(fs)
  const high = r.filter((f) => f.level === '高').length
  const fresh = r.filter((f) => f.isNew)
  const head = `## 本次 ${r.length} 条，其中高危 ${high} 条`
  const body: string[] = [head, '']
  if (!fresh.length) body.push('**本次未发现新增风险**', '')
  for (const lvl of ['高', '中', '低'] as Level[]) {
    const xs = r.filter((f) => f.level === lvl)
    if (!xs.length) continue
    body.push(`### ${lvl === '高' ? '高危' : lvl === '中' ? '中危' : '低危'}（${xs.length}）`, '')
    for (const f of xs) body.push(`- ${f.isNew ? '**本周新增** · ' : ''}**${f.category}** · ${f.title} — \`${multi && f.repo ? `${f.repo.split(/[\\/]/).pop()}/` : ''}${f.file}:${f.line}\``, `  - 代码：\`${f.excerpt.replace(/`/g, "'")}\``, ...(f.reason ? [`  - 判断：${f.reason}`] : []), `  - 修复建议：${f.fix}`)
    body.push('')
  }
  if (aiNote) body.push(`> ${aiNote}`)
  for (const n of notes) body.push(`> ${n}`)
  body.push('> 只给修复建议，不会修改任何代码。')
  return body.join('\n')
}
