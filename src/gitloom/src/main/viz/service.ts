// 变更可视化 orchestration: resolve the scope to two trees, list + read source blobs without checkout
// (`git ls-tree` / `git cat-file --batch`), parse in the worker (cached by blob sha), build both models, diff them.
import { posix } from 'path'
import { promises as fsp } from 'fs'
import { join } from 'path'
import type { ChangedFile, VizRequest, VizResult, VizScope } from '../../shared/viz'
import { scopeLabel } from '../../shared/viz'
import { fnv, type FileFacts } from './facts'
import { langOf } from './langs'
import { SideModel, type RepoHints } from './model'
import { buildViews } from './diff'
import { buildCodeMap, buildTour } from './codemap'
import { buildVizPrompt, convertAI, validateAI } from './ai'
import type { VizAIResult, Tour } from '../../shared/viz'
import { tourCandidates, buildTourPrompt, validateTour, convertTour } from './tourAi'

export type VizChat = (messages: { role: 'system' | 'user' | 'assistant'; content: string }[], signal?: AbortSignal, onDelta?: (d: string) => void) => Promise<string>

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const WORKTREE = 'WORKTREE'
const MAX_FILES = 4000

export interface ParseItem { path: string; lang: string; src: string; key: string }
export interface VizDeps {
  git: (cwd: string, args: string[], opts?: { input?: string; allowFail?: boolean }) => Promise<{ stdout: string; ok: boolean }>
  gitBuf: (cwd: string, args: string[], input: string) => Promise<Buffer>
  parseMany: (items: ParseItem[], onProgress?: (done: number) => void) => Promise<FileFacts[]>
}
export interface VizProgress { phase: 'git' | 'parse' | 'model' | 'done'; done: number; total: number; text: string }

interface Entry { path: string; key: string; sha?: string }
interface Stored { result: VizResult; before: SideModel; after: SideModel; reqKey: string }

export class VizService {
  private facts = new Map<string, FileFacts>()
  private stored = new Map<string, Stored>()
  private seq = 0
  private aiCache = new Map<string, VizAIResult>()
  private aiInflight = new Map<string, Promise<VizAIResult>>()
  private tourCache = new Map<string, Tour>()
  private tourInflight = new Map<string, Promise<Tour & { cached?: boolean; attempts?: number }>>()
  constructor(private deps: VizDeps, private maxFacts = 40000) {}

  get(id: string): Stored | undefined { return this.stored.get(id) }

  private async git(repo: string, args: string[], allowFail = false): Promise<string> {
    const r = await this.deps.git(repo, args, { allowFail })
    return r.ok ? r.stdout : ''
  }
  private async verify(repo: string, ref: string): Promise<string | null> {
    const out = (await this.git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true)).trim()
    return out || null
  }

  async resolve(repo: string, scope: VizScope): Promise<{ before: string; after: string; beforeLabel: string; afterLabel: string }> {
    const short = (s: string) => s.slice(0, 7)
    if (scope.kind === 'working') {
      const head = await this.verify(repo, 'HEAD')
      return { before: head ?? EMPTY_TREE, after: WORKTREE, beforeLabel: head ? `HEAD · ${short(head)}` : '空仓库', afterLabel: '工作区（含未提交）' }
    }
    if (scope.kind === 'commit') {
      const sha = await this.verify(repo, scope.sha)
      if (!sha) throw new Error(`找不到提交 ${scope.sha}`)
      const parent = await this.verify(repo, `${sha}^`)
      return { before: parent ?? EMPTY_TREE, after: sha, beforeLabel: parent ? `父提交 ${short(parent)}` : '（无父提交）', afterLabel: `提交 ${short(sha)}` }
    }
    if (scope.kind === 'range') {
      const a = await this.verify(repo, scope.from); const b = await this.verify(repo, scope.to)
      if (!a || !b) throw new Error(`找不到 ${!a ? scope.from : scope.to}`)
      return { before: a, after: b, beforeLabel: `${scope.from} · ${short(a)}`, afterLabel: `${scope.to} · ${short(b)}` }
    }
    const base = await this.verify(repo, scope.base); const head = await this.verify(repo, scope.head)
    if (!base || !head) throw new Error(`找不到分支 ${!base ? scope.base : scope.head}`)
    const mb = (await this.git(repo, ['merge-base', base, head], true)).trim() || base
    return { before: mb, after: head, beforeLabel: `${scope.base}（分叉点 ${short(mb)}）`, afterLabel: `${scope.head} · ${short(head)}` }
  }

  private async changedFiles(repo: string, before: string, after: string): Promise<ChangedFile[]> {
    const args = after === WORKTREE ? ['diff', '--name-status', '-M', '-z', before] : ['diff', '--name-status', '-M', '-z', before, after]
    const out = await this.git(repo, args, true)
    const parts = out.split('\0').filter((x) => x !== '')
    const files: ChangedFile[] = []
    for (let i = 0; i < parts.length;) {
      const st = parts[i++]
      if (st.startsWith('R') || st.startsWith('C')) { const oldPath = parts[i++]; const path = parts[i++]; files.push({ path, oldPath, status: st.startsWith('R') ? 'R' : 'A' }) }
      else { const path = parts[i++]; files.push({ path, status: (st[0] === 'A' ? 'A' : st[0] === 'D' ? 'D' : 'M') }) }
    }
    if (after === WORKTREE) {
      const un = (await this.git(repo, ['ls-files', '--others', '--exclude-standard', '-z'], true)).split('\0').filter(Boolean)
      for (const p of un) if (!files.some((f) => f.path === p)) files.push({ path: p, status: 'A' })
    }
    const num = await this.git(repo, after === WORKTREE ? ['diff', '--numstat', '-M', before] : ['diff', '--numstat', '-M', before, after], true)
    const stats = new Map<string, [number, number]>()
    for (const l of num.split('\n')) { const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l); if (m) stats.set(m[3].replace(/^.*=> /, '').replace(/[{}]/g, ''), [Number(m[1]) || 0, Number(m[2]) || 0]) }
    for (const f of files) { const s = stats.get(f.path); if (s) { f.add = s[0]; f.del = s[1] }; f.lang = langOf(f.path) }
    return files.sort((a, b) => (a.path < b.path ? -1 : 1))
  }

  /** path → blob sha; `sizes` (if given) receives path → bytes (`ls-tree -l`, for the code map) */
  private async listTree(repo: string, ref: string, sizes?: Map<string, number>): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (ref === EMPTY_TREE) return out
    const raw = await this.git(repo, ['ls-tree', '-r', '-z', '-l', '--full-tree', ref], true)
    for (const e of raw.split('\0')) {
      const m = /^\d+ blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/s.exec(e)
      if (m) { out.set(m[3], m[1]); sizes?.set(m[3], Number(m[2]) || 0) }
    }
    return out
  }

  private async readBlobs(repo: string, shas: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (let i = 0; i < shas.length; i += 800) {
      const chunk = shas.slice(i, i + 800)
      const buf = await this.deps.gitBuf(repo, ['cat-file', '--batch'], chunk.join('\n') + '\n')
      let pos = 0
      while (pos < buf.length) {
        const nl = buf.indexOf(10, pos)
        if (nl < 0) break
        const head = buf.toString('utf8', pos, nl)
        const m = /^([0-9a-f]+) blob (\d+)$/.exec(head)
        if (!m) { pos = nl + 1; continue }
        const size = Number(m[2])
        const body = buf.subarray(nl + 1, nl + 1 + size)
        if (!body.includes(0)) out.set(m[1], body.toString('utf8'))
        pos = nl + 1 + size + 1
      }
    }
    return out
  }

  private async hints(repo: string, ref: string, tree: Map<string, string>): Promise<RepoHints> {
    const read = async (p: string): Promise<string | null> => {
      if (ref === WORKTREE) { try { return await fsp.readFile(join(repo, p), 'utf8') } catch { return null } }
      const sha = tree.get(p); if (!sha) return null
      return (await this.readBlobs(repo, [sha])).get(sha) ?? null
    }
    const h: RepoHints = { tsPaths: [] }
    const cfgs = [...tree.keys()].filter((p) => /^([^/]+\/)?(tsconfig|jsconfig)[\w.-]*\.json$/.test(p)).slice(0, 8)
    for (const c of cfgs) {
      const txt = await read(c)
      if (!txt) continue
      try {
        const j = JSON.parse(txt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1'))
        const baseUrl = posix.join(posix.dirname(c), j.compilerOptions?.baseUrl ?? '.')
        for (const [k, v] of Object.entries<string[]>(j.compilerOptions?.paths ?? {})) {
          h.tsPaths!.push({ prefix: k.replace(/\*$/, ''), targets: v.map((t) => posix.normalize(posix.join(baseUrl, t.replace(/\*$/, ''))) + (t.endsWith('/*') ? '/' : '')) })
        }
      } catch { /* ignore broken tsconfig */ }
    }
    const gomod = tree.has('go.mod') ? await read('go.mod') : null
    if (gomod) h.goModule = /^module\s+(\S+)/m.exec(gomod)?.[1]
    return h
  }

  async analyze(req: VizRequest, onProgress?: (p: VizProgress) => void, signal?: AbortSignal): Promise<VizResult> {
    const t0 = Date.now()
    const repo = req.repo
    const filter = (req.filter ?? '').replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '')
    const inFilter = (p: string) => !filter || p === filter || p.startsWith(filter + '/')
    const check = () => { if (signal?.aborted) throw Object.assign(new Error('已取消分析'), { name: 'AbortError' }) }
    onProgress?.({ phase: 'git', done: 0, total: 1, text: '解析范围…' })
    const r = await this.resolve(repo, req.scope)
    const changedAll = await this.changedFiles(repo, r.before, r.after)
    const changed = changedAll.filter((f) => inFilter(f.path) || (f.oldPath && inFilter(f.oldPath)))
    check()
    const sizesBAll = new Map<string, number>()
    const sizesAAll = new Map<string, number>()
    const beforeTree = await this.listTree(repo, r.before, sizesBAll)
    let afterTree: Map<string, string>
    const workContent = new Map<string, string>()
    if (r.after === WORKTREE) {
      afterTree = new Map(beforeTree)
      for (const [p, sz] of sizesBAll) sizesAAll.set(p, sz)
      for (const f of changedAll) {
        if (f.status === 'D') { afterTree.delete(f.path); sizesAAll.delete(f.path); continue }
        if (f.status === 'R' && f.oldPath) { afterTree.delete(f.oldPath); sizesAAll.delete(f.oldPath) }
        if (!langOf(f.path)) {
          afterTree.set(f.path, 'w')
          try { const st = await fsp.stat(join(repo, f.path)); if (st.isFile()) sizesAAll.set(f.path, st.size); else { afterTree.delete(f.path); sizesAAll.delete(f.path) } } catch { afterTree.delete(f.path); sizesAAll.delete(f.path) }
          continue
        }
        try {
          const st = await fsp.stat(join(repo, f.path))
          if (st.isFile()) sizesAAll.set(f.path, st.size)
          if (!st.isFile() || st.size > 1_500_000) continue
          const txt = await fsp.readFile(join(repo, f.path), 'utf8')
          workContent.set(f.path, txt)
          afterTree.set(f.path, `w:${fnv(txt)}:${txt.length}`)
        } catch { afterTree.delete(f.path); sizesAAll.delete(f.path) }
      }
    } else afterTree = await this.listTree(repo, r.after, sizesAAll)
    const gitMs = Date.now() - t0
    check()

    // source files in scope (both sides), capped for huge monorepos: keep the changed top-level folders
    const pick = (tree: Map<string, string>): Entry[] => [...tree].filter(([p]) => inFilter(p) && langOf(p)).map(([p, sha]) => ({ path: p, key: sha.startsWith('w:') ? sha : sha, sha: sha.startsWith('w:') ? undefined : sha }))
    let bEntries = pick(beforeTree); let aEntries = pick(afterTree)
    let truncatedFiles = 0
    const total = new Set([...bEntries, ...aEntries].map((e) => e.path)).size
    if (total > MAX_FILES) {
      const tops = new Set(changed.map((f) => f.path.split('/').slice(0, 2).join('/')))
      const keep = (e: Entry) => tops.has(e.path.split('/').slice(0, 2).join('/'))
      bEntries = bEntries.filter(keep); aEntries = aEntries.filter(keep)
      if (new Set([...bEntries, ...aEntries].map((e) => e.path)).size > MAX_FILES) {
        const dirs = new Set(changed.map((f) => posix.dirname(f.path)))
        const keep2 = (e: Entry) => dirs.has(posix.dirname(e.path))
        bEntries = bEntries.filter(keep2); aEntries = aEntries.filter(keep2)
      }
      truncatedFiles = total - new Set([...bEntries, ...aEntries].map((e) => e.path)).size
    }

    // read + parse what is not cached
    const need = new Map<string, Entry>()
    for (const e of [...bEntries, ...aEntries]) if (!this.facts.has(this.factKey(e))) need.set(this.factKey(e), e)
    const shas = [...new Set([...need.values()].filter((e) => e.sha).map((e) => e.sha!))]
    onProgress?.({ phase: 'git', done: 0, total: shas.length, text: `读取 ${shas.length} 个文件…` })
    const blobs = await this.readBlobs(repo, shas)
    check()
    const items: ParseItem[] = []
    for (const [k, e] of need) {
      const src = e.sha ? blobs.get(e.sha) : workContent.get(e.path)
      if (src === undefined) continue
      items.push({ path: e.path, lang: langOf(e.path)!, src, key: k })
    }
    const tp = Date.now()
    onProgress?.({ phase: 'parse', done: 0, total: items.length, text: `解析 ${items.length} 个源文件…` })
    const parsed = items.length ? await this.deps.parseMany(items, (d) => { onProgress?.({ phase: 'parse', done: d, total: items.length, text: `解析源文件 ${d}/${items.length}` }) }) : []
    parsed.forEach((f, i) => this.remember(items[i].key, f))
    const parseMs = Date.now() - tp
    check()

    onProgress?.({ phase: 'model', done: 0, total: 1, text: '构建依赖与调用关系…' })
    const renamed = new Map<string, string>() // old → new
    for (const f of changed) if (f.status === 'R' && f.oldPath) renamed.set(f.oldPath, f.path)
    const beforeOrig = new Map<string, string>()
    const bFacts: FileFacts[] = []
    for (const e of bEntries) {
      const f = this.facts.get(this.factKey(e)); if (!f) continue
      const canon = renamed.get(e.path) ?? e.path
      if (canon !== e.path) beforeOrig.set(canon, e.path)
      bFacts.push({ ...f, path: canon })
    }
    const aFacts: FileFacts[] = []
    for (const e of aEntries) { const f = this.facts.get(this.factKey(e)); if (f) aFacts.push({ ...f, path: e.path }) }
    const hints = await this.hints(repo, r.after === WORKTREE ? WORKTREE : r.after, r.after === WORKTREE ? beforeTree : afterTree)
    const before = new SideModel(bFacts, hints)
    const after = new SideModel(aFacts, hints)
    const views = buildViews({ before, after, changed, beforeOrig, hops: req.hops })
    const inScope = (m: Map<string, number>) => new Map([...m].filter(([p]) => inFilter(p)))
    const map = buildCodeMap({ before, after, changed, beforeOrig, sizesB: inScope(sizesBAll), sizesA: inScope(sizesAAll), truncatedFiles })
    const tour = buildTour({ before, after, changed, beforeOrig, map })
    // 热点 flag on module / impact nodes (same rule as the code map)
    const hubSet = new Set(map.files.filter((f) => f.hub).map((f) => f.path))
    if (hubSet.size) for (const g of [views.modules, views.impact]) for (const n of g.nodes) if (!n.group && hubSet.has(n.id.slice(2))) n.hub = true
    const langs: Record<string, number> = {}
    for (const f of aFacts.length ? aFacts : bFacts) langs[f.lang] = (langs[f.lang] ?? 0) + 1
    const workSig = r.after === WORKTREE ? fnv([...workContent].map(([p, c]) => p + ':' + fnv(c)).join('|') + changedAll.map((f) => f.status + f.path).join('|')) : ''
    const result: VizResult = {
      id: `viz${++this.seq}`, repo, scope: req.scope, filter: filter || undefined,
      beforeRef: r.before, afterRef: r.after, beforeLabel: r.beforeLabel, afterLabel: r.afterLabel,
      key: fnv(`${r.before}|${r.after}|${workSig}|${filter}`),
      files: changed, ...views, map, tour,
      stats: { files: new Set([...bEntries, ...aEntries].map((e) => e.path)).size, parsed: items.length, cached: need.size ? bEntries.length + aEntries.length - items.length : bEntries.length + aEntries.length, ms: Date.now() - t0, parseMs, gitMs,
        langs, unsupported: changed.filter((f) => !f.lang).length, ...(truncatedFiles ? { truncatedFiles } : {}) },
      warnings: [
        ...(truncatedFiles ? [`仓库较大：只分析了改动所在的目录（跳过 ${truncatedFiles} 个文件）`] : []),
        ...(changed.length && !changed.some((f) => f.lang) ? ['这次改动里没有可分析的源代码文件（只改了文档、配置或二进制）'] : []),
        ...(!changed.length ? [`${scopeLabel(req.scope)}没有改动${filter ? `（过滤：${filter}）` : ''}`] : [])
      ]
    }
    this.stored.set(result.id, { result, before, after, reqKey: result.key })
    while (this.stored.size > 10) this.stored.delete(this.stored.keys().next().value!)
    onProgress?.({ phase: 'done', done: 1, total: 1, text: '完成' })
    return result
  }

  private factKey(e: Entry): string { return `${e.key}|${langOf(e.path)}` }
  private remember(k: string, f: FileFacts) {
    this.facts.set(k, f)
    if (this.facts.size > this.maxFacts) { let n = this.facts.size - this.maxFacts; for (const key of this.facts.keys()) { if (n-- <= 0) break; this.facts.delete(key) } }
  }
  get cacheSize(): number { return this.facts.size }

  // ------------------------------------------------------------------ AI enrichment (cache per before|after|scope|model)
  aiCached(id: string, model: string): VizAIResult | undefined {
    const s = this.stored.get(id)
    return s ? this.aiCache.get(`${s.result.key}|${model}`) : undefined
  }
  async ai(id: string, model: string, chat: VizChat, signal?: AbortSignal, onProgress?: (chars: number, attempt: number) => void): Promise<VizAIResult & { cached?: boolean; attempts?: number; repaired?: boolean }> {
    const s = this.stored.get(id)
    if (!s) throw new Error('分析结果已过期，请重新分析')
    const ck = `${s.result.key}|${model}`
    const hit = this.aiCache.get(ck)
    if (hit) return { ...hit, cached: true }
    const fly = this.aiInflight.get(ck)
    if (fly) return fly   // single-flight: a second click joins the running request
    const run = (async () => {
      const r = s.result
      const files = r.files.filter((f) => f.lang).slice(0, 30).flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]))
      const args = r.afterRef === WORKTREE ? ['diff', '-U2', '-M', r.beforeRef, '--', ...files] : ['diff', '-U2', '-M', r.beforeRef, r.afterRef, '--', ...files]
      const hunks = files.length ? (await this.git(r.repo, args, true)).slice(0, 14000) : ''
      const { system, user } = buildVizPrompt(r, s.before, s.after, hunks)
      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: system }, { role: 'user', content: user }]
      let chars = 0
      let text = await chat(messages, signal, (d) => { chars += d.length; onProgress?.(chars, 1) })
      let v = validateAI(text)
      let attempts = 1
      if (!v.ok) {
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
        attempts = 2; chars = 0
        messages.push({ role: 'assistant', content: text.slice(0, 12000) }, { role: 'user', content: `你的输出没有通过 JSON schema 校验：\n${v.errors.map((e) => '- ' + e).join('\n')}\n请修正这些问题，只输出完整的 JSON 对象。` })
        text = await chat(messages, signal, (d) => { chars += d.length; onProgress?.(chars, 2) })
        v = validateAI(text)
        if (!v.ok) throw new Error(`AI 返回的结构两次都不合法：${v.errors.slice(0, 3).join('；')}`)
      }
      const out = convertAI(v.data, r, model)
      this.aiCache.set(ck, out)
      while (this.aiCache.size > 30) this.aiCache.delete(this.aiCache.keys().next().value!)
      return { ...out, attempts, repaired: v.repaired }
    })()
    this.aiInflight.set(ck, run)
    try { return await run } finally { this.aiInflight.delete(ck) }
  }

  // ------------------------------------------------------------------ AI 路径导览 (Codemaps-style, grounded on static candidates)
  tourCached(id: string, question: string, model: string): Tour | undefined {
    const s = this.stored.get(id)
    return s ? this.tourCache.get(`${s.result.key}|${question.trim()}|${model}`) : undefined
  }
  async tour(id: string, question: string, model: string, chat: VizChat, signal?: AbortSignal, onProgress?: (chars: number, attempt: number) => void): Promise<Tour & { cached?: boolean; attempts?: number }> {
    const s = this.stored.get(id)
    if (!s) throw new Error('分析结果已过期，请重新分析')
    const q = question.trim().slice(0, 200)
    const ck = `${s.result.key}|${q}|${model}`
    const hit = this.tourCache.get(ck)
    if (hit) return { ...hit, cached: true }
    const fly = this.tourInflight.get(ck)
    if (fly) return fly
    const run = (async () => {
      const r = s.result
      const cands = tourCandidates(r, s.before, s.after)
      if (!cands.length) throw new Error('这次改动没有可导览的源代码位置')
      const files = [...new Set(cands.filter((c) => c.status !== 'unchanged').flatMap((c) => [c.before?.file, c.after?.file]).filter((x): x is string => !!x))].slice(0, 30)
      const args = r.afterRef === WORKTREE ? ['diff', '-U2', '-M', r.beforeRef, '--', ...files] : ['diff', '-U2', '-M', r.beforeRef, r.afterRef, '--', ...files]
      const hunks = files.length ? (await this.git(r.repo, args, true)).slice(0, 10000) : ''
      const { system, user } = buildTourPrompt(r, cands, q, hunks)
      const ids = new Set(cands.map((c) => c.id))
      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: system }, { role: 'user', content: user }]
      let chars = 0
      let text = await chat(messages, signal, (d) => { chars += d.length; onProgress?.(chars, 1) })
      let v = validateTour(text, ids)
      let attempts = 1
      if (!v.ok) {
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
        attempts = 2; chars = 0
        messages.push({ role: 'assistant', content: text.slice(0, 12000) }, { role: 'user', content: `你的输出没有通过校验：\n${v.errors.map((e) => '- ' + e).join('\n')}\n请修正，只输出完整的 JSON 对象。` })
        text = await chat(messages, signal, (d) => { chars += d.length; onProgress?.(chars, 2) })
        v = validateTour(text, ids)
        if (!v.ok) throw new Error(`AI 返回的导览两次都不合法：${v.errors.slice(0, 3).join('；')}`)
      }
      const out = convertTour(v.data, cands, q, model)
      this.tourCache.set(ck, out)
      while (this.tourCache.size > 30) this.tourCache.delete(this.tourCache.keys().next().value!)
      return { ...out, attempts }
    })()
    this.tourInflight.set(ck, run)
    try { return await run } finally { this.tourInflight.delete(ck) }
  }

  // ------------------------------------------------------------------ snippets / full contents for the side panel
  async content(repo: string, ref: string, path: string): Promise<string> {
    if (ref === EMPTY_TREE) return ''
    if (ref === WORKTREE) { try { return await fsp.readFile(join(repo, path), 'utf8') } catch { return '' } }
    const r = await this.deps.git(repo, ['show', `${ref}:${path}`], { allowFail: true })
    return r.ok ? r.stdout : ''
  }
  async contents(id: string, before?: string, after?: string): Promise<{ original: string; modified: string }> {
    const s = this.stored.get(id)
    if (!s) throw new Error('分析结果已过期，请重新分析')
    const { repo, beforeRef, afterRef } = s.result
    return { original: before ? await this.content(repo, beforeRef, before) : '', modified: after ? await this.content(repo, afterRef, after) : '' }
  }
  /** unified git patch of one file between the two sides (file / module / cluster nodes) */
  async patch(id: string, file: string, oldFile?: string): Promise<string> {
    const s = this.stored.get(id)
    if (!s) throw new Error('分析结果已过期，请重新分析')
    const { repo, beforeRef, afterRef } = s.result
    const paths = oldFile && oldFile !== file ? [oldFile, file] : [file]
    const args = afterRef === WORKTREE ? ['diff', '-U3', '-M', beforeRef, '--', ...paths] : ['diff', '-U3', '-M', beforeRef, afterRef, '--', ...paths]
    let out = await this.git(repo, args, true)
    if (!out.trim() && afterRef === WORKTREE) {
      const txt = await this.content(repo, WORKTREE, file)
      const before = await this.content(repo, beforeRef, file)
      if (txt && !before) out = `@@ -0,0 +1,${txt.split('\n').length} @@ 新文件（未跟踪）\n` + txt.split('\n').map((l) => '+' + l).join('\n')
    }
    return out.slice(0, 200_000)
  }
  /** unified diff lines of one file restricted to the line ranges of a node (or a plain excerpt if unchanged) */
  async snippet(id: string, o: { before?: { file: string; line: number; endLine?: number }; after?: { file: string; line: number; endLine?: number } }): Promise<{ lines: { t: ' ' | '+' | '-' | '@'; text: string; b?: number; a?: number }[]; changed: boolean }> {
    const { original, modified } = await this.contents(id, o.before?.file, o.after?.file)
    const bl = original.split('\n'); const al = modified.split('\n')
    const bR = o.before ? [o.before.line, o.before.endLine ?? o.before.line + 30] : null
    const aR = o.after ? [o.after.line, o.after.endLine ?? o.after.line + 30] : null
    const bs = bR ? bl.slice(bR[0] - 1, Math.min(bR[1], bR[0] + 199)) : []
    const as = aR ? al.slice(aR[0] - 1, Math.min(aR[1], aR[0] + 199)) : []
    const lines = lineDiff(bs, as, bR?.[0] ?? 0, aR?.[0] ?? 0)
    return { lines: lines.slice(0, 400), changed: lines.some((l) => l.t !== ' ') }
  }
}

/** Myers-ish LCS line diff for small excerpts (≤200 lines each) */
export function lineDiff(b: string[], a: string[], b0: number, a0: number): { t: ' ' | '+' | '-'; text: string; b?: number; a?: number }[] {
  const n = b.length; const m = a.length
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = b[i] === a[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { t: ' ' | '+' | '-'; text: string; b?: number; a?: number }[] = []
  let i = 0; let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && b[i] === a[j]) { out.push({ t: ' ', text: a[j], b: b0 + i, a: a0 + j }); i++; j++ }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ t: '+', text: a[j], a: a0 + j }); j++ }
    else { out.push({ t: '-', text: b[i], b: b0 + i }); i++ }
  }
  return out
}
