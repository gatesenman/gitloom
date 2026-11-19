/** Fire matching event rules after a successful git op — never throws into the git path. */
import { SAFE_DEFAULT_CHECKS } from '@shared/health'
import type { HealthReport } from '@shared/health'
import {
  type TriggerEvent, type EventRule, type RuleRunStatus,
  eventFromRunLabel, rulesForEvent, ACTION_LABELS
} from '@shared/eventRules'
import { loadRules, patchLastRun } from './eventRulesStore'

export type ToastFn = (kind: 'ok' | 'err' | 'info', text: string) => void

export interface FireCtx {
  projectId: string
  projectRoot?: string | null
  repo: string | null
  event: TriggerEvent
  toast?: ToastFn
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return String(e)
}

/** Map run() label → event and fire (no-op if label is not a trigger). */
export function fireAfterRunSuccess(opts: {
  label: string
  projectId: string | null | undefined
  projectRoot?: string | null
  repo: string | null
  toast?: ToastFn
}): void {
  const event = eventFromRunLabel(opts.label)
  if (!event || !opts.projectId || !opts.repo) return
  void fireEventRules({
    projectId: opts.projectId,
    projectRoot: opts.projectRoot,
    repo: opts.repo,
    event,
    toast: opts.toast
  })
}

let chain: Promise<void> = Promise.resolve()

/** Queue rule runs so overlapping pull/push don't stampede health. */
export function fireEventRules(ctx: FireCtx): Promise<void> {
  const job = async () => {
    try {
      await runMatching(ctx)
    } catch {
      /* never surface to git UI */
    }
  }
  chain = chain.then(job, job)
  return chain
}

async function runMatching(ctx: FireCtx): Promise<void> {
  const { projectId, projectRoot, repo, event, toast } = ctx
  if (!repo) return
  const state = loadRules(projectId)
  const matched = rulesForEvent(state.rules, event)
  for (const rule of matched) {
    const result = await runOne(rule, { projectId, projectRoot, repo })
    patchLastRun(projectId, rule.id, { at: Date.now(), status: result.status, message: result.message })
    if (result.status === 'err' && toast) {
      toast('err', `事件规则「${rule.name || ACTION_LABELS[rule.action]}」失败：${result.message || '未知错误'}`)
    }
  }
  if (matched.length) {
    try { window.dispatchEvent(new CustomEvent('gitloom:event-rules-changed', { detail: { projectId } })) } catch { /* */ }
  }
}

async function runOne(
  rule: EventRule,
  ctx: { projectId: string; projectRoot?: string | null; repo: string }
): Promise<{ status: RuleRunStatus; message?: string }> {
  try {
    if (rule.action === 'health') return await runHealth(ctx.repo, ctx.projectRoot)
    if (rule.action === 'wiki') return await runWiki(ctx.projectRoot, ctx.repo)
    if (rule.action === 'log') return runLog(rule, ctx.repo)
    return { status: 'skip', message: '未知动作' }
  } catch (e) {
    return { status: 'err', message: errMsg(e) }
  }
}

type Api = {
  healthRun?: (opts: unknown) => Promise<HealthReport>
  wikiStatus?: (root: string, repo: string) => Promise<{ exists?: boolean; settings?: { enabledAuto?: boolean } }>
  wikiIngest?: (root: string, repo: string, n: number) => Promise<{ message?: string }>
}

function api(): Api {
  return (window as unknown as { api?: Api }).api ?? {}
}

async function runHealth(repo: string, projectRoot?: string | null): Promise<{ status: RuleRunStatus; message?: string }> {
  const a = api()
  if (!a.healthRun) return { status: 'skip', message: '当前版本无体检 API' }
  const report = await a.healthRun({
    repo,
    projectRoot: projectRoot || undefined,
    scope: 'working',
    checks: [...SAFE_DEFAULT_CHECKS]
  })
  const open = report.summary?.open ?? report.findings?.filter((f) => f.status === 'open').length ?? 0
  return { status: 'ok', message: open ? `体检完成，未关闭 ${open} 项` : '体检完成，暂无未关闭项' }
}

async function runWiki(projectRoot: string | null | undefined, repo: string): Promise<{ status: RuleRunStatus; message?: string }> {
  if (!projectRoot) return { status: 'skip', message: '无项目根目录' }
  const a = api()
  if (!a.wikiStatus || !a.wikiIngest) return { status: 'skip', message: '当前版本无 Wiki API' }
  const st = await a.wikiStatus(projectRoot, repo)
  if (!st?.exists) return { status: 'skip', message: '尚未建立项目 Wiki' }
  const r = await a.wikiIngest(projectRoot, repo, 8)
  return { status: 'ok', message: r?.message || '已轻量更新 Wiki' }
}

function runLog(rule: EventRule, repo: string): { status: RuleRunStatus; message?: string } {
  const base = repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || repo
  const line = `${new Date().toLocaleString('zh-CN')} · ${rule.name} · ${base}`
  try {
    const key = 'gitloom.eventRules.runLog'
    const prev = JSON.parse(localStorage.getItem(key) || '[]') as unknown
    const list = Array.isArray(prev) ? prev.filter((x): x is string => typeof x === 'string') : []
    list.unshift(line)
    localStorage.setItem(key, JSON.stringify(list.slice(0, 100)))
  } catch { /* */ }
  return { status: 'ok', message: `已记录：${base}` }
}
