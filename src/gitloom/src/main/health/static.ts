/** QA-3：内置静态启发式（函数过长、过大 diff、热点文件被改、简易循环依赖） */
import { createHash } from 'crypto'
import type { Finding } from '../../shared/health'

const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|\.git)\//
const CODE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|java|kt|rb|php|cs|rs|vue|svelte)$/i

function fid(...parts: string[]): string {
  return 'st-' + createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12)
}

/** 简易函数/方法边界：匹配常见语言定义行，统计到下一个同级定义的行数 */
export function findLongFunctions(file: string, text: string, threshold = 80, repo?: string): Finding[] {
  if (!CODE.test(file) || SKIP.test(file)) return []
  const lines = text.split(/\r?\n/)
  const starts: { line: number; name: string; indent: number }[] = []
  const defRe = /^(\s*)(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>|def\s+(\w+)\s*\(|fn\s+(\w+)\s*[<(]|func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(|(?:public|private|protected|internal|static|\s)+(\w+)\s*\([^;]*\)\s*\{)/
  for (let i = 0; i < lines.length; i++) {
    const m = defRe.exec(lines[i])
    if (!m) continue
    const name = m[2] || m[3] || m[4] || m[5] || m[6] || m[7] || `fn@${i + 1}`
    starts.push({ line: i + 1, name, indent: m[1].length })
  }
  const out: Finding[] = []
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i]
    const next = starts[i + 1]
    let end = next && next.indent <= cur.indent ? next.line - 1 : lines.length
    // trim trailing blanks
    while (end > cur.line && !lines[end - 1]?.trim()) end--
    const size = end - cur.line + 1
    if (size < threshold) continue
    out.push({
      id: fid('long-fn', file, cur.name, String(cur.line)),
      severity: size >= threshold * 2 ? 'high' : 'medium',
      category: 'static',
      title: `函数过长：${cur.name}（${size} 行）`,
      detail: `超过建议阈值 ${threshold} 行，可读性与可测性下降。`,
      evidence: { path: file, line: cur.line, endLine: end, snippet: lines[cur.line - 1]?.trim().slice(0, 120) },
      current: `${size} 行`,
      expected: `≤ ${threshold} 行（或拆分为更小函数）`,
      impact: '难以审查与复用，易隐藏缺陷',
      fix: '按职责拆分函数，提取辅助逻辑。',
      verify: '拆分后本条应消失或行数低于阈值。',
      source: 'builtin',
      confidence: 'medium',
      status: 'open',
      repo
    })
  }
  return out
}

export interface DiffStat { path: string; additions: number; deletions: number }

/** 过大 diff 文件 */
export function largeDiffFindings(stats: DiffStat[], threshold = 400, repo?: string): Finding[] {
  const out: Finding[] = []
  for (const s of stats) {
    if (SKIP.test(s.path) || BIN_NAME(s.path)) continue
    const total = s.additions + s.deletions
    if (total < threshold) continue
    out.push({
      id: fid('large-diff', s.path, String(total)),
      severity: total >= threshold * 2 ? 'high' : 'medium',
      category: 'static',
      title: `改动过大：${s.path}（+${s.additions}/−${s.deletions}）`,
      detail: `单文件变更行数 ${total}，超过阈值 ${threshold}。`,
      evidence: { path: s.path, line: 1 },
      current: `${total} 行变更`,
      expected: `拆成多次提交或缩小单文件改动面`,
      impact: '审查成本高，易漏看关键改动',
      fix: '拆分提交或提取公共改动到独立 PR。',
      source: 'builtin',
      confidence: 'high',
      status: 'open',
      repo
    })
  }
  return out
}

function BIN_NAME(p: string): boolean {
  return /\.(lock|min\.js|map|png|jpg|svg|wasm|zip)$/i.test(p)
}

/** 热点文件被改：根入口、配置、体量很大的源文件 */
const HOT_NAMES = /^(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|tsconfig.*\.json|webpack\.config|vite\.config|electron\.vite\.config)/i
const HOT_PATH = /(^|\/)(index|main|app|server|router|routes)\.(ts|tsx|js|jsx|py|go)$/i

export function hotspotFindings(changed: string[], fileSizes: Map<string, number>, repo?: string): Finding[] {
  const out: Finding[] = []
  for (const p of changed) {
    if (SKIP.test(p)) continue
    const base = p.split(/[\\/]/).pop() || p
    const size = fileSizes.get(p) ?? 0
    const hot = HOT_NAMES.test(base) || HOT_PATH.test(p) || size >= 800
    if (!hot) continue
    out.push({
      id: fid('hotspot', p),
      severity: size >= 1500 || HOT_NAMES.test(base) ? 'medium' : 'low',
      category: 'static',
      title: `热点文件被修改：${p}`,
      detail: size ? `当前约 ${size} 行；入口/配置/大体量文件改动风险更高。` : '入口或配置类文件被改动。',
      evidence: { path: p, line: 1 },
      impact: '影响面广，建议优先审查',
      fix: '确认向后兼容；补充测试或回归用例。',
      source: 'builtin',
      confidence: 'medium',
      status: 'open',
      repo
    })
  }
  return out
}

/** 从文件 import 行构建简易依赖图，检测小环（仅改动文件集合内） */
export function cycleFindings(files: Map<string, string>, repo?: string): Finding[] {
  const imports = new Map<string, string[]>()
  const resolve = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.') && !spec.startsWith('/')) return null
    const dir = from.replace(/[\\/][^\\/]+$/, '')
    let cand = (dir + '/' + spec).replace(/\\/g, '/')
    // normalize ./ and ../
    const parts: string[] = []
    for (const seg of cand.split('/')) {
      if (seg === '.' || seg === '') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    cand = parts.join('/')
    const tryExt = [cand, cand + '.ts', cand + '.tsx', cand + '.js', cand + '.mjs', cand + '/index.ts', cand + '/index.js']
    for (const t of tryExt) if (files.has(t)) return t
    // also try matching keys that end with path
    for (const k of files.keys()) {
      if (k === cand || k.startsWith(cand + '.') || k.replace(/\.(tsx?|jsx?|mjs)$/, '') === cand) return k
    }
    return null
  }
  const importRe = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const [path, text] of files) {
    if (!CODE.test(path)) continue
    const deps: string[] = []
    let m: RegExpExecArray | null
    const re = new RegExp(importRe.source, 'g')
    while ((m = re.exec(text))) {
      const spec = m[1] || m[2]
      const r = resolve(path.replace(/\\/g, '/'), spec)
      if (r && r !== path.replace(/\\/g, '/')) deps.push(r)
    }
    imports.set(path.replace(/\\/g, '/'), deps)
  }
  // DFS cycles
  const out: Finding[] = []
  const seen = new Set<string>()
  const stack: string[] = []
  const inStack = new Set<string>()
  const visit = (n: string) => {
    if (inStack.has(n)) {
      const i = stack.indexOf(n)
      const cycle = stack.slice(i).concat(n)
      if (cycle.length >= 3 && cycle.length <= 8) {
        const key = cycle.slice(0, -1).sort().join('→')
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            id: fid('cycle', key),
            severity: 'medium',
            category: 'architecture',
            title: `疑似循环依赖（${cycle.length - 1} 个文件）`,
            detail: cycle.join(' → '),
            evidence: { path: n, line: 1 },
            impact: '模块耦合、测试与打包困难',
            fix: '抽取共享层或倒置依赖方向。',
            source: 'builtin',
            confidence: 'low',
            status: 'open',
            repo
          })
        }
      }
      return
    }
    if (seen.has('v:' + n)) return
    inStack.add(n)
    stack.push(n)
    for (const d of imports.get(n) ?? []) visit(d)
    stack.pop()
    inStack.delete(n)
    seen.add('v:' + n)
  }
  for (const n of imports.keys()) visit(n)
  return out
}
