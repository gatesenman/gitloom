/** 0.6.5：基于 web-tree-sitter FactParser 的结构化静态 Finding（codetree 精神对齐） */
import { createHash } from 'crypto'
import type { Finding, FindingSeverity } from '../../shared/health'
import type { FileFacts, FlowStep, FnFact } from '../viz/facts'
import { SideModel } from '../viz/model'
import { blastOf } from '../viz/codemap'

function fid(...parts: string[]): string {
  return 'ast-' + createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12)
}

const ENTRY_RE = /(^|\/)(main|index|app|cli|server|mod|lib)(\.[jt]sx?|\.mjs|\.cjs|\.py|\.go|\.rs)?$/i
const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|\.git|__tests__|__mocks__)(\/|$)|\.(test|spec)\.[jt]sx?$/i

/** 从 FnFact.flow 统计圈复杂度（决策点 + 1） */
export function complexityOf(flow: FlowStep[]): number {
  let c = 1
  const walk = (steps: FlowStep[]): void => {
    for (const s of steps) {
      if (s.t === 'if') {
        // 每个条件分支算一个决策点（else 本身不加）
        const decisions = s.branches.filter((b) => !/^else$/i.test(b.label.trim())).length
        c += Math.max(1, decisions)
        for (const b of s.branches) walk(b.body)
      } else if (s.t === 'loop') {
        c += 1
        walk(s.body)
      } else if (s.t === 'switch') {
        c += Math.max(1, s.cases.length)
        for (const ca of s.cases) walk(ca.body)
      } else if (s.t === 'try') {
        c += Math.max(0, s.catches.length)
        walk(s.body)
        for (const ca of s.catches) walk(ca.body)
        if (s.fin) walk(s.fin)
      }
    }
  }
  walk(flow)
  return c
}

export interface ComplexityOpts {
  medium?: number
  high?: number
  repo?: string
}

/** 圈复杂度超阈 → Finding */
export function complexityFindings(facts: FileFacts[], opts: ComplexityOpts = {}): Finding[] {
  const med = opts.medium ?? 15
  const high = opts.high ?? 25
  const out: Finding[] = []
  for (const f of facts) {
    if (f.shallow || SKIP.test(f.path)) continue
    for (const fn of f.fns) {
      const cc = complexityOf(fn.flow)
      if (cc < med) continue
      const sev: FindingSeverity = cc >= high ? 'high' : 'medium'
      const qname = fn.owner ? `${fn.owner}.${fn.name}` : fn.name
      out.push({
        id: fid('cc', f.path, qname, String(fn.line)),
        severity: sev,
        category: 'static',
        title: `圈复杂度偏高：${qname}（${cc}）`,
        detail: `基于 tree-sitter 控制流统计分支（if/循环/switch/catch）。建议阈值 ${med}，高危 ${high}。`,
        evidence: { path: f.path, line: fn.line, endLine: fn.endLine, snippet: `${qname} · CC=${cc} · ${fn.size} 行` },
        current: `CC=${cc}`,
        expected: `≤ ${med}`,
        impact: '难测、易藏缺陷，审查成本高',
        fix: '拆分分支逻辑、提取子函数或用策略/表驱动替换深层嵌套。',
        verify: '拆分后本函数 CC 应低于阈值。',
        source: 'builtin',
        confidence: 'high',
        status: 'open',
        repo: opts.repo
      })
    }
  }
  return out
}

/** 从源码轻量提取 export 名称（JS/TS/Python 常见写法） */
export function extractExportNames(src: string, lang: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = []
  const lines = src.split(/\r?\n/)
  const push = (name: string, line: number) => {
    if (!name || name === 'default') return
    if (!out.some((x) => x.name === name && x.line === line)) out.push({ name, line })
  }
  if (['typescript', 'tsx', 'javascript', 'vue', 'svelte'].includes(lang)) {
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i]
      let m: RegExpExecArray | null
      m = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(L)
      if (m) push(m[1], i + 1)
      m = /^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/.exec(L)
      if (m) push(m[1], i + 1)
      const brace = /^\s*export\s*\{([^}]+)\}/.exec(L)
      if (brace) {
        for (const part of brace[1].split(',')) {
          const mm = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*$/.exec(part)
            || /^\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(part)
          if (mm) push(mm[1], i + 1)
        }
      }
    }
  } else if (lang === 'python') {
    // __all__ = ['a', 'b']
    const allM = /__all__\s*=\s*\[([^\]]+)\]/.exec(src)
    if (allM) {
      for (const p of allM[1].split(',')) {
        const n = p.replace(/['"\s]/g, '')
        if (n) push(n, 1)
      }
    }
  }
  return out
}

export interface DeadCodeOpts {
  repo?: string
  /** 仅检查这些路径上的导出；默认全部非 shallow */
  focusPaths?: Set<string>
}

/** 死导出：本范围内 export 的符号在其它文件 import/idents/calls 中无引用 */
export function deadExportFindings(facts: FileFacts[], texts: Map<string, string>, opts: DeadCodeOpts = {}): Finding[] {
  const model = new SideModel(facts.filter((f) => !f.shallow))
  const referenced = new Set<string>()
  for (const f of facts) {
    for (const imp of f.imports) for (const n of imp.names) {
      const bare = n.replace(/^\* as /, '').split(/\s+as\s+/).pop()!.trim()
      if (bare) referenced.add(bare)
    }
    for (const id of f.idents) referenced.add(id)
    for (const fn of f.fns) for (const c of fn.calls) referenced.add(c.name)
  }
  // reverse call edges also mark callees as live
  for (const [, callees] of model.calls) for (const id of callees.keys()) {
    const ref = model.fns.get(id)
    if (ref) referenced.add(ref.f.name)
  }

  const out: Finding[] = []
  for (const f of facts) {
    if (f.shallow || SKIP.test(f.path)) continue
    if (opts.focusPaths && !opts.focusPaths.has(f.path)) continue
    if (ENTRY_RE.test(f.path)) continue
    const src = texts.get(f.path) ?? ''
    const exports = extractExportNames(src, f.lang)
    if (!exports.length) continue
    // also treat top-level fns/decls that appear in export list
    for (const ex of exports) {
      if (referenced.has(ex.name)) continue
      // same-file self-use (other fns call it) — check local
      const localUse = f.fns.some((fn) => fn.name !== ex.name && fn.calls.some((c) => c.name === ex.name))
        || f.fns.some((fn) => fn.name === ex.name && fn.owner) // method of exported class — skip naive
      if (localUse) continue
      // any other file imports this path?
      let importedBy = 0
      for (const [from, deps] of model.imports) {
        if (from === f.path) continue
        if (deps.has(f.path)) importedBy++
      }
      // if file is imported but name never appears — still dead export
      const sev: FindingSeverity = importedBy === 0 ? 'low' : 'medium'
      out.push({
        id: fid('dead', f.path, ex.name),
        severity: sev,
        category: 'static',
        title: `疑似死导出：${ex.name}`,
        detail: importedBy
          ? `文件被 ${importedBy} 处引用，但符号「${ex.name}」未出现在 import 名 / 调用 / 标识符中。`
          : `导出符号「${ex.name}」在当前分析范围内无引用方（入口文件已白名单跳过）。`,
        evidence: { path: f.path, line: ex.line, snippet: `export … ${ex.name}` },
        impact: '增加包体与认知负担，可能是遗留 API',
        fix: '确认无外部消费者后删除导出，或补充使用方。',
        verify: '删除后编译/测试仍通过；引用搜索为空。',
        source: 'builtin',
        confidence: 'low',
        status: 'open',
        repo: opts.repo
      })
    }
  }
  return out
}

export interface DeletedRefOpts { repo?: string }

/**
 * 删除仍被引用：before 侧有导出，after 侧消失，但其它 after 文件仍 import/call。
 * beforeFacts / afterFacts 按 path 对齐；已删除文件仅出现在 before。
 */
export function deletedStillReferencedFindings(
  beforeFacts: FileFacts[],
  afterFacts: FileFacts[],
  beforeTexts: Map<string, string>,
  afterTexts: Map<string, string>,
  opts: DeletedRefOpts = {}
): Finding[] {
  const afterByPath = new Map(afterFacts.map((f) => [f.path, f]))
  const afterModel = new SideModel(afterFacts.filter((f) => !f.shallow))
  const out: Finding[] = []

  for (const bf of beforeFacts) {
    if (bf.shallow || SKIP.test(bf.path)) continue
    const srcB = beforeTexts.get(bf.path) ?? ''
    const exportsB = extractExportNames(srcB, bf.lang)
    if (!exportsB.length) continue
    const af = afterByPath.get(bf.path)
    const srcA = af ? (afterTexts.get(af.path) ?? '') : ''
    const exportsA = new Set(af ? extractExportNames(srcA, af.lang).map((e) => e.name) : [])

    for (const ex of exportsB) {
      if (exportsA.has(ex.name)) continue
      // gone — who still references?
      const refs: string[] = []
      for (const [from, deps] of afterModel.imports) {
        if (from === bf.path) continue
        if (!deps.has(bf.path) && !(af && deps.has(af.path))) continue
        const ff = afterByPath.get(from)
        if (!ff) continue
        const namesHit = ff.imports.some((i) => i.names.some((n) => n.replace(/^\* as /, '').includes(ex.name)))
        const callHit = ff.fns.some((fn) => fn.calls.some((c) => c.name === ex.name))
        const identHit = ff.idents.includes(ex.name)
        if (namesHit || callHit || identHit) refs.push(from)
      }
      // also: file deleted but still imported by path
      if (!af) {
        for (const [from, deps] of afterModel.imports) {
          if (deps.has(bf.path) && !refs.includes(from)) refs.push(from)
        }
      }
      if (!refs.length) continue
      out.push({
        id: fid('delref', bf.path, ex.name, refs.slice(0, 3).join(',')),
        severity: 'high',
        category: 'static',
        title: `删除仍被引用：${ex.name}`,
        detail: `「${ex.name}」在 ${bf.path} 的改动后版本中已不存在（或文件已删），但仍被：${refs.slice(0, 8).join('、')}${refs.length > 8 ? '…' : ''}`,
        evidence: { path: refs[0], line: 1, snippet: `${ex.name} ← ${bf.path}` },
        impact: '运行时/编译期失败风险高',
        fix: '恢复导出、更新调用方，或同步删除引用。',
        verify: '全仓搜索符号名与旧路径 import 应为空或可解析。',
        source: 'builtin',
        confidence: 'medium',
        status: 'open',
        repo: opts.repo
      })
    }
  }
  return out
}

export interface CloneOpts { minSize?: number; repo?: string }

/** 简易重复函数：同 FnFact.sig 且 size≥minSize，出现 ≥2 */
export function cloneFindings(facts: FileFacts[], opts: CloneOpts = {}): Finding[] {
  const minSize = opts.minSize ?? 8
  const groups = new Map<string, { path: string; fn: FnFact }[]>()
  for (const f of facts) {
    if (f.shallow || SKIP.test(f.path)) continue
    for (const fn of f.fns) {
      if (fn.size < minSize || !fn.sig) continue
      const arr = groups.get(fn.sig) ?? []
      arr.push({ path: f.path, fn })
      groups.set(fn.sig, arr)
    }
  }
  const out: Finding[] = []
  for (const [sig, items] of groups) {
    if (items.length < 2) continue
    // distinct paths or distinct names
    const uniq = new Map<string, { path: string; fn: FnFact }>()
    for (const it of items) {
      const k = `${it.path}#${it.fn.owner ?? ''}.${it.fn.name}@${it.fn.line}`
      uniq.set(k, it)
    }
    if (uniq.size < 2) continue
    const list = [...uniq.values()]
    const sev: FindingSeverity = list.length >= 4 || list[0].fn.size >= 40 ? 'medium' : 'low'
    const locs = list.slice(0, 6).map((x) => `${x.path}:${x.fn.line}（${x.fn.owner ? x.fn.owner + '.' : ''}${x.fn.name}）`)
    out.push({
      id: fid('clone', sig),
      severity: sev,
      category: 'static',
      title: `疑似重复函数（${list.length} 处，约 ${list[0].fn.size} 行）`,
      detail: `相同规范化函数体签名出现多次：\n- ${locs.join('\n- ')}`,
      evidence: { path: list[0].path, line: list[0].fn.line, endLine: list[0].fn.endLine, snippet: list[0].fn.name },
      impact: '改一处易漏改另一处，维护成本上升',
      fix: '抽取公共函数或共享模块。',
      verify: '重复体合并后本条应消失。',
      source: 'builtin',
      confidence: 'medium',
      status: 'open',
      repo: opts.repo
    })
  }
  return out
}

export interface BlastOpts {
  changed: string[]
  medium?: number
  high?: number
  repo?: string
  cap?: number
}

/** 改动影响面：传递引用方数量（import 反向图） */
export function blastRadiusFindings(facts: FileFacts[], opts: BlastOpts): Finding[] {
  const med = opts.medium ?? 8
  const high = opts.high ?? 25
  const model = new SideModel(facts.filter((f) => !f.shallow))
  const rev = new Map<string, Set<string>>()
  for (const [s, ts] of model.imports) for (const t of ts.keys()) (rev.get(t) ?? rev.set(t, new Set()).get(t)!).add(s)

  const out: Finding[] = []
  const changed = opts.changed.filter((p) => !SKIP.test(p))
  for (const p of changed) {
    if (!model.files.has(p) && !rev.has(p)) continue
    const blast = blastOf(rev, [p], opts.cap ?? 5000)
    const n = blast.size
    if (n < med) continue
    const sev: FindingSeverity = n >= high ? 'high' : 'medium'
    const sample = [...blast].sort().slice(0, 10)
    out.push({
      id: fid('blast', p, String(n)),
      severity: sev,
      category: 'architecture',
      title: `改动影响面较大：${p}（传递引用 ${n}）`,
      detail: `基于 import 图的传递引用方约 ${n} 个。示例：${sample.join('、')}${n > sample.length ? '…' : ''}`,
      evidence: { path: p, line: 1, snippet: `blast=${n}` },
      current: `${n} 个传递引用方`,
      expected: `影响面可控（建议 < ${med}，或配套回归）`,
      impact: '回归范围大，建议优先审查与补测',
      fix: '缩小接口改动、增加适配层，或补充受影响路径测试。',
      source: 'builtin',
      confidence: 'medium',
      status: 'open',
      repo: opts.repo
    })
  }
  return out
}

/** 汇总：对已解析 facts 跑全部 AST 静态项（不含 deleted-ref，需 before/after） */
export function runAstStaticFindings(
  facts: FileFacts[],
  texts: Map<string, string>,
  changed: string[],
  repo?: string
): Finding[] {
  const focus = changed.length ? new Set(changed.map((p) => p.replace(/\\/g, '/'))) : undefined
  return [
    ...complexityFindings(facts, { repo }),
    ...deadExportFindings(facts, texts, { repo, focusPaths: focus }),
    ...cloneFindings(facts, { repo }),
    ...blastRadiusFindings(facts, { changed: changed.map((p) => p.replace(/\\/g, '/')), repo })
  ]
}
