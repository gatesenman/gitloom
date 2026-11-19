// AI 定时任务 service: persisted tasks + run history, in-app scheduler (runs while GitLoom is open), runners.
import { promises as fs } from 'fs'
import { join } from 'path'
import type { AiTaskDef, TaskRun, TasksState, RunTrigger } from '../../shared/tasks'
import { decide } from './schedule'
import { guard, templateOf } from './templates'
import { makeTools, type Tools } from './tools'
import { branchFacts, classifyBranch, isStale, branchesMarkdown } from './branches'
import { scanRepo, diffFindings, rank, securityMarkdown, type Finding, type Level } from './scan'
import { connectorReady, fetchAll, yesterday, matches, issuesMarkdown, type IssueConnector, type RootCause, type Fetcher } from './issues'
import { redact } from './readonly'

export type Chat = (messages: { role: 'system' | 'user'; content: string }[]) => Promise<string>
export interface TaskDeps {
  dir: string
  chat: () => Chat | null
  enc: (s: string) => string
  dec: (s: string) => string
  notify: (title: string, body: string) => void
  emit: (s: TasksState) => void
  fetcher?: Fetcher
  now?: () => number
  tools?: (allowWrite: boolean) => Tools
}
interface Persist { tasks: AiTaskDef[]; runs: TaskRun[]; connector: { url: string; authHeader: string; tokenEnc?: string } }
const MAX_RUNS = 30

const jsonOf = (s: string): unknown => { const m = /```(?:json)?\s*([\s\S]*?)```/.exec(s); const body = m ? m[1] : s.slice(Math.max(0, s.search(/[[{]/))); try { return JSON.parse(body) } catch { return null } }

export class TaskService {
  private p: Persist = { tasks: [], runs: [], connector: { url: '', authHeader: 'Authorization' } }
  private running = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private file: string
  constructor(private d: TaskDeps) { this.file = join(d.dir, 'ai-tasks.json') }
  private now = () => (this.d.now ? this.d.now() : Date.now())
  async load() { try { this.p = { ...this.p, ...JSON.parse(await fs.readFile(this.file, 'utf8')) } } catch { /* first run */ } }
  private async persist() { await fs.mkdir(this.d.dir, { recursive: true }); await fs.writeFile(this.file, JSON.stringify(this.p, null, 1)); this.d.emit(this.state()) }
  private token() { return this.p.connector.tokenEnc ? this.d.dec(this.p.connector.tokenEnc) : '' }
  state(): TasksState {
    return { tasks: this.p.tasks, runs: this.p.runs, running: [...this.running], connector: { url: this.p.connector.url, authHeader: this.p.connector.authHeader, hasToken: !!this.p.connector.tokenEnc } }
  }
  async save(t: AiTaskDef) {
    const i = this.p.tasks.findIndex((x) => x.id === t.id)
    const now = this.now()
    const next: AiTaskDef = { ...t, updatedAt: now, createdAt: t.createdAt || now, handledUntil: i >= 0 && JSON.stringify(this.p.tasks[i].schedule) === JSON.stringify(t.schedule) ? this.p.tasks[i].handledUntil : now }
    if (i >= 0) this.p.tasks[i] = { ...this.p.tasks[i], ...next }; else this.p.tasks.push(next)
    await this.persist(); return this.state()
  }
  async remove(id: string) { this.p.tasks = this.p.tasks.filter((t) => t.id !== id); this.p.runs = this.p.runs.filter((r) => r.taskId !== id); await this.persist(); return this.state() }
  async setConnector(c: { url: string; authHeader?: string; token?: string | null }) {
    this.p.connector.url = c.url.trim(); this.p.connector.authHeader = c.authHeader?.trim() || 'Authorization'
    if (c.token === null) delete this.p.connector.tokenEnc
    else if (c.token) this.p.connector.tokenEnc = this.d.enc(c.token)
    await this.persist(); return this.state()
  }
  start() { if (!this.timer) { void this.tick(); this.timer = setInterval(() => void this.tick(), 30000) } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }
  async tick() {
    const now = this.now()
    let dirty = false
    for (const t of this.p.tasks) {
      const dec = decide(t, now)
      if (dec.action === 'none') continue
      t.handledUntil = dec.due!; dirty = true
      if (dec.action === 'missed') t.missedAt = dec.due!
      else void this.run(t.id, 'schedule')
    }
    if (dirty) await this.persist()
  }
  async run(id: string, trigger: RunTrigger): Promise<TaskRun | null> {
    const t = this.p.tasks.find((x) => x.id === id)
    if (!t || this.running.has(id)) return null
    const run: TaskRun = { id: `${id}-${this.now()}`, taskId: id, trigger, startedAt: this.now(), status: 'running', markdown: '' }
    const g = guard(t, { connectorReady: connectorReady(this.p.connector), aiReady: !!this.d.chat() })
    if (!g.ok) {
      run.status = 'blocked'; run.finishedAt = this.now(); run.markdown = `## ${g.reason}\n\n${t.template === 'issues' ? '请在任务页的「问题平台接入」里填写接口地址和令牌后再运行。' : ''}`
      this.pushRun(run); await this.persist(); return run
    }
    this.running.add(id); t.missedAt = null; this.pushRun(run); await this.persist()
    try {
      const tools = (this.d.tools ?? makeTools)(t.allowWrite)
      if (t.template === 'branches') run.markdown = await this.runBranches(t, tools)
      else if (t.template === 'security') { const r = await this.runSecurity(t, tools); run.markdown = r.md; run.data = { keys: r.keys } }
      else if (t.template === 'issues') run.markdown = await this.runIssues(t, tools)
      else run.markdown = await this.runCustom(t, tools)
      run.status = 'ok'
    } catch (e) {
      run.status = 'error'; run.markdown = `## 运行失败\n\n${redact((e as Error).message ?? String(e), [this.token()])}`
    } finally {
      run.finishedAt = this.now(); t.lastRunAt = run.finishedAt; this.running.delete(id); await this.persist()
      if (t.notify) this.d.notify(`GitLoom · ${t.name}`, (run.markdown.split('\n').find((l) => l.startsWith('## ')) ?? '').replace(/^##\s*/, '') || (run.status === 'ok' ? '已完成' : '运行失败'))
    }
    return run
  }
  private pushRun(r: TaskRun) {
    this.p.runs = [r, ...this.p.runs.filter((x) => x.id !== r.id)]
    const per = new Map<string, number>()
    this.p.runs = this.p.runs.filter((x) => { const n = (per.get(x.taskId) ?? 0) + 1; per.set(x.taskId, n); return n <= MAX_RUNS })
  }
  private multi = (t: AiTaskDef) => t.scope.repos.length > 1

  async runBranches(t: AiTaskDef, tools: Tools): Promise<string> {
    const nowS = Math.floor(this.now() / 1000)
    const all = []
    for (const repo of t.scope.repos) for (const f of await branchFacts(tools, repo)) if (isStale(f, nowS)) all.push(classifyBranch(f))
    return branchesMarkdown(all, nowS, this.multi(t))
  }
  async runSecurity(t: AiTaskDef, tools: Tools): Promise<{ md: string; keys: string[] }> {
    let found: Finding[] = []
    const notes: string[] = []
    for (const repo of t.scope.repos) { const r = await scanRepo(tools, repo); found.push(...r.findings.map((f) => ({ ...f, repo, key: t.scope.repos.length > 1 ? `${repo}|${f.key}` : f.key }))); notes.push(...r.notes) }
    const prev = this.p.runs.find((r) => r.taskId === t.id && r.status === 'ok' && (r.data as { keys?: string[] })?.keys)
    found = diffFindings(found, prev ? (prev.data as { keys: string[] }).keys : null)
    let aiNote = '未配置 AI：风险等级按规则默认值给出。'
    const chat = this.d.chat()
    if (chat && found.length) {
      try {
        const items = found.slice(0, 80).map((f) => ({ key: f.key, category: f.category, title: f.title, file: f.file, line: f.line, code: f.excerpt, defaultLevel: f.level }))
        const txt = await chat([{ role: 'system', content: '你是应用安全专家。只判断每条静态检测结果的真实可利用性，不要新增结果。只输出 JSON 数组：[{"key":"...","level":"高|中|低","reason":"一句话中文理由"}]。' },
          { role: 'user', content: `${t.prompt}\n\n检测结果（密钥已打码）：\n${JSON.stringify(items)}` }])
        const arr = jsonOf(txt)
        if (Array.isArray(arr)) {
          const m = new Map((arr as { key: string; level: Level; reason?: string }[]).filter((x) => x && ['高', '中', '低'].includes(x.level)).map((x) => [x.key, x]))
          found = found.map((f) => { const j = m.get(f.key); return j ? { ...f, level: j.level, reason: String(j.reason ?? '').slice(0, 200) } : f })
          aiNote = 'AI 只对静态检测出的结果判断可利用性并排序；检测本身是确定性的规则。'
        }
      } catch (e) { aiNote = `AI 判断失败（${redact((e as Error).message)}），已按规则默认等级排序。` }
    }
    found = rank(found)
    return { md: securityMarkdown(found, [...new Set(notes)], this.multi(t), found.length ? aiNote : ''), keys: found.map((f) => f.key) }
  }
  async runIssues(t: AiTaskDef, tools: Tools): Promise<string> {
    const c: IssueConnector = { url: this.p.connector.url, authHeader: this.p.connector.authHeader, token: this.token() }
    const { since, until, label } = yesterday(new Date(this.now()))
    const f: Fetcher = this.d.fetcher ?? (async (url, headers) => { const r = await fetch(url, { headers }); return { ok: r.ok, status: r.status, json: () => r.json() } })
    const tickets = await fetchAll(c, since, until, f)
    const hits = tickets.filter((x) => matches(x))
    if (!hits.length) return issuesMarkdown([], [], label)
    const chat = this.d.chat()
    if (!chat) return issuesMarkdown(hits, [], label, '未配置 AI：无法归纳根因，全部列入待人工确认。')
    const ids = new Set(hits.map((h) => h.id))
    const causes: RootCause[] = []
    for (let i = 0; i < hits.length; i += 120) {
      const batch = hits.slice(i, i + 120).map((h) => ({ id: h.id, title: h.title.slice(0, 120), content: redact(h.content).slice(0, 400) }))
      const txt = await chat([{ role: 'system', content: '你是客户端稳定性专家。把工单按根因分组。只输出 JSON：{"causes":[{"cause":"根因名","ids":["单号"],"conclusion":"一句话结论","confident":true,"suspectSymbol":"可疑函数名或类名"}]}。拿不准的工单不要放进任何组。' },
        { role: 'user', content: `${t.prompt}\n\n工单：\n${JSON.stringify(batch)}` }])
      const j = jsonOf(txt) as { causes?: { cause: string; ids: string[]; conclusion: string; confident?: boolean; suspectSymbol?: string }[] } | null
      for (const g of j?.causes ?? []) {
        if (!g || g.confident === false || !Array.isArray(g.ids)) continue
        const gi = g.ids.map(String).filter((x) => ids.has(x) && !causes.some((c2) => c2.ids.includes(x)))
        if (!gi.length) continue
        const ex = causes.find((c2) => c2.cause === g.cause)
        if (ex) { ex.ids.push(...gi); continue }
        const rc: RootCause = { cause: String(g.cause).slice(0, 60), ids: gi, conclusion: String(g.conclusion ?? '').slice(0, 160) }
        const sym = String(g.suspectSymbol ?? '').trim()
        if (/^[A-Za-z_$][\w$.:]{1,80}$/.test(sym)) {
          rc.suspect = { symbol: sym }
          const name = sym.split(/[.:]/).pop()!
          for (const repo of t.scope.repos) {
            const r = await tools.git(repo, ['grep', '-n', '-w', '-I', '-m', '1', '-e', name])
            const first = r.stdout.split('\n').find(Boolean)
            const m = first && /^(.+?):(\d+):/.exec(first)
            if (m) { rc.suspect = { symbol: sym, file: (this.multi(t) ? `${repo.split(/[\\/]/).pop()}/` : '') + m[1], line: Number(m[2]) }; break }
          }
        }
        causes.push(rc)
      }
    }
    return issuesMarkdown(hits, causes, label)
  }
  async runCustom(t: AiTaskDef, tools: Tools): Promise<string> {
    const chat = this.d.chat()
    if (!chat) throw new Error('未配置 AI 服务商')
    const ctx: string[] = []
    for (const repo of t.scope.repos.slice(0, 20)) {
      const log = (await tools.git(repo, ['log', '-15', '--date=short', '--pretty=%h %ad %an %s'])).stdout
      const st = (await tools.git(repo, ['status', '--short', '--branch'])).stdout
      const br = (await tools.git(repo, ['branch', '-vv', '--no-color'])).stdout
      ctx.push(`### 仓库 ${repo.split(/[\\/]/).pop()}\n最近提交：\n${log}\n状态：\n${st}\n分支：\n${br}`.slice(0, 6000))
    }
    const txt = await chat([{ role: 'system', content: `你是 GitLoom 的分析助手。只做分析与建议${t.allowWrite ? '' : '，不能执行任何写入或删除操作'}。用中文 Markdown 输出，第一行用「## 」写一句话结论；引用代码时写出文件和行号。` },
      { role: 'user', content: `${t.prompt}\n\n以下是只读工具（git log / status / branch）收集的上下文：\n\n${ctx.join('\n\n')}` }])
    return txt.trim().startsWith('#') ? txt.trim() : `## ${t.name}\n\n${txt.trim()}`
  }
}
export { templateOf }
