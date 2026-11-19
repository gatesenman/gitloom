/** 设计债静态扫描：硬编码颜色、内联样式、令牌漂移提示 → Finding(category=design) */
import { createHash } from 'crypto'
import type { Finding, FindingSeverity } from '../../shared/health'

const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|\.git|coverage)(\/|$)/
const UI_EXT = /\.(css|scss|sass|less|tsx|jsx|vue|svelte|html)$/i
const STYLE_ATTR = /\.(tsx|jsx|vue|svelte|html)$/i

function fid(...parts: string[]): string {
  return 'des-' + createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12)
}

/** 常见硬编码色：#rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / hsl() */
const HEX_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g
const RGB_RE = /\brgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?(?:\s*,\s*[\d.]+%?)?\s*\)/gi
const HSL_RE = /\bhsla?\(\s*[\d.]+%?\s*,\s*[\d.]+%\s*,\s*[\d.]+%(?:\s*,\s*[\d.]+%?)?\s*\)/gi

/** style={{ ... }} 或 style="..." 内联样式 */
const INLINE_JSX = /\bstyle=\{\{[\s\S]*?\}\}/g
const INLINE_HTML = /\bstyle\s*=\s*("[^"]*"|'[^']*')/gi

/** 随意像素间距（可能应使用设计令牌）——排除 0/1px 边框等 */
const PX_SPACE = /(?:padding|margin|gap|top|left|right|bottom|width|height|font-size)\s*[:=]\s*['"]?(\d{2,3})px/gi

/** 已知设计令牌色值（来自 GitLoom DESIGN.md / styles.css）——出现字面量时提示改用 var(--token) */
export const KNOWN_TOKEN_COLORS: Record<string, string> = {
  '#111216': '--bg',
  '#0d0e12': '--bg2',
  '#15161b': '--sidebar',
  '#18191f': '--panel',
  '#1e2027': '--panel2',
  '#252731': '--panel3',
  '#7b74ff': '--accent',
  '#8e88ff': '--accent-hover',
  '#a29dff': '--accent-text',
  '#ececf1': '--text',
  '#c5c6d0': '--text2',
  '#9b9daa': '--muted',
  '#7c7f8c': '--faint',
  '#2ec4c9': '--cyan / 远程色'
}

const ALLOW_HEX_IN_COMMENT = /^\s*(\/\/|\*|\/\*|#|--)/
/** 允许的「系统」色：透明、纯白/黑用于阴影合成等 */
const ALLOW_HEX = new Set(['#000', '#000000', '#fff', '#ffffff', '#0000', '#00000000', '#ffffffff'])

function normalizeHex(h: string): string {
  const s = h.toLowerCase()
  if (s.length === 4) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]
  if (s.length === 5) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3] + s[4] + s[4]
  return s.slice(0, 7)
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length
}

function lineText(text: string, line: number): string {
  return text.split(/\r?\n/)[line - 1] ?? ''
}

function mk(
  severity: FindingSeverity,
  title: string,
  detail: string,
  file: string,
  line: number,
  snippet: string,
  fix: string,
  repo?: string,
  extra?: Partial<Finding>
): Finding {
  return {
    id: fid(title, file, String(line), snippet.slice(0, 40)),
    severity,
    category: 'design',
    title,
    detail,
    evidence: { path: file, line, snippet: snippet.trim().slice(0, 160) },
    impact: '设计一致性与可维护性下降，主题切换/令牌更新时易漏改',
    fix,
    verify: '改用设计令牌或共享样式后本条应消失',
    source: 'builtin',
    confidence: 'medium',
    status: 'open',
    repo,
    ...extra
  }
}

export interface DesignScanFile { path: string; text: string }

/** 扫描单文件设计债 */
export function scanDesignDebtInText(file: string, text: string, repo?: string): Finding[] {
  const norm = file.replace(/\\/g, '/')
  if (SKIP.test(norm) || !UI_EXT.test(norm)) return []
  if (text.includes('\0') || text.length > 900_000) return []
  const out: Finding[] = []
  const seen = new Set<string>()

  const push = (f: Finding) => {
    if (seen.has(f.id)) return
    seen.add(f.id)
    out.push(f)
  }

  // 硬编码颜色
  const colorRes = [HEX_RE, RGB_RE, HSL_RE]
  for (const re of colorRes) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const raw = m[0]
      const line = lineOf(text, m.index)
      const lt = lineText(text, line)
      if (ALLOW_HEX_IN_COMMENT.test(lt)) continue
      if (re === HEX_RE) {
        const n = normalizeHex(raw)
        if (ALLOW_HEX.has(n) || ALLOW_HEX.has(raw.toLowerCase())) continue
        // CSS 变量定义行里的色值是令牌源头，跳过
        if (/^\s*--[a-z0-9-]+:/i.test(lt)) continue
        const token = KNOWN_TOKEN_COLORS[n] || KNOWN_TOKEN_COLORS[raw.toLowerCase()]
        if (token) {
          push(mk('medium', `令牌漂移：字面量 ${raw}`,
            `该色值对应设计令牌 ${token}，代码中写死会导致主题/令牌更新时不一致。`,
            norm, line, lt, `改为 var(${token.startsWith('--') ? token : token.split(' ')[0]}) 或使用语义类名`, repo,
            { current: raw, expected: `var(${token.startsWith('--') ? token : '…'})` }))
        } else {
          push(mk('low', `硬编码颜色：${raw}`,
            'UI 文件中出现硬编码色值，建议收敛到设计令牌。',
            norm, line, lt, '提取到 CSS 变量（如 --accent）或主题令牌后再引用', repo,
            { current: raw }))
        }
      } else {
        push(mk('low', `硬编码颜色：${raw.slice(0, 48)}`,
          '使用了 rgb/hsl 字面量，不利于主题统一。',
          norm, line, lt, '改为 CSS 变量或设计令牌', repo, { current: raw.slice(0, 80) }))
      }
      if (out.length > 80) break
    }
    if (out.length > 80) break
  }

  // 内联样式
  if (STYLE_ATTR.test(norm)) {
    for (const re of [INLINE_JSX, INLINE_HTML]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        const raw = m[0]
        // 动态计算或极短的展示用样式可降级；仍提示
        if (raw.length < 12) continue
        const line = lineOf(text, m.index)
        const lt = lineText(text, line)
        push(mk(raw.length > 80 ? 'medium' : 'low', '使用了内联样式',
          '内联 style 不利于复用与主题切换，也难做设计审查。',
          norm, line, lt.slice(0, 120) || raw.slice(0, 80),
          '抽到 CSS 类或 CSS Module / 设计系统组件', repo))
        if (out.filter((f) => /内联样式/.test(f.title)).length >= 25) break
      }
    }
  }

  // 令牌漂移：随意大间距像素
  PX_SPACE.lastIndex = 0
  let pm: RegExpExecArray | null
  let pxHits = 0
  while ((pm = PX_SPACE.exec(text))) {
    const n = Number(pm[1])
    if (n < 8 || n === 100 || n >= 400) continue // 忽略极小或明显布局百分近似
    // 4px 网格友好值降为 info
    const onGrid = n % 4 === 0
    const line = lineOf(text, pm.index)
    const lt = lineText(text, line)
    if (ALLOW_HEX_IN_COMMENT.test(lt)) continue
    if (/^\s*--[a-z0-9-]+:/i.test(lt)) continue
    push(mk(onGrid ? 'info' : 'low', `间距字面量：${n}px`,
      onGrid
        ? `可用间距令牌（如 --s-1…--s-10）替代 ${n}px，便于统一节奏。`
        : `${n}px 不在 4px 网格上，容易造成视觉节奏漂移。`,
      norm, line, lt, onGrid ? '改为 var(--s-N) 或设计间距工具类' : '调整到 4px 网格并使用间距令牌', repo,
      { current: `${n}px`, expected: onGrid ? 'var(--s-*)' : '4px 网格令牌' }))
    if (++pxHits >= 20) break
  }

  return out.slice(0, 100)
}

/** 批量扫描 */
export function scanDesignDebt(files: DesignScanFile[], repo?: string): Finding[] {
  const out: Finding[] = []
  const seen = new Set<string>()
  for (const f of files) {
    if (SKIP.test(f.path.replace(/\\/g, '/'))) continue
    for (const finding of scanDesignDebtInText(f.path, f.text, repo)) {
      if (seen.has(finding.id)) continue
      seen.add(finding.id)
      out.push(finding)
      if (out.length >= 200) return out
    }
  }
  return out
}

/** DESIGN.md 静态契约检查（不依赖 AI） */
export function designMdFindings(opts: {
  exists: boolean
  content?: string
  repo?: string
  /** 代码中引用 var(--token) 的令牌名 */
  usedTokens?: string[]
}): Finding[] {
  const out: Finding[] = []
  const repo = opts.repo
  if (!opts.exists) {
    out.push({
      id: fid('no-design-md', repo || ''),
      severity: 'info',
      category: 'design',
      title: '未找到 DESIGN.md',
      detail: '项目根目录没有设计契约文件。有前端代码时建议维护 DESIGN.md（令牌、组件约定），便于设计审查。',
      evidence: { path: 'DESIGN.md' },
      impact: '缺少统一设计约定时，硬编码与风格漂移更难发现',
      fix: '在仓库根目录新增 DESIGN.md，列出颜色/间距/圆角令牌与组件约定',
      verify: '存在可读的 DESIGN.md 后本条消失',
      source: 'builtin',
      confidence: 'high',
      status: 'open',
      repo
    })
    return out
  }
  const text = opts.content || ''
  const hasColor = /色|color|#[0-9a-fA-F]{3,8}|--[a-z-]*color|--accent|--bg/i.test(text)
  const hasSpace = /间距|spacing|--s-\d|gap|padding/i.test(text)
  const hasToken = /--[a-z][a-z0-9-]+/.test(text)
  if (!hasToken && !hasColor) {
    out.push({
      id: fid('design-md-thin', 'tokens'),
      severity: 'low',
      category: 'design',
      title: 'DESIGN.md 缺少令牌说明',
      detail: '设计契约未列出 CSS 变量或颜色令牌，审查时难以对照实现。',
      evidence: { path: 'DESIGN.md', line: 1 },
      fix: '补充颜色、间距、圆角等令牌表',
      source: 'builtin',
      confidence: 'medium',
      status: 'open',
      repo
    })
  } else if (!hasSpace) {
    out.push({
      id: fid('design-md-space', 'space'),
      severity: 'info',
      category: 'design',
      title: 'DESIGN.md 未描述间距节奏',
      detail: '建议补充间距令牌（如 4px 网格），便于发现随意像素值。',
      evidence: { path: 'DESIGN.md' },
      fix: '增加间距令牌章节',
      source: 'builtin',
      confidence: 'low',
      status: 'open',
      repo
    })
  }
  // 代码用了令牌但文档未提及
  if (opts.usedTokens?.length && hasToken) {
    const missing = opts.usedTokens.filter((t) => !text.includes(t)).slice(0, 8)
    if (missing.length) {
      out.push({
        id: fid('design-md-drift', missing.join(',')),
        severity: 'low',
        category: 'design',
        title: `DESIGN.md 未收录 ${missing.length} 个已用令牌`,
        detail: `代码中出现 ${missing.join('、')}，但 DESIGN.md 未提及，存在文档漂移。`,
        evidence: { path: 'DESIGN.md' },
        current: missing.join(', '),
        expected: '在 DESIGN.md 令牌表中声明',
        fix: '把实际使用的 CSS 变量补进设计契约',
        source: 'builtin',
        confidence: 'medium',
        status: 'open',
        repo
      })
    }
  }
  return out
}

/** 从文本中提取 var(--token) */
export function extractCssVarUses(text: string): string[] {
  const out = new Set<string>()
  const re = /var\(\s*(--[a-zA-Z0-9-]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.add(m[1])
  return [...out]
}

/** 粗判仓库是否像有前端 UI（决定是否提示设计审查） */
export function looksLikeFrontend(paths: string[]): boolean {
  return paths.some((p) => UI_EXT.test(p.replace(/\\/g, '/')) || /(^|\/)(components?|pages?|views?|styles?|css|ui)(\/|$)/i.test(p.replace(/\\/g, '/')))
}
