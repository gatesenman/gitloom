// AI enrichment for 变更可视化: grounded on the static facts + diff hunks, the model must answer with STRICT JSON
// (validated with zod; one retry with the validation errors). The JSON is converted into the same diff structures
// the static views use, so the renderer draws AI diagrams with the same components.
import { z } from 'zod'
import { posix } from 'path'
import type { DiffGraph, DiffStatus, GEdge, GNode, NodeKind, SeqDiagram, SeqItem, StateMachine, VizAIResult, VizResult, FlowEntry } from '../../shared/viz'
import type { FlowStep } from './facts'
import type { SideModel } from './model'
import { mergeSeq, type RawSeq } from './seq'

// ------------------------------------------------------------------------------------------------ schema
const Status = z.enum(['added', 'removed', 'modified', 'unchanged', 'moved'])
type StepT = { type: 'msg'; from: string; to: string; label: string; async?: boolean; ret?: boolean } | { type: 'alt' | 'loop' | 'opt' | 'par'; label: string; branches: { label: string; steps: StepT[] }[] }
const Step: z.ZodType<StepT> = z.lazy(() => z.union([
  z.object({ type: z.literal('msg'), from: z.string().min(1), to: z.string().min(1), label: z.string().max(80), async: z.boolean().optional(), ret: z.boolean().optional() }),
  z.object({ type: z.enum(['alt', 'loop', 'opt', 'par']), label: z.string().max(80), branches: z.array(z.object({ label: z.string().max(60), steps: z.array(Step).max(40) })).min(1).max(6) })
]))
const Participant = z.object({ id: z.string().min(1).max(60), name: z.string().min(1).max(40), kind: z.enum(['actor', 'class', 'module', 'external', 'service', 'db']).optional() })
const Seq = z.object({ participants: z.array(Participant).max(10), steps: z.array(Step).max(60) })
const Machine = z.object({ initial: z.string().optional(), states: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().max(40).optional() })).max(30), transitions: z.array(z.object({ from: z.string(), to: z.string(), event: z.string().max(40).optional() })).max(60) })
const Flow = z.object({ nodes: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(60), kind: z.enum(['start', 'end', 'step', 'decision', 'io']).optional() })).max(30), edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().max(30).optional() })).max(60) })
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional()

export const VizAISchema = z.object({
  headline: z.string().max(60).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  architecture: opt(z.object({
    layers: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().min(1).max(20), components: z.array(z.object({ id: z.string().min(1).max(60), name: z.string().min(1).max(30), status: Status, modules: z.array(z.string()).max(60).optional(), note: z.string().max(40).optional() })).max(12) })).min(1).max(7),
    links: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().max(30).optional(), status: Status })).max(40)
  })),
  sequences: opt(z.array(z.object({ id: z.string().min(1).max(60), title: z.string().min(1).max(40), fn: z.string().optional(), before: opt(Seq), after: opt(Seq) })).max(4)),
  states: opt(z.array(z.object({ id: z.string().min(1).max(60), name: z.string().min(1).max(40), before: opt(Machine), after: opt(Machine) })).max(4)),
  flows: opt(z.array(z.object({ id: z.string().min(1).max(60), title: z.string().min(1).max(40), before: opt(Flow), after: opt(Flow) })).max(3))
}).superRefine((v, ctx) => {
  // referential integrity: messages / transitions / edges must point at declared ids
  v.sequences?.forEach((s, i) => (['before', 'after'] as const).forEach((side) => {
    const d = s[side]; if (!d) return
    const ids = new Set(d.participants.map((p) => p.id))
    const walk = (steps: StepT[], path: string) => steps.forEach((st, k) => {
      if (st.type === 'msg') { for (const e of [st.from, st.to]) if (!ids.has(e)) ctx.addIssue({ code: 'custom', path: ['sequences', i, side, path + k], message: `参与者 "${e}" 未在 participants 中声明` }) }
      else st.branches.forEach((b, j) => walk(b.steps, `${path}${k}.branches.${j}.`))
    })
    walk(d.steps, 'steps.')
  }))
  v.states?.forEach((s, i) => (['before', 'after'] as const).forEach((side) => {
    const d = s[side]; if (!d) return
    const ids = new Set(d.states.map((x) => x.id))
    d.transitions.forEach((t, k) => { for (const e of [t.from, t.to]) if (!ids.has(e) && e !== '*') ctx.addIssue({ code: 'custom', path: ['states', i, side, 'transitions', k], message: `状态 "${e}" 未在 states 中声明` }) })
  }))
  v.flows?.forEach((f, i) => (['before', 'after'] as const).forEach((side) => {
    const d = f[side]; if (!d) return
    const ids = new Set(d.nodes.map((x) => x.id))
    d.edges.forEach((e, k) => { for (const x of [e.from, e.to]) if (!ids.has(x)) ctx.addIssue({ code: 'custom', path: ['flows', i, side, 'edges', k], message: `节点 "${x}" 未声明` }) })
  }))
  const comps = new Set(v.architecture?.layers.flatMap((l) => l.components.map((c) => c.id)) ?? [])
  v.architecture?.links.forEach((l, k) => { for (const x of [l.from, l.to]) if (!comps.has(x)) ctx.addIssue({ code: 'custom', path: ['architecture', 'links', k], message: `组件 "${x}" 未声明` }) })
})
export type VizAIJson = z.infer<typeof VizAISchema>

// ------------------------------------------------------------------------------------------------ JSON repair
/** Pull the JSON object out of a chatty / fenced / slightly broken model answer. */
export function repairJson(text: string): { value: unknown; repaired: boolean } {
  let t = text.trim()
  let repaired = false
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(t)
  if (fence) { t = fence[1].trim(); repaired = true }
  const first = t.indexOf('{'); const last = t.lastIndexOf('}')
  if (first > 0 || (last >= 0 && last < t.length - 1)) { t = t.slice(first, last + 1); repaired = true }
  try { return { value: JSON.parse(t), repaired } } catch { /* continue */ }
  let s = t
    .replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"\\])\/\/[^\n]*/g, '$1')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
  // balance brackets of a truncated answer
  const stack: string[] = []
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  if (inStr) s += '"'
  s = s.replace(/,\s*$/, '') + stack.reverse().join('')
  return { value: JSON.parse(s), repaired: true }
}

export function validateAI(text: string): { ok: true; data: VizAIJson; repaired: boolean } | { ok: false; errors: string[] } {
  let parsed: { value: unknown; repaired: boolean }
  try { parsed = repairJson(text) } catch (e) { return { ok: false, errors: [`不是合法 JSON：${(e as Error).message}`] } }
  const r = VizAISchema.safeParse(parsed.value)
  if (r.success) return { ok: true, data: r.data, repaired: parsed.repaired }
  return { ok: false, errors: r.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`) }
}

// ------------------------------------------------------------------------------------------------ prompt
const flowText = (steps: FlowStep[], ind = '', out: string[] = [], max = 40): string[] => {
  for (const s of steps) {
    if (out.length >= max) break
    if (s.t === 'stmt' || s.t === 'return' || s.t === 'throw') out.push(`${ind}${s.t === 'stmt' ? '' : s.t + ' '}${s.text}`)
    else if (s.t === 'if') s.branches.forEach((b) => { out.push(`${ind}${b.label === 'else' ? 'else' : 'if ' + b.label}:`); flowText(b.body, ind + '  ', out, max) })
    else if (s.t === 'loop') { out.push(`${ind}loop ${s.label}:`); flowText(s.body, ind + '  ', out, max) }
    else if (s.t === 'switch') { out.push(`${ind}switch ${s.label}:`); s.cases.forEach((c) => { out.push(`${ind}  case ${c.label}:`); flowText(c.body, ind + '    ', out, max) }) }
    else if (s.t === 'try') { out.push(`${ind}try:`); flowText(s.body, ind + '  ', out, max); s.catches.forEach((c) => { out.push(`${ind}${c.label}:`); flowText(c.body, ind + '  ', out, max) }) }
  }
  return out
}

export function buildVizPrompt(r: VizResult, before: SideModel, after: SideModel, hunks: string): { system: string; user: string } {
  const changedFns = r.flows.slice(0, 10).map((f) => {
    const a = after.fns.get(f.id); const b = before.fns.get(f.id)
    const callees = [...(after.calls.get(f.id)?.keys() ?? [])].slice(0, 10)
    return [`### ${f.label} [${f.status}] (${f.file})  id=${f.id}`,
      b ? `BEFORE:\n${flowText(b.f.flow, '  ').join('\n')}` : 'BEFORE: (不存在)',
      a ? `AFTER:\n${flowText(a.f.flow, '  ').join('\n')}` : 'AFTER: (已删除)',
      callees.length ? `调用: ${callees.join(', ')}` : ''].filter(Boolean).join('\n')
  }).join('\n\n')
  const comps = r.arch.nodes.filter((n) => n.kind === 'component').map((n) => `${n.id.slice(2)} [${n.status}] layer=${n.parent?.slice(2)} ${n.sub ?? ''}`).join('\n')
  const deps = r.arch.edges.filter((e) => e.status !== 'unchanged').map((e) => `${e.source.slice(2)} -> ${e.target.slice(2)} [${e.status}]`).join('\n')
  const states = r.states.map((s) => `${s.name} (${s.file}) [${s.status}] states=${s.graph.nodes.filter((n) => n.kind === 'state').map((n) => `${n.label}:${n.status}`).join(',')} transitions=${s.graph.edges.map((e) => `${e.source.slice(2)}->${e.target.slice(2)}(${e.label ?? ''}):${e.status}`).join(',')}`).join('\n')
  const files = r.files.slice(0, 60).map((f) => `${f.status} ${f.oldPath ? f.oldPath + ' -> ' : ''}${f.path}`).join('\n')
  const system = [
    '你是资深软件架构师，擅长正向/逆向架构可视化。根据给定的静态分析事实和 diff，为这次代码变更生成「改动前 / 改动后」的结构化图表数据。',
    '只输出一个 JSON 对象，不要 Markdown、不要解释文字。所有文字用简体中文，标签要短（≤12 个字）。',
    'JSON 结构：{"headline":"一句话标题(≤20字)","risk":"low|medium|high",',
    ' "architecture":{"layers":[{"id","name","components":[{"id","name","status":"added|removed|modified|unchanged","modules":["文件路径"],"note"}]}],"links":[{"from","to","label","status"}]},',
    ' "sequences":[{"id","title","fn":"静态函数 id","before":{"participants":[{"id","name","kind"}],"steps":[{"type":"msg","from","to","label"} | {"type":"alt|loop|opt|par","label","branches":[{"label","steps":[...]}]}]},"after":{...}}],',
    ' "states":[{"id","name","before":{"initial","states":[{"id","name"}],"transitions":[{"from","to","event"}]},"after":{...}}],',
    ' "flows":[{"id","title","before":{"nodes":[{"id","label","kind":"start|end|step|decision|io"}],"edges":[{"from","to","label"}]},"after":{...}}]}',
    '规则：1) 只描述真实存在的代码，参与者/组件尽量使用给定的静态 id 或文件路径；2) 新增的东西 before 为 null，删除的 after 为 null；',
    '3) sequences 选 1-3 条最重要的改动调用链，每条 ≤20 步；states 只包含真正的状态机；flows 是「业务流程」（用户视角的步骤），不是代码控制流，选 1-2 个；',
    '4) architecture 按职责分 3-6 层，每层 ≤8 个组件，标出新增/删除/改动；5) 所有 from/to 必须引用已声明的 id。'
  ].join('\n')
  const user = [
    `变更范围：${r.beforeLabel} → ${r.afterLabel}${r.filter ? `（路径：${r.filter}）` : ''}`,
    `改动文件：\n${files}`,
    `统计：${JSON.stringify(r.summary)}`,
    `静态组件（文件夹分层推断）：\n${comps}`,
    deps ? `组件依赖变化：\n${deps}` : '',
    states ? `静态状态机：\n${states}` : '',
    `改动最多的函数（控制流摘要）：\n${changedFns}`,
    `diff 片段：\n${hunks}`
  ].filter(Boolean).join('\n\n')
  return { system, user: user.slice(0, 48000) }
}

// ------------------------------------------------------------------------------------------------ convert
type Side<T> = T | null | undefined

function seqRaw(d: Side<z.infer<typeof Seq>>): RawSeq | null {
  if (!d) return null
  const participants = new Map(d.participants.map((p) => [p.id, { label: p.name, kind: p.kind ?? 'class' as const }]))
  const conv = (steps: StepT[], depth: number): SeqItem[] => steps.map((s) => s.type === 'msg'
    ? { t: 'msg' as const, from: s.from, to: s.to, label: s.label, status: 'unchanged' as DiffStatus, ...(s.ret ? { ret: true } : {}), ...(s.async ? { async: true } : {}), depth }
    : { t: 'frame' as const, kind: s.type, label: s.label, status: 'unchanged' as DiffStatus, branches: s.branches.map((b) => ({ label: b.label, items: conv(b.steps, depth) })) })
  return { participants, items: conv(d.steps, 1) }
}

/** merge two small labelled graphs (AI flows / state machines) by id, then by label */
export function mergeLabelled(b: Side<{ nodes: { id: string; label: string; kind?: string }[]; edges: { from: string; to: string; label?: string }[] }>, a: typeof b, kindOf: (k?: string) => NodeKind, edgeKind: GEdge['kind']): DiffGraph {
  const nodes = new Map<string, GNode>()
  const mapB = new Map<string, string>(); const mapA = new Map<string, string>()
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  for (const n of a?.nodes ?? []) { const id = `n:${n.id}`; mapA.set(n.id, id); nodes.set(id, { id, label: n.label, kind: kindOf(n.kind), status: b ? 'added' : 'added' }) }
  for (const n of b?.nodes ?? []) {
    const byId = a?.nodes.find((x) => x.id === n.id) ?? a?.nodes.find((x) => norm(x.label) === norm(n.label))
    if (byId) { const id = mapA.get(byId.id)!; mapB.set(n.id, id); const g = nodes.get(id)!; g.status = norm(byId.label) === norm(n.label) ? 'unchanged' : 'modified'; if (g.status === 'modified') g.note = n.label }
    else { const id = `nb:${n.id}`; mapB.set(n.id, id); nodes.set(id, { id, label: n.label, kind: kindOf(n.kind), status: 'removed' }) }
  }
  const edges = new Map<string, GEdge>()
  for (const e of b?.edges ?? []) { const s = mapB.get(e.from) ?? `n:${e.from}`; const t = mapB.get(e.to) ?? `n:${e.to}`; const k = `${s}>${t}`; if (!edges.has(k)) edges.set(k, { id: `e${edges.size}`, source: s, target: t, kind: edgeKind, status: 'removed', ...(e.label ? { label: e.label } : {}) }) }
  for (const e of a?.edges ?? []) { const s = mapA.get(e.from) ?? `n:${e.from}`; const t = mapA.get(e.to) ?? `n:${e.to}`; const k = `${s}>${t}`; const x = edges.get(k); if (x) { x.status = (x.label ?? '') === (e.label ?? '') ? 'unchanged' : 'modified'; if (e.label) x.label = e.label } else edges.set(k, { id: `e${edges.size}`, source: s, target: t, kind: edgeKind, status: 'added', ...(e.label ? { label: e.label } : {}) }) }
  const ids = new Set(nodes.keys())
  return { nodes: [...nodes.values()], edges: [...edges.values()].filter((e) => ids.has(e.source) && ids.has(e.target)) }
}

export function convertAI(j: VizAIJson, r: VizResult, model: string): VizAIResult {
  const out: VizAIResult = { key: r.key, model, headline: j.headline, risk: j.risk, sequences: [], states: [], flows: [] }
  if (j.architecture) {
    const nodes: GNode[] = []; const edges: GEdge[] = []
    for (const l of j.architecture.layers) {
      const kids = l.components.map((c) => c.status)
      nodes.push({ id: `L:${l.id}`, label: l.name, kind: 'layer', group: true, status: kids.every((k) => k === 'added') ? 'added' : kids.every((k) => k === 'removed') ? 'removed' : kids.some((k) => k !== 'unchanged') ? 'modified' : 'unchanged' })
      for (const c of l.components) nodes.push({ id: `a:${c.id}`, label: c.name, kind: 'component', parent: `L:${l.id}`, status: c.status, sub: c.note ?? (c.modules?.length ? `${c.modules.length} 个文件` : ''), count: c.modules?.length, note: c.modules?.slice(0, 12).join('\n') })
    }
    j.architecture.links.forEach((k, i) => edges.push({ id: `al${i}`, source: `a:${k.from}`, target: `a:${k.to}`, kind: 'depends', status: k.status, ...(k.label ? { label: k.label } : {}) }))
    out.arch = { nodes, edges }
  }
  for (const s of j.sequences ?? []) {
    const d = mergeSeq(`ai:${s.id}`, s.title, seqRaw(s.before), seqRaw(s.after), 'ai', s.fn)
    if (d.items.length) out.sequences.push(d)
  }
  for (const s of j.states ?? []) {
    const conv = (m: Side<z.infer<typeof Machine>>) => m ? { nodes: [...m.states.map((x) => ({ id: x.id, label: x.name || x.id, kind: 'state' })), ...(m.transitions.some((t) => t.from === '*') ? [{ id: '*', label: '任意状态', kind: 'state' }] : []), ...(m.initial ? [{ id: '__init', label: '●', kind: 'initial' }] : [])], edges: [...m.transitions.map((t) => ({ from: t.from, to: t.to, label: t.event })), ...(m.initial ? [{ from: '__init', to: m.initial }] : [])] } : null
    const g = mergeLabelled(conv(s.before), conv(s.after), (k) => (k === 'initial' ? 'initial' : k === 'final' ? 'final' : 'state'), 'transition')
    for (const n of g.nodes) if (n.kind === 'initial') n.label = ''
    const FINAL_RE = /^(end|done|final|complete[d]?|success|idle|stop(ped)?|终[止结]?|结束|完成)$/i
    const outs = new Set(g.edges.map((e) => e.source))
    const ins = new Set(g.edges.map((e) => e.target))
    for (const n of g.nodes) {
      if (n.kind !== 'state') continue
      if (FINAL_RE.test(n.label || '') || (!outs.has(n.id) && ins.has(n.id) && g.nodes.filter((x) => x.kind === 'state' || x.kind === 'final').length >= 2)) {
        n.kind = 'final'; n.sub = n.sub || '终态'
      }
    }
    const changed = g.nodes.some((n) => n.status !== 'unchanged') || g.edges.some((e) => e.status !== 'unchanged')
    out.states.push({ id: `ai:${s.id}`, name: s.name, status: !s.before ? 'added' : !s.after ? 'removed' : changed ? 'modified' : 'unchanged', graph: g, source: 'ai', origin: 'AI 推断' })
  }
  for (const f of j.flows ?? []) {
    const g = mergeLabelled(f.before, f.after, (k) => (k === 'start' ? 'start' : k === 'end' ? 'end' : k === 'decision' ? 'decision' : k === 'io' ? 'io' : 'step'), 'flow')
    const changed = g.nodes.filter((n) => n.status !== 'unchanged').length
    out.flows.push({ id: `ai:${f.id}`, label: f.title, file: '', status: !f.before ? 'added' : !f.after ? 'removed' : changed ? 'modified' : 'unchanged', graph: g, changeSize: changed, source: 'ai' } as FlowEntry)
  }
  return out
}

export const hunkFiles = (r: VizResult) => r.files.filter((f) => f.lang).slice(0, 30).map((f) => posix.normalize(f.path))
export type { SeqDiagram, StateMachine }
