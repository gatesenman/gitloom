/** 一键体检引擎：可取消、可开关检查项、短缓存、历史存档 */
import { createHash } from 'crypto'
import { promises as fsp, existsSync } from 'fs'
import * as path from 'path'
import type { AISettings } from '../../shared/types'
import {
  type Finding, type HealthCheckId, type HealthReport, type HealthRunOptions, type HealthScopeKind,
  DEFAULT_CHECKS, summarizeFindings, sortFindings
} from '../../shared/health'
import { scanSecretsInDiff, scanSecretsInText } from './secrets'
import { findLongFunctions, largeDiffFindings, hotspotFindings, cycleFindings, type DiffStat } from './static'
import { runAstStaticFindings, deletedStillReferencedFindings } from './staticAst'
import { langOf } from '../viz/langs'
import type { FileFacts } from '../viz/facts'
import { hygieneFindings } from './hygiene'
import { toolFindings } from './toolsCheck'
import { parseAiReview } from './aiReview'
import { runOcr } from './ocr'
import { wikiLintFindings } from './wikiLint'
import { scanDesignDebt, designMdFindings, extractCssVarUses, looksLikeFrontend } from './designDebt'
import { HealthStore, contentHashOf, newReportId } from './store'
import { wikiRoot } from '../wiki'
import { resolveCandidates } from '../aiClient'
import { buildPrompt, chat } from '../ai'

export interface HealthEngineDeps {
  userData: string
  git: {
    status: (repo: string) => Promise<{ conflicted: { path: string }[]; staged: { path: string }[]; unstaged: { path: string; untracked?: boolean }[]; branch?: string | null; operation: string | null; detached: boolean }>
    stagedPatch: (repo: string, maxBytes?: number) => Promise<string>
    workingPatch: (repo: string, file?: string, staged?: boolean, maxBytes?: number) => Promise<string>
    raw: (repo: string, args: string[]) => Promise<{ output: string; ok?: boolean }>
  }
  detectTools: () => Promise<{ id: string; found: boolean; version?: string }[]>
  getAi: () => AISettings
  projectRootOf?: (repo: string) => string | undefined
  /** 复用 VizPool / FactParser；缺省则跳过 AST 结构化项 */
  parseMany?: (items: { path: string; lang: string; src: string }[], onProgress?: (done: number) => void) => Promise<FileFacts[]>
}

const CONFIG_GLOBS = ['**/.env', '**/.env.*', '**/config*.json', '**/credentials*', '**/*secret*', '**/*.pem', '**/*.key']

export class HealthEngine {
  store: HealthStore
  private inflight = new Map<string, AbortController>()

  constructor(private deps: HealthEngineDeps) {
    this.store = new HealthStore(deps.userData)
  }

  cancel(reqId: string): void {
    this.inflight.get(reqId)?.abort()
    this.inflight.delete(reqId)
  }

  async run(opts: HealthRunOptions, signal?: AbortSignal): Promise<HealthReport> {
    const repo = opts.repo
    const scope: HealthScopeKind = opts.scope ?? 'working'
    const checks = (opts.checks?.length ? opts.checks : DEFAULT_CHECKS).slice() as HealthCheckId[]
    const t0 = Date.now()
    const notes: string[] = []
    const findings: Finding[] = []

    // content fingerprint for cache
    let patch = ''
    try {
      if (scope === 'staged') patch = await this.deps.git.stagedPatch(repo, 200_000)
      else if (scope === 'working') {
        patch = await this.deps.git.workingPatch(repo, undefined, false, 200_000)
        if (!patch.trim()) patch = await this.deps.git.stagedPatch(repo, 200_000)
      } else if (scope === 'refs' && opts.base && opts.head) {
        const r = await this.deps.git.raw(repo, ['diff', `${opts.base}...${opts.head}`])
        patch = r.output.slice(0, 200_000)
      } else {
        // repo: sample recent unstaged+staged + tracked config files later
        patch = (await this.deps.git.workingPatch(repo, undefined, false, 100_000))
          + '\n' + (await this.deps.git.stagedPatch(repo, 100_000))
      }
    } catch (e) { notes.push(`读取 diff 失败：${(e as Error).message}`) }

    const ch = contentHashOf([scope, checks.slice().sort().join(','), patch.slice(0, 50000)])
    const ck = this.store.cacheKey(repo, scope, checks, ch)
    const cached = this.store.getCached(ck)
    if (cached && !opts.reqId) return cached

    let localSignal = signal
    if (opts.reqId) {
      const ctl = new AbortController()
      this.inflight.get(opts.reqId)?.abort()
      this.inflight.set(opts.reqId, ctl)
      if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true })
      localSignal = ctl.signal
    }

    const aborted = () => !!localSignal?.aborted
    const throwIf = () => { if (aborted()) throw new Error('已取消') }

    try {
      // collect changed file paths + stats
      const stats = await this.diffStats(repo, scope, opts)
      const changed = stats.map((s) => s.path)
      throwIf()

      if (checks.includes('hygiene')) {
        try {
          const st = await this.deps.git.status(repo)
          findings.push(...hygieneFindings({
            conflicted: st.conflicted.map((f) => f.path),
            staged: st.staged.map((f) => f.path),
            unstaged: st.unstaged.filter((f) => !f.untracked).map((f) => f.path),
            untracked: st.unstaged.filter((f) => f.untracked).map((f) => f.path),
            operation: st.operation,
            detached: st.detached,
            repo
          }))
        } catch (e) { notes.push(`卫生检查失败：${(e as Error).message}`) }
      }
      throwIf()

      if (checks.includes('secret')) {
        findings.push(...scanSecretsInDiff(patch, repo))
        // also scan common config files in working tree (cap)
        const confFiles = await this.listConfigFiles(repo, changed)
        for (const f of confFiles.slice(0, 40)) {
          throwIf()
          try {
            const full = path.join(repo, f)
            if (!existsSync(full)) continue
            const text = await fsp.readFile(full, 'utf8')
            if (text.includes('\0') || text.length > 500_000) continue
            findings.push(...scanSecretsInText(f, text, repo))
          } catch { /* */ }
        }
      }
      throwIf()

      if (checks.includes('static')) {
        findings.push(...largeDiffFindings(stats, 400, repo))
        const fileSizes = new Map<string, number>()
        const fileTexts = new Map<string, string>()
        const sample = (scope === 'repo' ? changed.slice(0, 60) : changed).slice(0, 80)
        for (const f of sample) {
          throwIf()
          try {
            const full = path.join(repo, f)
            if (!existsSync(full)) continue
            const text = await fsp.readFile(full, 'utf8')
            if (text.includes('\0') || text.length > 800_000) continue
            fileSizes.set(f, text.split(/\r?\n/).length)
            fileTexts.set(f.replace(/\\/g, '/'), text)
            findings.push(...findLongFunctions(f, text, 80, repo))
          } catch { /* */ }
        }
        findings.push(...hotspotFindings(changed, fileSizes, repo))
        if (fileTexts.size >= 2) findings.push(...cycleFindings(fileTexts, repo))

        // 0.6.5：tree-sitter FactParser 结构化静态（复杂度 / 死导出 / 重复 / 影响面 / 删除仍引用）
        if (this.deps.parseMany && fileTexts.size) {
          try {
            throwIf()
            // 为 import 图补充邻域文件（同目录 + 常见入口），上限与抽样一致
            const extra = await this.neighborSources(repo, [...fileTexts.keys()], 40)
            for (const [p, t] of extra) if (!fileTexts.has(p)) fileTexts.set(p, t)
            throwIf()
            const items: { path: string; lang: string; src: string }[] = []
            for (const [p, src] of fileTexts) {
              const lang = langOf(p)
              if (!lang) continue
              items.push({ path: p, lang, src })
            }
            if (items.length) {
              const facts = await this.deps.parseMany(items)
              throwIf()
              const ast = runAstStaticFindings(facts, fileTexts, sample.map((p) => p.replace(/\\/g, '/')), repo)
              // AST 同类项优先：同 path+近似标题的启发式长函数可被复杂度覆盖时去重 id 即可（不同 id 并存）
              findings.push(...ast)

              // 删除仍被引用：拉取 HEAD 侧内容作 before
              const beforeTexts = new Map<string, string>()
              const beforeItems: { path: string; lang: string; src: string }[] = []
              for (const f of sample) {
                throwIf()
                const norm = f.replace(/\\/g, '/')
                try {
                  const r = await this.deps.git.raw(repo, ['show', `HEAD:${norm}`])
                  if (!r.ok) continue
                  const src = (r.output || '').slice(0, 800_000)
                  if (!src || src.includes('\0')) continue
                  const lang = langOf(norm)
                  if (!lang) continue
                  beforeTexts.set(norm, src)
                  beforeItems.push({ path: norm, lang, src })
                } catch { /* new file or missing */ }
              }
              // 已删除路径（status 中有、工作区无文件）
              try {
                const st = await this.deps.git.status(repo)
                for (const f of [...st.staged, ...st.unstaged]) {
                  const norm = f.path.replace(/\\/g, '/')
                  if (existsSync(path.join(repo, f.path))) continue
                  if (beforeTexts.has(norm)) continue
                  try {
                    const r = await this.deps.git.raw(repo, ['show', `HEAD:${norm}`])
                    const src = (r.output || '').slice(0, 800_000)
                    const lang = langOf(norm)
                    if (!lang || !src || src.includes('\0')) continue
                    beforeTexts.set(norm, src)
                    beforeItems.push({ path: norm, lang, src })
                    if (!sample.includes(f.path)) sample.push(f.path)
                  } catch { /* */ }
                }
              } catch { /* */ }
              if (beforeItems.length) {
                throwIf()
                const beforeFacts = await this.deps.parseMany(beforeItems)
                findings.push(...deletedStillReferencedFindings(beforeFacts, facts, beforeTexts, fileTexts, { repo }))
              }
            }
          } catch (e) {
            if (aborted()) throw e
            notes.push(`结构化静态分析跳过：${(e as Error).message}`)
          }
        }
      }
      throwIf()

      let tools: { id: string; found: boolean; version?: string }[] = []
      if (checks.includes('tools') || checks.includes('ocr')) {
        try { tools = await this.deps.detectTools() } catch { tools = [] }
      }
      if (checks.includes('tools')) findings.push(...toolFindings(tools, repo))
      throwIf()

      if (checks.includes('ocr')) {
        const ocrTool = tools.find((t) => t.id === 'ocr')
        if (!ocrTool?.found) {
          notes.push('未安装 ocr，已跳过 OpenCodeReview')
        } else {
          const r = await runOcr(repo, localSignal)
          findings.push(...r.findings)
          if (r.note) notes.push(r.note)
        }
      }
      throwIf()

      if (checks.includes('ai')) {
        const ai = this.deps.getAi()
        const has = resolveCandidates(ai, 'review').length > 0 || resolveCandidates(ai, 'explain').length > 0
          || !!(ai.profiles?.length || (ai as { baseUrl?: string }).baseUrl)
        if (!has) {
          notes.push('未配置 AI，已跳过 AI 审查')
        } else {
          try {
            let diff = patch
            if (!diff.trim()) {
              notes.push('无改动可供 AI 审查')
            } else {
              const text = await chat(ai, buildPrompt('reviewStaged', ai, { diff: diff.slice(0, 60000) }), {
                action: 'reviewStaged', signal: localSignal, temperature: 0.1, maxTokens: 4000, timeoutMs: 120000
              })
              findings.push(...parseAiReview(text, repo))
            }
          } catch (e) {
            if (aborted()) throw e
            notes.push(`AI 审查失败：${(e as Error).message}`)
          }
        }
      }
      throwIf()


      if (checks.includes('design')) {
        try {
          const designFiles: { path: string; text: string }[] = []
          const samplePaths = (scope === 'repo' ? changed.slice(0, 80) : changed).slice(0, 100)
          // 若改动很少，再扫常见 UI 入口，避免空仓漏检
          const extras = ['src/renderer/src/styles.css', 'styles.css', 'src/styles.css', 'app/globals.css']
          const want = [...samplePaths]
          for (const e of extras) if (!want.includes(e)) want.push(e)
          const usedTokens = new Set<string>()
          for (const f of want.slice(0, 120)) {
            throwIf()
            try {
              const full = path.join(repo, f)
              if (!existsSync(full)) continue
              const text = await fsp.readFile(full, 'utf8')
              if (text.includes('\0') || text.length > 900_000) continue
              designFiles.push({ path: f.replace(/\\/g, '/'), text })
              for (const tok of extractCssVarUses(text)) usedTokens.add(tok)
            } catch { /* */ }
          }
          if (looksLikeFrontend(designFiles.map((x) => x.path).concat(changed)) || designFiles.length) {
            findings.push(...scanDesignDebt(designFiles, repo))
          }
          // DESIGN.md 契约
          const mdCandidates = ['DESIGN.md', 'design.md', 'docs/DESIGN.md', '.design/DESIGN.md']
          let mdPath: string | null = null
          let mdText = ''
          for (const c of mdCandidates) {
            const full = path.join(repo, c)
            if (existsSync(full)) { mdPath = c; mdText = await fsp.readFile(full, 'utf8'); break }
          }
          findings.push(...designMdFindings({
            exists: !!mdPath,
            content: mdText,
            repo,
            usedTokens: [...usedTokens].slice(0, 40)
          }))
        } catch (e) {
          if (aborted()) throw e
          notes.push(`设计审查失败：${(e as Error).message}`)
        }
      }
      throwIf()

      if (checks.includes('wiki')) {
        const root = opts.projectRoot || this.deps.projectRootOf?.(repo)
        if (root) {
          try {
            const wr = wikiRoot(root, this.deps.userData)
            findings.push(...await wikiLintFindings(wr, repo))
          } catch (e) { notes.push(`Wiki lint 失败：${(e as Error).message}`) }
        }
      }

      // dedupe by id
      const uniq = new Map<string, Finding>()
      for (const f of findings) if (!uniq.has(f.id)) uniq.set(f.id, f)
      const list = sortFindings([...uniq.values()])
      const report: HealthReport = {
        id: newReportId(),
        createdAt: Date.now(),
        scope,
        repo,
        projectRoot: opts.projectRoot,
        checksRun: checks,
        findings: list,
        summary: summarizeFindings(list),
        durationMs: Date.now() - t0,
        cancelled: false,
        notes: notes.length ? notes : undefined,
        contentHash: ch
      }
      this.store.setCached(ck, report)
      await this.store.save(report)
      return report
    } catch (e) {
      if (aborted() || /已取消/.test((e as Error).message || '')) {
        const list = sortFindings(findings)
        const report: HealthReport = {
          id: newReportId(),
          createdAt: Date.now(),
          scope,
          repo,
          projectRoot: opts.projectRoot,
          checksRun: checks,
          findings: list,
          summary: summarizeFindings(list),
          durationMs: Date.now() - t0,
          cancelled: true,
          notes: [...notes, '运行已取消'],
          contentHash: ch
        }
        await this.store.save(report).catch(() => undefined)
        return report
      }
      throw e
    } finally {
      if (opts.reqId) this.inflight.delete(opts.reqId)
    }
  }

  private async diffStats(repo: string, scope: HealthScopeKind, opts: HealthRunOptions): Promise<DiffStat[]> {
    try {
      let args: string[]
      if (scope === 'staged') args = ['diff', '--cached', '--numstat']
      else if (scope === 'refs' && opts.base && opts.head) args = ['diff', '--numstat', `${opts.base}...${opts.head}`]
      else if (scope === 'repo') args = ['diff', '--numstat', 'HEAD~20...HEAD']
      else args = ['diff', '--numstat', 'HEAD']
      const r = await this.deps.git.raw(repo, args)
      const stats: DiffStat[] = []
      for (const line of r.output.split(/\r?\n/)) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
        if (!m) continue
        stats.push({ path: m[3], additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) })
      }
      // include untracked for working scope
      if (scope === 'working' || scope === 'repo') {
        try {
          const st = await this.deps.git.status(repo)
          for (const f of [...st.unstaged, ...st.staged]) if (!stats.some((s) => s.path === f.path)) stats.push({ path: f.path, additions: 0, deletions: 0 })
        } catch { /* */ }
      }
      return stats
    } catch { return [] }
  }

  /** 为 AST import 图补充同目录邻域源文件（只读，有上限） */
  private async neighborSources(repo: string, seeds: string[], cap = 40): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const dirs = new Set(seeds.map((p) => p.replace(/\\/g, '/').replace(/\/[^/]+$/, '') || '.'))
    try {
      const r = await this.deps.git.raw(repo, ['ls-files', '-z', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.py', '*.go', '*.java', '*.rs', '*.kt', '*.cs'])
      const all = r.output.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'))
      for (const p of all) {
        if (out.size >= cap) break
        if (seeds.includes(p)) continue
        const dir = p.replace(/\/[^/]+$/, '') || '.'
        if (!dirs.has(dir) && !/(^|\/)(index|main)\.[jt]sx?$/.test(p)) continue
        try {
          const full = path.join(repo, p)
          if (!existsSync(full)) continue
          const text = await fsp.readFile(full, 'utf8')
          if (text.includes('\0') || text.length > 400_000) continue
          out.set(p, text)
        } catch { /* */ }
      }
    } catch { /* */ }
    return out
  }

  private async listConfigFiles(repo: string, changed: string[]): Promise<string[]> {
    const set = new Set<string>()
    for (const f of changed) {
      if (/\.env|\.pem$|\.key$|credential|secret|config/i.test(f)) set.add(f)
    }
    // common root configs
    for (const name of ['.env', '.env.local', '.env.production', 'credentials.json', 'config.json', 'appsettings.json']) {
      if (existsSync(path.join(repo, name))) set.add(name)
    }
    try {
      const r = await this.deps.git.raw(repo, ['ls-files', '-z', '*.pem', '*.key', '.env', '.env.*'])
      for (const f of r.output.split('\0')) if (f) set.add(f)
    } catch { /* */ }
    void CONFIG_GLOBS
    return [...set]
  }
}

export function mergeReviewIntoReport(report: HealthReport, text: string): HealthReport {
  const extra = parseAiReview(text, report.repo)
  const map = new Map(report.findings.map((f) => [f.id, f]))
  for (const f of extra) map.set(f.id, f)
  const findings = sortFindings([...map.values()])
  return { ...report, findings, summary: summarizeFindings(findings) }
}

export function hashRepo(repo: string): string {
  return createHash('sha1').update(path.resolve(repo).replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16)
}
