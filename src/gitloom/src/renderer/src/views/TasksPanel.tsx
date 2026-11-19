// 0.6.1 AI 定时任务 (自动化 → AI 定时任务). Analysis-only by default; runs locally while GitLoom is open.
import React, { useEffect, useMemo, useState } from 'react'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Markdown } from '../components/ui'
import type { AiTaskDef, TasksState, TaskRun, Schedule, TaskScope, TemplateId } from '../../../shared/tasks'
import { nextRun, scheduleLabel, WEEK_CN } from '../../../shared/schedule'

interface TemplateDef { id: TemplateId; name: string; desc: string; prompt: string; schedule: Schedule; needs?: 'issues' }
const api = window.api as unknown as {
  tasksState(): Promise<TasksState>; tasksTemplates(): Promise<TemplateDef[]>; tasksSave(t: AiTaskDef): Promise<TasksState>
  tasksRemove(id: string): Promise<TasksState>; tasksRun(id: string, trigger?: string): Promise<TaskRun | null>
  tasksConnector(c: { url: string; authHeader?: string; token?: string | null }): Promise<TasksState>; onTasksChanged(cb: (s: TasksState) => void): () => void
}
const fmt = (t?: number | null) => t ? new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const STATUS: Record<TaskRun['status'], string> = { running: '运行中…', ok: '已完成', error: '出错', blocked: '未运行' }
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

const TPL_IC: Record<string, string> = {
  issues: 'flame', security: 'shield', branches: 'branch',
  deps: 'box', 'stale-pr': 'pr', bigfiles: 'lfs', changelog: 'file-text',
  coverage: 'state', license: 'file', 'secrets-drift': 'lock', 'release-checklist': 'checklist'
}
const TPL_SAMPLE: Record<string, string> = {
  issues: '## 昨日命中 12 条 / 分成 3 类根因\n### 1. 列表页主线程同步读文件（7 条）\n- 样例单号：`BUG-1024`\n- 可疑：`src/list/loader.ts` · `loadAll()`',
  security: '## 本次 4 条，其中高危 1 条\n### 高危（1）\n- **本周新增** · **SQL 拼接** — `src/db/users.js:3`\n  - 修复建议：改用参数化查询',
  branches: '## 3 个分支超过 30 天没动，其中 2 个建议删除\n### 建议删除（2）\n- `feature/old-banner` · 已合并进 main：是 · 未推送提交：无'
}
const rel = (t: number) => { const m = Math.round((t - Date.now()) / 60000); if (m < 1) return '马上'; if (m < 60) return `${m} 分钟后`; const h = Math.round(m / 60); return h < 48 ? `约 ${h} 小时后` : `约 ${Math.round(h / 24)} 天后` }
const fmtFull = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK_CN[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const headline = (md: string) => /^##\s+(.+)$/m.exec(md)?.[1]?.replace(/\*\*/g, '') ?? ''
type Tone = 'ok' | 'warn' | 'danger' | 'info'
const toneOf = (h: string, status?: TaskRun['status']): Tone => status === 'error' ? 'danger' : status === 'blocked' || /需先|没有选择|需要先/.test(h) ? 'warn' : /无命中|未发现|很干净|其中高危 0 条|其中 0 个|依赖面干净|没有明显烂尾|未发现明显/.test(h) ? 'ok' : /高危 [1-9]/.test(h) ? 'danger' : /建议删除|命中/.test(h) ? 'warn' : 'info'

export default function TasksPanel() {
  const { settings, setView } = useApp()
  const [st, setSt] = useState<TasksState | null>(null)
  const [tpls, setTpls] = useState<TemplateDef[]>([])
  const [edit, setEdit] = useState<AiTaskDef | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [picker, setPicker] = useState(false)
  const [conn, setConn] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [showTpls, setShowTpls] = useState(false)
  const [, tick] = useState(0)
  const aiReady = !!(settings?.ai && ((settings.ai.profiles?.length ?? 0) > 0 || settings.ai.baseUrl))
  useEffect(() => {
    let cancelled = false
    const load = () => {
      if (cancelled) return
      void api.tasksState().then((s) => { if (!cancelled) setSt(s) })
      void api.tasksTemplates().then((t) => { if (!cancelled) setTpls(t) })
    }
    // Defer FS/IPC so the 定时任务 chrome can paint before the first state round-trip.
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
    const id = typeof w.requestIdleCallback === 'function' ? w.requestIdleCallback(load, { timeout: 600 }) : window.setTimeout(load, 0)
    const unsub = api.onTasksChanged((s) => { if (!cancelled) setSt(s) })
    return () => {
      cancelled = true
      if (typeof w.requestIdleCallback === 'function') w.cancelIdleCallback?.(id as number)
      else window.clearTimeout(id as number)
      unsub()
    }
  }, [])
  useEffect(() => { const h = setInterval(() => tick((x) => x + 1), 60000); return () => clearInterval(h) }, [])
  useEffect(() => { if (!picker) return; const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as HTMLElement).closest('.tasks-new')) setPicker(false) }; window.addEventListener('mousedown', close); window.addEventListener('keydown', close); return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close) } }, [picker])
  const scopes = useScopes()
  if (!st) return <div className="tasks"><div className="us-loading"><span>加载任务…</span><div className="us-skel"><i /><i /></div></div></div>
  const fresh = (p: Partial<AiTaskDef>): AiTaskDef => ({ id: `t${Date.now().toString(36)}`, name: '', prompt: '', template: null, scope: scopes[0] ?? { kind: 'repo', label: '（未选择）', repos: [] }, schedule: { kind: 'daily', time: '09:00' }, notify: true, allowWrite: false, enabled: true, createdAt: Date.now(), updatedAt: Date.now(), ...p })
  const fromTpl = (tpl: TemplateDef) => fresh({ name: tpl.name, prompt: tpl.prompt, template: tpl.id, schedule: tpl.schedule })
  const runsOf = (id: string) => st.runs.filter((r) => r.taskId === id).sort((a, b) => b.startedAt - a.startedAt)
  const selTask = st.tasks.find((t) => t.id === sel)
  return (
    <div className="tasks" data-testid="tasks">
      <div className="tasks-bar">
        <span className="tasks-note" title="任务只在 GitLoom 打开时于本机运行；关闭期间错过的会标记「已错过」，不会自动补跑。"><Icon name="lock" size={12} />本机运行 · 默认只读，不改动仓库</span>
        <span className="spacer" />
        <button className={`btn btn-sm ${st.connector.url ? '' : 'btn-ghost'}`} data-testid="tasks-connector" title={st.connector.url ? `已接入：${st.connector.url}` : '「线上问题日志日报」需要先接入你们的问题上报平台'} onClick={() => setConn(true)}><Icon name={st.connector.url ? 'check' : 'link'} size={13} />{st.connector.url ? '问题平台已接入' : '接入问题平台'}</button>
        <button className="btn btn-sm" data-testid="tasks-ai-create" title={aiReady ? '用一句话让 AI 起草任务名称、时间与提示词' : '未配置 AI 时仍可打开表单手动填写'} onClick={() => setAiOpen(true)}><Icon name="ai" size={13} />AI 创建任务</button>
        <div className="tasks-new">
          <button className="btn btn-sm btn-primary" data-testid="tasks-new" aria-haspopup="menu" aria-expanded={picker} onClick={() => setPicker(!picker)}><Icon name="plus" size={13} />新建任务<Icon name="down" size={12} /></button>
          {picker && <div className="menu tn-menu" role="menu" data-testid="tasks-new-menu">
            <div className="tn-h">从模板开始</div>
            {tpls.map((tpl) => <button key={tpl.id} role="menuitem" data-testid={`tasks-new-${tpl.id}`} onClick={() => { setPicker(false); setEdit(fromTpl(tpl)) }}><span className="tn-ic"><Icon name={TPL_IC[tpl.id] || 'wand'} size={14} /></span><span><b>{tpl.name}</b><small>{tpl.desc}</small></span></button>)}
            <div className="tn-sep" />
            <button role="menuitem" data-testid="tasks-new-blank" onClick={() => { setPicker(false); setEdit(fresh({})) }}><span className="tn-ic"><Icon name="wand" size={14} /></span><span><b>空白任务</b><small>自己写提示词，需配置 AI 模型</small></span></button>
          </div>}
        </div>
      </div>
      {!st.tasks.length && <div className="tasks-empty" data-testid="tasks-empty">
        <span className="us-empty-ic"><Icon name="clock" size={22} /></span>
        <b>还没有定时任务</b>
        <p>选一个模板，或用「AI 创建任务」用一句话起草；一分钟就能让 GitLoom 每天/每周自动帮你查一遍。</p>
        <div className="tasks-tpls">{tpls.map((tpl) => <button key={tpl.id} className="tpl-card" data-testid={`tpl-${tpl.id}`} onClick={() => setEdit(fromTpl(tpl))} title={`用「${tpl.name}」模板新建`}>
          <span className="tn-ic"><Icon name={TPL_IC[tpl.id] || 'wand'} size={16} /></span><b>{tpl.name}</b><span className="muted">{tpl.desc}</span><span className="tpl-meta"><Icon name="clock" size={11} />{scheduleLabel(tpl.schedule)}{tpl.needs === 'issues' && <> · 需接入问题平台</>}</span><span className="tpl-go">使用模板 →</span></button>)}</div>
      </div>}
      {!!st.tasks.length && (
        <div className="tasks-tpl-more" data-testid="tasks-tpl-more">
          <button type="button" className="link small" onClick={() => setShowTpls((v) => !v)} aria-expanded={showTpls}>
            {showTpls ? '收起模板库' : `浏览全部模板（${tpls.length}）`}
          </button>
          {showTpls && <div className="tasks-tpls">{tpls.map((tpl) => <button key={tpl.id} className="tpl-card" data-testid={`tpl-${tpl.id}`} onClick={() => setEdit(fromTpl(tpl))} title={`用「${tpl.name}」模板新建`}>
            <span className="tn-ic"><Icon name={TPL_IC[tpl.id] || 'wand'} size={16} /></span><b>{tpl.name}</b><span className="muted">{tpl.desc}</span><span className="tpl-meta"><Icon name="clock" size={11} />{scheduleLabel(tpl.schedule)}{tpl.needs === 'issues' && <> · 需接入问题平台</>}</span><span className="tpl-go">使用模板 →</span></button>)}</div>}
        </div>
      )}
      <div className="task-list" data-testid="task-list">
        {st.tasks.map((t) => {
          const last = runsOf(t.id)[0], running = st.running.includes(t.id), nx = t.enabled ? nextRun(t.schedule, Date.now()) : null
          const h = last && last.status !== 'running' ? headline(last.markdown) : ''
          const tone = last ? (last.status === 'running' ? 'info' : toneOf(h, last.status)) : null
          return (
            <div key={t.id} className={`task-row tone-${tone ?? 'none'} ${sel === t.id ? 'on' : ''}`} data-testid="task-row" role="button" tabIndex={0} aria-pressed={sel === t.id} title="点击查看运行结果"
              onClick={() => setSel(sel === t.id ? null : t.id)} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); setSel(sel === t.id ? null : t.id) } }}>
              <span className="tc-ic"><Icon name={t.template ? TPL_IC[t.template] : 'wand'} size={16} /></span>
              <div className="tr-main">
                <div className="tc-title"><b>{t.name}</b>{t.template && <em className="hc-tag" title="由内置模板创建，可随意修改">模板</em>}{t.allowWrite && <em className="hc-tag warn" title="已允许此任务执行写入命令">可写</em>}{!t.enabled && <em className="hc-tag" title="不会按时间自动运行，仍可手动运行">已停用</em>}</div>
                <div className="tc-badges">
                  <span className="bdg" title="运行频率"><Icon name="repeat" size={11} />{scheduleLabel(t.schedule)}</span>
                  <span className="bdg" title={nx ? fmtFull(nx) : '没有安排定时运行'}><Icon name="clock" size={11} />{nx ? `下次 ${fmt(nx)}` : t.enabled ? '仅手动' : '定时已停用'}</span>
                  <span className="bdg" title={t.scope.repos.join('\n')}><Icon name="repo" size={11} />{t.scope.label}{t.scope.repos.length > 1 ? ` · ${t.scope.repos.length} 个仓库` : ''}</span>
                </div>
              </div>
              <div className="tr-last" data-testid="task-last" title={h || '最近一次运行'}>{last ? <><span className={`bdg tl-st tone-${tone}`}><span className="dot" />{running ? '运行中…' : STATUS[last.status]}</span><span className="tl-when">{fmt(last.startedAt)}</span>{h && <span className="tl-h">{h}</span>}</> : <span className="bdg muted">尚未运行</span>}</div>
              <div className="tr-act" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                {t.missedAt ? <button className="btn btn-sm warn" data-testid="task-missed" title={`原定 ${fmt(t.missedAt)} 运行时 GitLoom 未打开`} disabled={running} onClick={() => { setSel(t.id); void api.tasksRun(t.id, 'missed') }}><Icon name="warn" size={12} />已错过，立即运行</button>
                  : <button className="btn btn-sm" data-testid="task-run" disabled={running} title="立即运行一次" onClick={() => { setSel(t.id); void api.tasksRun(t.id) }}><Icon name="play" size={12} />{running ? '运行中…' : '运行'}</button>}
                <button className="btn btn-sm btn-ghost icon-only" data-testid="task-edit" title="编辑" aria-label="编辑" onClick={() => setEdit({ ...t })}><Icon name="settings" size={13} /></button>
                <button className="btn btn-sm btn-ghost icon-only" data-testid="task-copy" title="复制为新任务" aria-label="复制为新任务" onClick={() => setEdit({ ...t, id: `t${Date.now().toString(36)}`, name: `${t.name}（副本）`, missedAt: null, handledUntil: undefined, createdAt: Date.now() })}><Icon name="copy" size={13} /></button>
                <button className="btn btn-sm btn-ghost icon-only danger" data-testid="task-del" title="删除任务及其运行记录" aria-label="删除" onClick={() => { if (confirm(`删除任务「${t.name}」及其运行记录？`)) void api.tasksRemove(t.id) }}><Icon name="trash" size={13} /></button>
              </div>
            </div>
          )
        })}
      </div>
      {selTask && <RunHistory task={selTask} runs={runsOf(selTask.id)} running={st.running.includes(selTask.id)} onRun={() => void api.tasksRun(selTask.id)} />}
      {edit && <Editor task={edit} tpl={tpls.find((x) => x.id === edit.template)} scopes={scopes} connectorReady={!!st.connector.url} onClose={() => setEdit(null)} onSave={async (task) => { await api.tasksSave({ ...task, updatedAt: Date.now() }); setEdit(null); setSel(task.id) }} />}
      {conn && <Connector cur={st.connector} onClose={() => setConn(false)} />}
      {aiOpen && <AiCreateModal aiReady={aiReady} scopes={scopes} onClose={() => setAiOpen(false)} onDraft={(d) => { setAiOpen(false); setEdit(fresh(d)) }} onOpenSettings={() => setView('settings')} />}
    </div>
  )
}

/** Split a report into header / intro / collapsible "###" groups / trailing notes. */
function parseReport(md: string) {
  const lines = md.split('\n')
  let title = '', i = 0
  const intro: string[] = [], groups: { title: string; body: string[] }[] = [], notes: string[] = []
  for (; i < lines.length; i++) { const m = /^##\s+(.+)$/.exec(lines[i]); if (m) { title = m[1]; i++; break } if (lines[i].trim()) { i = 0; break } }
  for (; i < lines.length; i++) {
    const l = lines[i], g = /^###\s+(.+)$/.exec(l)
    if (g) { groups.push({ title: g[1], body: [] }); continue }
    if (/^>\s?/.test(l)) { notes.push(l.replace(/^>\s?/, '')); continue }
    ;(groups.length ? groups[groups.length - 1].body : intro).push(l)
  }
  return { title, intro: intro.join('\n').trim(), groups, notes }
}
const groupTone = (t: string): Tone => /高危|建议删除/.test(t) ? (/高危/.test(t) ? 'danger' : 'warn') : /中危|待人工/.test(t) ? 'warn' : /建议保留/.test(t) ? 'ok' : 'info'

function Report({ run }: { run: TaskRun }) {
  const r = useMemo(() => parseReport(run.markdown || ''), [run.markdown])
  const [closed, setClosed] = useState<Record<number, boolean>>({})
  const [copied, setCopied] = useState(false)
  useEffect(() => { setClosed({}); setCopied(false) }, [run.id])
  const tone = toneOf(r.title, run.status)
  const allClosed = r.groups.length > 0 && r.groups.every((_, k) => closed[k])
  const copy = () => { void navigator.clipboard.writeText(run.markdown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }
  const dur = run.finishedAt ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000)) : null
  return (
    <div className="rp" data-testid="run-result">
      <div className={`rp-head tone-${tone}`}>
        <span className="rp-ic"><Icon name={tone === 'ok' ? 'ok' : tone === 'danger' ? 'error' : tone === 'warn' ? 'warn' : 'info'} size={20} /></span>
        <div className="rp-ht"><div className="rp-title" data-testid="run-headline">{r.title || STATUS[run.status]}</div>
          <div className="rp-meta">{fmtFull(run.startedAt)}{dur ? ` · 用时 ${dur} 秒` : ''} · {run.trigger === 'schedule' ? '定时运行' : run.trigger === 'missed' ? '补跑' : '手动运行'}{r.groups.length ? ` · ${r.groups.length} 组` : ''}</div></div>
        <div className="rp-tools">
          {r.groups.length > 1 && <button className="btn btn-sm btn-ghost" data-testid="run-toggle" onClick={() => setClosed(allClosed ? {} : Object.fromEntries(r.groups.map((_, k) => [k, true])))} title={allClosed ? '展开全部分组' : '收起全部分组'}>{allClosed ? '全部展开' : '全部收起'}</button>}
          <button className="btn btn-sm" data-testid="run-copy" onClick={copy} title="复制完整报告（Markdown），可直接粘贴到群聊或文档"><Icon name={copied ? 'check' : 'copy'} size={12} />{copied ? '已复制' : '复制报告'}</button>
        </div>
      </div>
      {r.intro && <div className="rp-intro"><Markdown text={r.intro} /></div>}
      {r.groups.map((g, k) => {
        const m = /^(.*?)（(\d+)(?: 条)?）$/.exec(g.title)
        const body = g.body.join('\n').trim()
        return (
          <section key={k} className={`rp-g tone-${groupTone(g.title)} ${closed[k] ? 'closed' : ''}`} data-testid="run-group">
            <button className="rp-gh" aria-expanded={!closed[k]} onClick={() => setClosed({ ...closed, [k]: !closed[k] })} title={closed[k] ? '展开' : '收起'}>
              <Icon name="chevron" size={12} className="rp-chev" /><span className="rp-gt">{m ? m[1] : g.title}</span>{m && <span className="rp-cnt">{m[2]}</span>}
            </button>
            {!closed[k] && <div className="rp-gb">{body && body !== '无' ? <Markdown text={body} /> : <span className="muted">无</span>}</div>}
          </section>)
      })}
      {r.notes.length > 0 && <div className="rp-notes">{r.notes.map((n, k) => <div key={k}><Icon name="info" size={12} /><Markdown text={n} /></div>)}</div>}
    </div>
  )
}

function RunHistory({ task, runs, running, onRun }: { task: AiTaskDef; runs: TaskRun[]; running: boolean; onRun(): void }) {
  const [i, setI] = useState(0)
  useEffect(() => setI(0), [runs[0]?.id])
  const r = runs[i]
  return (
    <div className="run-hist" data-testid="run-history">
      <div className="rh-top"><b>运行结果</b><span className="muted">· {task.name}</span><span className="spacer" />
        {runs.length > 1 && <div className="rh-tabs" role="tablist" aria-label="历史运行">{runs.slice(0, 12).map((x, k) => <button key={x.id} role="tab" aria-selected={k === i} className={k === i ? 'on' : ''} title={`${STATUS[x.status]}${x.trigger === 'schedule' ? ' · 定时' : x.trigger === 'missed' ? ' · 补跑' : ''}`} onClick={() => setI(k)}><span className={`dot st-${x.status}`} />{fmt(x.startedAt)}</button>)}</div>}
      </div>
      {!r ? <div className="us-empty sm"><b>还没有运行记录</b><p>先手动运行一次，看看结果是不是你想要的。</p><button className="btn btn-primary" disabled={running} onClick={onRun}><Icon name="play" size={12} />立即运行</button></div>
        : r.status === 'running' ? <div className="rp" data-testid="run-result"><div className="us-loading"><span>运行中…正在本机只读分析</span><div className="us-skel"><i /><i /><i /></div></div></div>
        : <Report run={r} />}
    </div>
  )
}

function useScopes(): TaskScope[] {
  const { projects, active } = useApp()
  return useMemo(() => {
    const out: TaskScope[] = []
    const all = projects.flatMap((p) => p.repos.filter((r) => r.initialized !== false && !p.hidden.includes(r.path)).map((r) => ({ p, r })))
    if (active) out.push({ kind: 'repo', label: base(active), repos: [active] })
    for (const { r } of all) if (r.path !== active) out.push({ kind: 'repo', label: base(r.path), repos: [r.path] })
    for (const p of projects) {
      const repos = p.repos.filter((r) => !p.hidden.includes(r.path)).map((r) => r.path)
      if (repos.length) out.push({ kind: 'project', label: `项目：${p.name}`, repos })
      const groups = new Map<string, string[]>()
      for (const r of p.repos) { const parts = r.rel.split('/'); if (parts.length > 1) { const g = parts.slice(0, -1).join('/'); groups.set(g, [...(groups.get(g) ?? []), r.path]) } }
      for (const [g, rs] of groups) if (rs.length > 1) out.push({ kind: 'group', label: `分组：${p.name}/${g}`, repos: rs })
    }
    return out
  }, [projects, active])
}

const TIMES = Array.from({ length: 96 }, (_, k) => `${String(Math.floor(k / 4)).padStart(2, '0')}:${String((k % 4) * 15).padStart(2, '0')}`)

function Editor({ task, tpl, scopes, connectorReady, onClose, onSave }: { task: AiTaskDef; tpl?: TemplateDef; scopes: TaskScope[]; connectorReady: boolean; onClose(): void; onSave(t: AiTaskDef): Promise<void> }) {
  const [t, setT] = useState(task)
  const [showTpl, setShowTpl] = useState(false)
  const [saving, setSaving] = useState(false)
  const set = (p: Partial<AiTaskDef>) => setT({ ...t, ...p })
  const s = t.schedule
  const time = s.kind === 'manual' ? '09:00' : s.time
  const setKind = (k: Schedule['kind']) => set({ schedule: k === 'manual' ? { kind: 'manual' } : k === 'weekly' ? { kind: 'weekly', days: s.kind === 'weekly' ? s.days : [1], time } : { kind: k, time } })
  const scopeKey = (x: TaskScope) => `${x.kind}:${x.label}`
  const opts = scopes.some((x) => scopeKey(x) === scopeKey(t.scope)) ? scopes : [t.scope, ...scopes]
  const times = TIMES.includes(time) ? TIMES : [...TIMES, time].sort()
  const nx = t.enabled ? nextRun(s, Date.now()) : null
  const problems = [!t.name.trim() && '请填写名称', !t.scope.repos.length && '请选择运行范围', !t.template && !t.prompt.trim() && '请写提示词', s.kind === 'weekly' && !s.days.length && '每周至少选一天'].filter(Boolean) as string[]
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  const save = async () => { if (problems.length) return; setSaving(true); try { await onSave(t) } finally { setSaving(false) } }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal task-editor te2" data-testid="task-editor" role="dialog" aria-modal="true" aria-label={task.name ? '编辑任务' : '新建任务'} onClick={(e) => e.stopPropagation()}>
        <div className="te-head">
          <span className="tc-ic"><Icon name={t.template ? TPL_IC[t.template] : 'wand'} size={16} /></span>
          <div><h3>{task.name && task.createdAt !== task.updatedAt ? '编辑任务' : '新建任务'}</h3><div className="muted small">{tpl ? `基于模板「${tpl.name}」· 结论由程序确定性计算，AI 只做判断与归纳` : '自定义任务：按你的提示词让 AI 只读分析仓库'}</div></div>
          <span className="spacer" /><button className="btn btn-sm btn-ghost icon-only" onClick={onClose} title="关闭（Esc）" aria-label="关闭"><Icon name="x" size={14} /></button>
        </div>
        <div className="te-body">
          <section className="te-sec">
            <h4><span className="te-n">1</span>做什么</h4>
            <label className="te-f"><span>名称</span><input data-testid="te-name" autoFocus value={t.name} onChange={(e) => set({ name: e.target.value })} placeholder="例如：每日提交小结" /></label>
            <label className="te-f" title="告诉 AI 要分析什么、输出成什么样子"><span>提示词{tpl && t.prompt !== tpl.prompt && <button type="button" className="link small" onClick={() => set({ prompt: tpl.prompt })} title="把提示词恢复为模板原文">恢复模板原文</button>}</span>
              <textarea data-testid="te-prompt" rows={tpl ? 9 : 6} value={t.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder={'排查内容：\n- …\n\n要求：\n- 只读分析，不修改任何东西\n\n输出格式：\n- 开头一句总结'} /></label>
            {tpl && <div className={`te-tpl ${showTpl ? 'open' : ''}`} data-testid="te-tpl-preview">
              <button type="button" className="te-tpl-h" aria-expanded={showTpl} onClick={() => setShowTpl(!showTpl)}><Icon name="chevron" size={12} className="rp-chev" />模板预览：结果大概长这样</button>
              {showTpl && <div className="te-tpl-b"><Markdown text={TPL_SAMPLE[tpl.id] ?? ''} /><div className="muted small">示例数据，仅示意格式。</div></div>}
            </div>}
          </section>
          <section className="te-sec">
            <h4><span className="te-n">2</span>在哪里、什么时候</h4>
            <label className="te-f" title="任务会在这些仓库里运行（只读）"><span>范围</span><select data-testid="te-scope" value={scopeKey(t.scope)} onChange={(e) => set({ scope: opts.find((x) => scopeKey(x) === e.target.value)! })}>{opts.map((x) => <option key={scopeKey(x)} value={scopeKey(x)}>{x.label}（{x.repos.length} 个仓库）</option>)}</select></label>
            <div className="te-f" title="GitLoom 打开时按此时间在本机运行"><span>频率</span>
              <div className="te-row">
                <select data-testid="te-kind" value={s.kind} onChange={(e) => setKind(e.target.value as Schedule['kind'])}><option value="daily">每天</option><option value="weekdays">工作日（周一至周五）</option><option value="weekly">每周</option><option value="manual">仅手动</option></select>
                {s.kind !== 'manual' && <select data-testid="te-time" className="te-time" value={time} onChange={(e) => set({ schedule: { ...s, time: e.target.value } as Schedule })} title="24 小时制">{times.map((x) => <option key={x} value={x}>{x}</option>)}</select>}
              </div>
              {s.kind === 'weekly' && <div className="te-days" role="group" aria-label="每周哪几天">{[1, 2, 3, 4, 5, 6, 0].map((i) => <button type="button" key={i} aria-pressed={s.days.includes(i)} className={s.days.includes(i) ? 'on' : ''} onClick={() => set({ schedule: { ...s, days: s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i] } })}>周{WEEK_CN[i]}</button>)}</div>}
            </div>
            <div className={`te-next ${nx ? '' : 'off'}`} data-testid="te-next" aria-live="polite"><Icon name="clock" size={13} />{nx ? <>下次运行：<b>{fmtFull(nx)}</b><span className="muted">（{rel(nx)}）</span></> : s.kind === 'manual' ? '仅手动运行，不会自动执行' : !t.enabled ? '定时已停用，只能手动运行' : '请至少选择一天'}</div>
          </section>
          <section className="te-sec">
            <h4><span className="te-n">3</span>通知与权限</h4>
            <label className="te-chk"><input type="checkbox" checked={t.enabled} onChange={(e) => set({ enabled: e.target.checked })} /><span><b>启用定时</b><small>关闭后只能手动运行</small></span></label>
            <label className="te-chk"><input type="checkbox" checked={t.notify} onChange={(e) => set({ notify: e.target.checked })} /><span><b>完成后发送桌面通知</b><small>点击通知可直接打开结果</small></span></label>
            <label className="te-chk" title="默认只能用只读工具（git log/branch/diff、读文件、搜索、依赖审计）"><input type="checkbox" data-testid="te-write" checked={t.allowWrite} onChange={(e) => set({ allowWrite: e.target.checked })} /><span><b>允许此任务执行写入命令</b><small>默认只读：git log/branch/diff、读文件、搜索、依赖审计</small></span></label>
            {t.allowWrite && <p className="te-warn" role="alert"><Icon name="warn" size={13} />开启后此任务可执行会修改仓库的 git 命令。内置模板始终只给建议，不会删除或修改任何东西。</p>}
            {t.template === 'issues' && !connectorReady && <p className="te-warn"><Icon name="info" size={13} />需先接入问题上报平台（右上角「接入问题平台」），否则任务不会运行。</p>}
          </section>
        </div>
        <div className="modal-foot"><span className="te-hint muted small">{problems[0] ?? ''}</span><span className="spacer" /><button className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" data-testid="te-save" disabled={problems.length > 0 || saving} title={problems.join('；') || '保存任务'} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></div>
      </div>
    </div>
  )
}


/** Draft a task from a short Chinese prompt via configured AI; fallback to blank form + tip. */
function AiCreateModal({ aiReady, scopes, onClose, onDraft, onOpenSettings }: {
  aiReady: boolean; scopes: TaskScope[]; onClose(): void; onDraft(p: Partial<AiTaskDef>): void; onOpenSettings(): void
}) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [manual, setManual] = useState(!aiReady)
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])

  const parseDraft = (text: string): Partial<AiTaskDef> | null => {
    const m = /\{[\s\S]*\}/.exec(text)
    if (!m) return null
    try {
      const j = JSON.parse(m[0]) as Record<string, unknown>
      const name = typeof j.name === 'string' ? j.name.trim() : ''
      const body = typeof j.prompt === 'string' ? j.prompt.trim() : (typeof j.body === 'string' ? j.body.trim() : '')
      if (!name && !body) return null
      let schedule: Schedule = { kind: 'daily', time: '09:00' }
      const sk = j.schedule
      if (sk && typeof sk === 'object') {
        const s = sk as Record<string, unknown>
        const kind = s.kind
        const time = typeof s.time === 'string' ? s.time : '09:00'
        if (kind === 'manual') schedule = { kind: 'manual' }
        else if (kind === 'weekdays') schedule = { kind: 'weekdays', time }
        else if (kind === 'weekly') {
          const days = Array.isArray(s.days) ? s.days.filter((d): d is number => typeof d === 'number') : [1]
          schedule = { kind: 'weekly', days: days.length ? days : [1], time }
        } else schedule = { kind: 'daily', time }
      } else if (typeof j.scheduleHint === 'string') {
        const h = j.scheduleHint
        if (/手动|仅手动/.test(h)) schedule = { kind: 'manual' }
        else if (/工作日/.test(h)) schedule = { kind: 'weekdays', time: '09:30' }
        else if (/每周/.test(h)) schedule = { kind: 'weekly', days: [1], time: '10:00' }
      }
      const scope = scopes[0] ?? { kind: 'repo' as const, label: '（未选择）', repos: [] as string[] }
      return { name: name || '未命名任务', prompt: body || prompt.trim(), schedule, template: null, scope, notify: true, allowWrite: false, enabled: true }
    } catch { return null }
  }

  const draftWithAi = async () => {
    if (!prompt.trim()) { setErr('请先用一句话描述要定期做什么'); return }
    if (!aiReady) { setManual(true); return }
    setBusy(true); setErr('')
    try {
      const sys = `你是 GitLoom 定时任务助手。用户用中文简述想定期做的只读分析。请只输出一个 JSON 对象（不要 markdown 围栏），字段：
{"name":"短名称","prompt":"完整中文提示词（含排查内容/要求/输出格式）","schedule":{"kind":"daily|weekdays|weekly|manual","time":"HH:MM","days":[1]},"scheduleHint":"给人看的频率说明"}
约束：只读分析、不改仓库；prompt 要可直接给仓库分析 AI 使用。`
      const text = await (window.api as unknown as { aiChat: (msgs: { role: string; content: string }[]) => Promise<string> }).aiChat([
        { role: 'system', content: sys },
        { role: 'user', content: prompt.trim() }
      ])
      const d = parseDraft(text || '')
      if (!d) {
        setErr('AI 返回无法解析，已为你打开可编辑表单，请手动改一下。')
        onDraft({ name: 'AI 草稿', prompt: prompt.trim() + (text ? `\n\n---\nAI 原文：\n${text}` : ''), template: null })
        return
      }
      onDraft(d)
    } catch (e) {
      setErr(`AI 调用失败：${e instanceof Error ? e.message : String(e)}。可改用下方手动创建。`)
      setManual(true)
    } finally { setBusy(false) }
  }

  const openManual = () => {
    onDraft({ name: '', prompt: prompt.trim(), template: null, schedule: { kind: 'daily', time: '09:00' } })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal task-editor te2" data-testid="tasks-ai-modal" role="dialog" aria-modal="true" aria-label="AI 创建任务" onClick={(e) => e.stopPropagation()}>
        <div className="te-head">
          <span className="tc-ic"><Icon name="ai" size={16} /></span>
          <div>
            <h3>AI 创建任务</h3>
            <div className="muted small">{aiReady ? '用一句话描述，AI 起草名称、时间与提示词；你可再编辑后保存' : '尚未配置 AI：可直接打开空白表单，或先去设置配置服务商'}</div>
          </div>
          <span className="spacer" /><button className="btn btn-sm btn-ghost icon-only" onClick={onClose} aria-label="关闭"><Icon name="x" size={14} /></button>
        </div>
        <div className="te-body">
          {!aiReady && (
            <p className="te-warn" data-testid="tasks-ai-fallback" role="note">
              <Icon name="info" size={13} />未检测到 AI 服务商。可<button type="button" className="link" onClick={onOpenSettings}>前往设置 → AI 模型</button>配置；或继续用手动表单。
            </p>
          )}
          <label className="te-f"><span>一句话需求</span>
            <textarea data-testid="tasks-ai-prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)}
              placeholder="例如：每周一上午检查各仓库依赖漏洞，按高危排序输出周报" /></label>
          {err && <p className="te-warn" role="alert">{err}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" data-testid="tasks-ai-manual" onClick={openManual}>打开表单手动创建</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          {aiReady
            ? <button className="btn btn-primary" data-testid="tasks-ai-go" disabled={busy || !prompt.trim()} onClick={() => void draftWithAi()}>{busy ? '起草中…' : 'AI 起草'}</button>
            : <button className="btn btn-primary" data-testid="tasks-ai-go-fallback" onClick={openManual}>打开编辑表单</button>}
        </div>
        {manual && !aiReady && <p className="muted small" style={{ padding: '0 16px 12px' }}>提示：配好 AI 后，同一入口可一键起草完整任务。</p>}
      </div>
    </div>
  )
}

function Connector({ cur, onClose }: { cur: TasksState['connector']; onClose(): void }) {
  const [url, setUrl] = useState(cur.url), [hdr, setHdr] = useState(cur.authHeader || 'Authorization'), [tok, setTok] = useState('')
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal task-editor" data-testid="connector" onClick={(e) => e.stopPropagation()}>
        <div className="te-head"><span className="tc-ic"><Icon name="link" size={16} /></span><div><h3>接入问题上报平台</h3><div className="muted small">供「线上问题日志日报」读取工单，只读，不会修改平台数据</div></div></div>
        <p className="muted">通用 HTTP/JSON 接口。地址可用 {'{since}'} {'{until}'} {'{page}'} {'{size}'} 占位，否则自动附加同名查询参数；会翻页拉全量。</p>
        <label>接口地址<input data-testid="cn-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://issues.example.com/api/tickets?since={since}&page={page}" /></label>
        <label title="Authorization 时自动加 Bearer 前缀">认证头<input value={hdr} onChange={(e) => setHdr(e.target.value)} /></label>
        <label title="用系统钥匙串加密保存，不写入日志">访问令牌<input data-testid="cn-token" type="password" value={tok} onChange={(e) => setTok(e.target.value)} placeholder={cur.hasToken ? '已保存（留空则不修改）' : '粘贴令牌'} /></label>
        <div className="modal-foot">
          {cur.url && <button className="btn btn-ghost" onClick={() => void api.tasksConnector({ url: '', token: null }).then(onClose)}>断开</button>}
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" data-testid="cn-save" onClick={() => void api.tasksConnector({ url: url.trim(), authHeader: hdr.trim(), token: tok ? tok : undefined }).then(onClose)}>保存</button>
        </div>
      </div>
    </div>
  )
}
