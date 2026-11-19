// AI 路径导览 (0.5.1) — Codemaps-style: the user asks a question ("登录怎么走的？"), the model answers with a
// grouped, numbered code path. Grounding: the model may ONLY pick steps from candidate locations we computed
// statically (changed functions / files + their direct unchanged callers / callees), referenced by id (C1, C2…).
// So every step links to a real file:line on the right side; the model only writes titles, notes and group guides.
import { z } from 'zod'
import { posix } from 'path'
import type { DiffStatus, Loc, Tour, TourStep, VizResult } from '../../shared/viz'
import type { SideModel } from './model'
import { repairJson } from './ai'

export interface Candidate { id: string; title: string; kind: TourStep['kind']; status: DiffStatus; file: string; before?: Loc; after?: Loc; calls: string[]; note?: string }

/** static candidates: every step of the static tour + direct unchanged neighbours (callers / callees) of changed functions */
export function tourCandidates(r: VizResult, B: SideModel, A: SideModel, max = 90): Candidate[] {
  const out: Candidate[] = []
  const byKey = new Map<string, Candidate>()
  const add = (key: string, c: Omit<Candidate, 'id' | 'calls'>) => {
    if (byKey.has(key) || out.length >= max) return byKey.get(key)
    const cand: Candidate = { ...c, id: `C${out.length + 1}`, calls: [] }
    out.push(cand); byKey.set(key, cand)
    return cand
  }
  const fnKey = new Map<string, string>()   // model fn id → candidate key
  for (const g of r.tour?.groups ?? []) for (const s of g.steps) {
    add(s.id, { title: s.title, kind: s.kind, status: s.status, file: s.file, before: s.before, after: s.after, note: s.why })
    if (s.kind === 'function') fnKey.set(s.id.slice(2), s.id)
  }
  // neighbours: unchanged functions directly calling / called by a changed function (after side, then before)
  const changedFns = [...fnKey.keys()]
  const callers = new Map<string, string[]>()
  for (const M of [A, B]) for (const [s, ts] of M.calls) for (const t of ts.keys()) (callers.get(t) ?? callers.set(t, []).get(t)!).push(s)
  for (const id of changedFns) {
    for (const M of [A, B]) {
      for (const t of [...(M.calls.get(id)?.keys() ?? []), ...(callers.get(id) ?? [])]) {
        if (fnKey.has(t)) continue
        const r2 = A.fns.get(t) ?? B.fns.get(t)
        if (!r2) continue
        const inA = A.fns.has(t)
        const label = `${r2.f.owner ? r2.f.owner + '.' : ''}${r2.f.name}()`
        const k = `t:${t}`
        if (add(k, { title: label, kind: 'function', status: 'unchanged', file: r2.file, ...(inA ? { after: { file: r2.file, line: r2.f.line, endLine: r2.f.endLine } } : { before: { file: r2.file, line: r2.f.line, endLine: r2.f.endLine } }), note: '未改动（在改动的调用链上）' })) fnKey.set(t, k)
      }
    }
  }
  // call edges between candidates
  for (const [fid, key] of fnKey) {
    const c = byKey.get(key); if (!c) continue
    const ts = new Set([...(A.calls.get(fid)?.keys() ?? []), ...(B.calls.get(fid)?.keys() ?? [])])
    c.calls = [...ts].map((t) => byKey.get(fnKey.get(t) ?? '')?.id).filter((x): x is string => !!x && x !== c.id)
  }
  return out
}

const TourJson = z.object({
  title: z.string().min(1).max(40),
  summary: z.string().max(240).optional(),
  groups: z.array(z.object({
    title: z.string().min(1).max(30),
    guide: z.string().max(240).optional(),
    steps: z.array(z.object({ ref: z.string().min(1), title: z.string().min(1).max(40), note: z.string().max(200).optional() })).min(1).max(12)
  })).min(1).max(6)
})
export type TourJsonT = z.infer<typeof TourJson>

export function validateTour(text: string, ids: Set<string>): { ok: true; data: TourJsonT; repaired: boolean } | { ok: false; errors: string[] } {
  let parsed: { value: unknown; repaired: boolean }
  try { parsed = repairJson(text) } catch (e) { return { ok: false, errors: [`不是合法 JSON：${(e as Error).message}`] } }
  const r = TourJson.safeParse(parsed.value)
  if (!r.success) return { ok: false, errors: r.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`) }
  const errors: string[] = []
  let total = 0
  r.data.groups.forEach((g, i) => g.steps.forEach((s, j) => { total++; if (!ids.has(s.ref)) errors.push(`groups.${i}.steps.${j}.ref: "${s.ref}" 不在候选位置列表里（只能用 C1…C${ids.size}）`) }))
  if (total > 40) errors.push(`步骤太多（${total}），最多 40 步`)
  return errors.length ? { ok: false, errors: errors.slice(0, 12) } : { ok: true, data: r.data, repaired: parsed.repaired }
}

export function buildTourPrompt(r: VizResult, cands: Candidate[], question: string, hunks: string): { system: string; user: string } {
  const system = [
    '你是资深工程师，正在给同事画一张「代码路径图」（类似 Windsurf Codemaps）：回答用户的问题，按执行 / 阅读顺序列出关键代码位置，分组并编号。',
    '只输出一个 JSON 对象，不要 Markdown、不要解释文字。所有文字用简体中文。',
    'JSON 结构：{"title":"≤20字标题","summary":"一两句话回答问题，并点出这次改动前后路径的差别","groups":[{"title":"≤12字的分组名","guide":"这一组为什么放在一起、读的时候注意什么（≤80字）","steps":[{"ref":"C3","title":"≤16字，这一步做什么","note":"≤60字，改动前后有什么不同 / 要注意什么"}]}]}',
    '规则：1) ref 只能是候选位置列表里的 id（C1、C2…），绝不能编造文件或行号；2) 按真实调用顺序排列（调用方在前），可以引用未改动但在路径上的位置；',
    '3) 2-5 组，每组 2-8 步，总共不超过 30 步；4) 删除的代码只存在于改动前、新增的只存在于改动后，note 里说清楚路径怎么变了；5) 不要重复引用同一个 ref。'
  ].join('\n')
  const lines = cands.map((c) => {
    const loc = c.after ?? c.before
    return `${c.id} [${c.status}] ${c.kind === 'file' ? '文件' : c.kind === 'class' ? '类' : '函数'} ${c.title} @ ${loc ? `${loc.file}:${loc.line}` : c.file}${c.calls.length ? ` → 调用 ${c.calls.join(',')}` : ''}${c.note ? `  // ${c.note}` : ''}`
  })
  const user = [
    `问题：${question || '这次改动的主要执行路径是什么？改动前后有什么不同？'}`,
    `变更范围：${r.beforeLabel} → ${r.afterLabel}${r.filter ? `（路径：${r.filter}）` : ''}`,
    `候选位置（只能从这里选 ref）：\n${lines.join('\n')}`,
    `diff 片段：\n${hunks}`
  ].join('\n\n')
  return { system, user: user.slice(0, 40000) }
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
export function convertTour(j: TourJsonT, cands: Candidate[], question: string, model: string): Tour {
  const byId = new Map(cands.map((c) => [c.id, c]))
  const used = new Set<string>()
  const stepOf = new Map<string, TourStep>()
  const groups = j.groups.map((g, gi) => {
    const steps: TourStep[] = []
    for (const s of g.steps) {
      const c = byId.get(s.ref)!
      if (used.has(c.id)) continue
      used.add(c.id)
      const st: TourStep = { n: `${gi + 1}${LETTERS[steps.length] ?? steps.length}`, id: `ai:${c.id}`, title: s.title, status: c.status, kind: c.kind, file: c.file,
        ...(c.before ? { before: c.before } : {}), ...(c.after ? { after: c.after } : {}), why: [s.note, `${c.title} · ${posix.basename(c.file)}`].filter(Boolean).join(' — ') }
      steps.push(st); stepOf.set(c.id, st)
    }
    return { id: `ag:${gi}`, title: g.title, ...(g.guide ? { guide: g.guide } : {}), steps }
  }).filter((g) => g.steps.length)
  // edges: reading order inside a group + real calls between chosen candidates
  for (const g of groups) g.steps.forEach((s, i) => { if (g.steps[i + 1]) s.next = [g.steps[i + 1].id] })
  for (const [cid, st] of stepOf) for (const t of byId.get(cid)!.calls) { const to = stepOf.get(t); if (to && !st.next?.includes(to.id)) st.next = [...(st.next ?? []), to.id] }
  for (let i = 0; i + 1 < groups.length; i++) { const last = groups[i].steps[groups[i].steps.length - 1]; const first = groups[i + 1].steps[0]; if (!last.next?.includes(first.id)) last.next = [...(last.next ?? []), first.id] }
  return { id: `tour:ai`, source: 'ai', title: j.title, ...(j.summary ? { summary: j.summary } : {}), question, model, groups }
}
