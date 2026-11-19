// 0.5.2「AI 解读本图」: a grounded prompt built from the diagram itself, and a parser that turns 「节点名」 in the answer
// back into clickable references to the boxes on screen (the explanation is tied to the picture, not free text).
import type { DiffGraph, GNode } from '../../../shared/viz'
import type { AIChatMessage } from '../../../shared/types'
import { STATUS_LABEL } from './vizGraph'

const KIND: Record<string, string> = { file: '文件', function: '函数', method: '方法', class: '类', interface: '接口', type: '类型', enum: '枚举', state: '状态', step: '步骤', decision: '判断', component: '组件', route: '路由', event: '事件', layer: '层', cluster: '分组' }
const loc = (n: GNode) => { const l = n.after ?? n.before; return l ? `${l.file}:${l.line}` : '' }
const name = (n: GNode) => n.label.split('\n')[0].trim()

/** label → node id, only for names that are unique in the picture (ambiguous names stay plain text) */
export function nameIndex(g: DiffGraph): Map<string, string> {
  const seen = new Map<string, string | null>()
  for (const n of g.nodes) { if (n.group) continue; const k = name(n); seen.set(k, seen.has(k) ? null : n.id) }
  return new Map([...seen].filter((e): e is [string, string] => e[1] !== null))
}

export function explainPrompt(g: DiffGraph, view: string, scope: string, max = 60): AIChatMessage[] {
  const by = new Map(g.nodes.map((n) => [n.id, n]))
  const ch = g.nodes.filter((n) => !n.group && n.status !== 'unchanged')
  const ctx = g.nodes.filter((n) => !n.group && n.status === 'unchanged')
  const ce = g.edges.filter((e) => e.status !== 'unchanged')
  const nm = (id: string) => { const n = by.get(id); return n ? name(n) : id.replace(/^[a-z]+:/, '') }
  const lines = [
    `图：${view}（${scope}）`,
    `改动的节点（${ch.length}${ch.length > max ? `，只列前 ${max} 个` : ''}）：`,
    ...ch.slice(0, max).map((n) => `- [${STATUS_LABEL[n.status]}] ${KIND[n.kind] ?? n.kind} 「${name(n)}」${loc(n) ? `（${loc(n)}）` : ''}${n.note ? ` — ${n.note.split('\n')[0].slice(0, 60)}` : ''}`),
    `变化的连线（${ce.length}${ce.length > max ? `，只列前 ${max} 条` : ''}）：`,
    ...ce.slice(0, max).map((e) => `- [${STATUS_LABEL[e.status]}] 「${nm(e.source)}」 → 「${nm(e.target)}」（${e.kind}）`),
    `没改动的相关节点：${ctx.slice(0, 30).map((n) => `「${name(n)}」`).join('、') || '无'}${ctx.length > 30 ? ` 等 ${ctx.length} 个` : ''}`
  ]
  return [
    { role: 'system', content: '你是代码评审助手，帮用户读懂一张"改动前 / 改动后"对比图。只根据给出的图内容回答，不要编造图里没有的文件、函数或行号。用简体中文、大白话。' },
    { role: 'user', content: `${lines.join('\n')}\n\n请写 3～6 条要点解读这张图：这次改动做了什么、结构上有什么变化（多了 / 少了哪些依赖或调用）、可能影响哪里。每条一句话，以"- "开头。提到图中的节点时必须用「」括起名字，且只能用上面列表里出现过的名字。最后单独一行写：建议先看：「某个节点」。` }
  ]
}

export type ExplainPart = { text: string } | { ref: string; id: string }
/** split an answer into plain text and 「name」 references that resolve to nodes of the picture */
export function linkNames(text: string, idx: Map<string, string>): ExplainPart[] {
  const out: ExplainPart[] = []
  let last = 0
  for (const m of text.matchAll(/「([^」\n]{1,80})」/g)) {
    const id = idx.get(m[1].trim())
    if (!id) continue
    if (m.index! > last) out.push({ text: text.slice(last, m.index) })
    out.push({ ref: m[1].trim(), id })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
