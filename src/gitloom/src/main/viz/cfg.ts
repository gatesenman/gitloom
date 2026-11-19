// Control-flow graph of one function (from the FlowStep tree) and the structural diff of two CFGs.
import type { FlowStep } from './facts'
import type { DiffGraph, DiffStatus, GEdge, GNode, NodeKind } from '../../shared/viz'
import { normWs } from './facts'

export interface CfgNode { id: string; kind: NodeKind; label: string; line?: number; path: string }
export interface CfgEdge { source: string; target: string; label?: string; back?: boolean }
export interface Cfg { nodes: CfgNode[]; edges: CfgEdge[] }

interface Pend { from: string; label?: string }
const MAX_LINES = 3

export function buildCfg(flow: FlowStep[], fnLabel: string): Cfg {
  const nodes: CfgNode[] = []
  const edges: CfgEdge[] = []
  let n = 0
  const node = (kind: NodeKind, label: string, path: string, line?: number): string => { const id = `c${n++}`; nodes.push({ id, kind, label, line, path }); return id }
  const link = (preds: Pend[], to: string) => { for (const p of preds) edges.push({ source: p.from, target: to, ...(p.label ? { label: p.label } : {}) }) }
  const start = node('start', fnLabel, 's')
  const end = node('end', '结束', 'e')
  const breaks: Pend[][] = []
  const loops: string[] = []

  const seq = (steps: FlowStep[], preds: Pend[], path: string): Pend[] => {
    let cur = preds
    let buf: { text: string; line: number }[] = []
    let bi = 0
    const flush = () => {
      if (!buf.length) return
      const shown = buf.slice(0, MAX_LINES).map((b) => b.text)
      const label = shown.join('\n') + (buf.length > MAX_LINES ? `\n… 共 ${buf.length} 句` : '')
      const id = node('step', label, `${path}.b${bi++}`, buf[0].line)
      link(cur, id); cur = [{ from: id }]; buf = []
    }
    steps.forEach((s, i) => {
      const p = `${path}.${i}`
      if (s.t === 'stmt') { buf.push({ text: s.text, line: s.line }); return }
      flush()
      if (cur.length === 0 && s.t !== 'jump') { /* unreachable code after return: still draw it, detached */ }
      switch (s.t) {
        case 'if': {
          let pending = cur
          const exits: Pend[] = []
          s.branches.forEach((b, k) => {
            if (b.label === 'else' && k > 0) { exits.push(...seq(b.body, pending, `${p}.else`)); pending = []; return }
            const d = node('decision', b.label + '?', `${p}.if${k}`, s.line)
            link(pending, d)
            exits.push(...seq(b.body, [{ from: d, label: '是' }], `${p}.if${k}.t`))
            pending = [{ from: d, label: '否' }]
          })
          exits.push(...pending)
          cur = exits
          break
        }
        case 'loop': {
          const l = node('loop', s.label, `${p}.loop`, s.line)
          link(cur, l)
          breaks.push([]); loops.push(l)
          const out = seq(s.body, [{ from: l, label: '每次' }], `${p}.loop.b`)
          for (const o of out) edges.push({ source: o.from, target: l, back: true, ...(o.label ? { label: o.label } : {}) })
          loops.pop()
          cur = [{ from: l, label: '结束循环' }, ...breaks.pop()!]
          break
        }
        case 'switch': {
          const d = node('decision', `${s.label || 'switch'} ?`, `${p}.sw`, s.line)
          link(cur, d)
          breaks.push([])
          const exits: Pend[] = []
          let hasDefault = false
          s.cases.forEach((c, k) => { if (c.label === 'default') hasDefault = true; exits.push(...seq(c.body, [{ from: d, label: c.label }], `${p}.sw.${k}`)) })
          if (!hasDefault) exits.push({ from: d, label: '其他' })
          cur = [...exits, ...breaks.pop()!]
          break
        }
        case 'try': {
          const t = node('try', 'try', `${p}.try`, s.line)
          link(cur, t)
          const exits = seq(s.body, [{ from: t }], `${p}.try.b`)
          s.catches.forEach((c, k) => exits.push(...seq(c.body, [{ from: t, label: c.label || '异常' }], `${p}.try.c${k}`)))
          cur = s.fin ? seq(s.fin, exits, `${p}.try.f`) : exits
          break
        }
        case 'return': { const r = node('return', s.text, `${p}.ret`, s.line); link(cur, r); edges.push({ source: r, target: end }); cur = []; break }
        case 'throw': { const r = node('throw', s.text, `${p}.throw`, s.line); link(cur, r); edges.push({ source: r, target: end, label: '异常' }); cur = []; break }
        case 'jump': {
          if (/^break/.test(s.text) && breaks.length) { breaks[breaks.length - 1].push(...cur); cur = [] }
          else if (/^continue/.test(s.text) && loops.length) { for (const c of cur) edges.push({ source: c.from, target: loops[loops.length - 1], back: true, ...(c.label ? { label: c.label } : {}) }); cur = [] }
          break
        }
      }
    })
    flush()
    return cur
  }
  const exits = seq(flow, [{ from: start }], 'r')
  link(exits, end)
  // drop edges to the end node from nothing reachable; keep graph small
  return { nodes, edges }
}

const keyOf = (n: CfgNode) => `${n.kind}|${normWs(n.label)}`

/** Merge two CFGs into one DiffGraph. Nodes match by (kind,label) first, then by structural position. */
export function diffCfg(before: Cfg | null, after: Cfg | null): DiffGraph {
  const b = before ?? { nodes: [], edges: [] }
  const a = after ?? { nodes: [], edges: [] }
  const out: GNode[] = []
  const mapB = new Map<string, string>(); const mapA = new Map<string, string>()
  let k = 0
  const occ = (list: CfgNode[]) => { const seen = new Map<string, number>(); return list.map((n) => { const key = keyOf(n); const i = seen.get(key) ?? 0; seen.set(key, i + 1); return `${key}#${i}` }) }
  const kb = occ(b.nodes); const ka = occ(a.nodes)
  const aByKey = new Map(ka.map((key, i) => [key, i]))
  const usedA = new Set<number>()
  const pendingB: number[] = []
  b.nodes.forEach((n, i) => {
    const j = aByKey.get(kb[i])
    if (j !== undefined && !usedA.has(j)) {
      usedA.add(j)
      const id = `f${k++}`; mapB.set(n.id, id); mapA.set(a.nodes[j].id, id)
      out.push({ id, label: a.nodes[j].label, kind: a.nodes[j].kind, status: 'unchanged', before: n.line ? { file: '', line: n.line } : undefined, after: a.nodes[j].line ? { file: '', line: a.nodes[j].line! } : undefined })
    } else pendingB.push(i)
  })
  // structural position match → modified
  const aByPath = new Map<string, number>()
  a.nodes.forEach((n, j) => { if (!usedA.has(j)) aByPath.set(`${n.kind}|${n.path}`, j) })
  for (const i of pendingB) {
    const n = b.nodes[i]
    const j = aByPath.get(`${n.kind}|${n.path}`)
    if (j !== undefined && !usedA.has(j)) {
      usedA.add(j)
      const id = `f${k++}`; mapB.set(n.id, id); mapA.set(a.nodes[j].id, id)
      out.push({ id, label: a.nodes[j].label, kind: n.kind, status: 'modified', note: n.label, before: n.line ? { file: '', line: n.line } : undefined, after: a.nodes[j].line ? { file: '', line: a.nodes[j].line! } : undefined })
    } else { const id = `f${k++}`; mapB.set(n.id, id); out.push({ id, label: n.label, kind: n.kind, status: before && after ? 'removed' : 'removed', before: n.line ? { file: '', line: n.line } : undefined }) }
  }
  a.nodes.forEach((n, j) => { if (usedA.has(j)) return; const id = `f${k++}`; mapA.set(n.id, id); out.push({ id, label: n.label, kind: n.kind, status: 'added', after: n.line ? { file: '', line: n.line } : undefined }) })
  const edges = new Map<string, GEdge>()
  const addE = (e: CfgEdge, map: Map<string, string>, side: 'b' | 'a') => {
    const s = map.get(e.source); const t = map.get(e.target)
    if (!s || !t) return
    const key = `${s}>${t}|${e.label ?? ''}`
    const prev = edges.get(key)
    if (prev) { if (prev.status === 'removed' && side === 'a') prev.status = 'unchanged'; return }
    edges.set(key, { id: `e${edges.size}`, source: s, target: t, kind: 'flow', status: side === 'b' ? 'removed' : 'added', ...(e.label ? { label: e.label } : {}), ...(e.back ? { weight: -1 } : {}) })
  }
  b.edges.forEach((e) => addE(e, mapB, 'b'))
  a.edges.forEach((e) => addE(e, mapA, 'a'))
  if (!before) for (const e of edges.values()) e.status = 'added'
  return { nodes: out, edges: [...edges.values()] }
}

export const cfgChanged = (g: DiffGraph): boolean => g.nodes.some((n) => n.status !== 'unchanged') || g.edges.some((e) => e.status !== 'unchanged')
export const statusOfGraph = (g: DiffGraph, existed: { before: boolean; after: boolean }): DiffStatus => !existed.before ? 'added' : !existed.after ? 'removed' : cfgChanged(g) ? 'modified' : 'unchanged'
