// Static sequence diagrams: walk a function's flow tree in source order, follow resolved calls (depth-limited),
// turn branches/loops/try into alt/loop/try frames. Then merge before/after with an LCS so unchanged messages line up.
import { posix } from 'path'
import type { CallFact, FlowStep } from './facts'
import type { DiffStatus, SeqDiagram, SeqItem, SeqParticipant } from '../../shared/viz'
import type { FnRef, SideModel } from './model'
import { isNoiseCall } from './model'

export interface RawSeq { participants: Map<string, { label: string; kind: SeqParticipant['kind'] }>; items: SeqItem[] }

const MAX_MSGS = 70
const MAX_PARTS = 9

export const participantOf = (r: FnRef): { id: string; label: string } => {
  if (r.f.owner) return { id: `p:${r.f.owner}`, label: r.f.owner }
  const base = posix.basename(r.file).replace(/\.[^.]+$/, '')
  return { id: `p:${base}`, label: base }
}

export function buildSeq(model: SideModel, rootId: string, maxDepth = 2, side: 'before' | 'after' = 'after'): RawSeq | null {
  const root = model.fns.get(rootId)
  if (!root) return null
  const parts = new Map<string, { label: string; kind: SeqParticipant['kind'] }>()
  let msgs = 0
  const part = (id: string, label: string, kind: SeqParticipant['kind']): string => {
    if (!parts.has(id)) {
      if (parts.size >= MAX_PARTS) { if (!parts.has('p:…')) parts.set('p:…', { label: '其他', kind: 'module' }); return 'p:…' }
      parts.set(id, { label, kind })
    }
    return id
  }
  part('p:caller', '调用方', 'actor')
  const rp = participantOf(root)
  const rootPart = part(rp.id, rp.label, 'class')
  const items: SeqItem[] = [{ t: 'msg', from: 'p:caller', to: rootPart, label: `${root.f.name}()`, status: 'unchanged', depth: 0, site: { file: root.file, line: root.f.line, side } }]

  const callMsgs = (from: FnRef, me: string, calls: CallFact[] | undefined, depth: number, stack: string[]): SeqItem[] => {
    const out: SeqItem[] = []
    for (const c of calls ?? []) {
      if (msgs >= MAX_MSGS) break
      const res = model.resolveCall(from, c)
      if (res.fn) {
        const t = model.fns.get(res.fn)!
        const tp = participantOf(t)
        const to = part(tp.id, tp.label, t.f.owner ? 'class' : 'module')
        msgs++
        out.push({ t: 'msg', from: me, to, label: `${c.name}()`, status: 'unchanged', depth: depth + 1, site: { file: from.file, line: c.line, side } })
        if (depth + 1 < maxDepth && !stack.includes(t.id)) out.push(...walk(t, to, t.f.flow, depth + 1, [...stack, t.id]))
      } else if (res.ext && !isNoiseCall(c.name)) {
        const to = part(`x:${res.ext}`, res.ext, 'external')
        msgs++
        out.push({ t: 'msg', from: me, to, label: `${c.name}()`, status: 'unchanged', depth: depth + 1, site: { file: from.file, line: c.line, side } })
      }
    }
    return out
  }
  const walk = (fn: FnRef, me: string, steps: FlowStep[], depth: number, stack: string[]): SeqItem[] => {
    const out: SeqItem[] = []
    for (const s of steps) {
      if (msgs >= MAX_MSGS) break
      switch (s.t) {
        case 'stmt': case 'return': case 'throw': out.push(...callMsgs(fn, me, s.calls, depth, stack)); break
        case 'loop': {
          const head = callMsgs(fn, me, s.calls, depth, stack)
          out.push(...head)
          const body = walk(fn, me, s.body, depth, stack)
          if (body.length) out.push({ t: 'frame', kind: 'loop', label: s.label, status: 'unchanged', branches: [{ label: s.label, items: body }] })
          break
        }
        case 'if': {
          const branches = s.branches.map((b) => ({ label: b.label, items: walk(fn, me, b.body, depth, stack) }))
          if (branches.some((b) => b.items.length)) out.push({ t: 'frame', kind: branches.length === 1 ? 'opt' : 'alt', label: branches[0].label, status: 'unchanged', branches: branches.filter((b, i) => b.items.length || i === 0) })
          break
        }
        case 'switch': {
          const branches = s.cases.map((c) => ({ label: c.label, items: walk(fn, me, c.body, depth, stack) })).filter((b) => b.items.length)
          if (branches.length) out.push({ t: 'frame', kind: 'alt', label: s.label, status: 'unchanged', branches })
          break
        }
        case 'try': {
          const branches = [{ label: 'try', items: walk(fn, me, s.body, depth, stack) }, ...s.catches.map((c) => ({ label: c.label || 'catch', items: walk(fn, me, c.body, depth, stack) }))]
          const fin = s.fin ? walk(fn, me, s.fin, depth, stack) : []
          if (fin.length) branches.push({ label: 'finally', items: fin })
          if (branches.some((b) => b.items.length)) out.push({ t: 'frame', kind: 'try', label: 'try', status: 'unchanged', branches: branches.filter((b) => b.items.length || b.label === 'try') })
          break
        }
      }
    }
    return out
  }
  items.push(...walk(root, rootPart, root.f.flow, 0, [root.id]))
  return { participants: parts, items }
}

// ------------------------------------------------------------------------------------------- merge
const sigOf = (i: SeqItem): string => (i.t === 'msg' ? `m|${i.from}|${i.to}|${i.label}` : `f|${i.kind}|${i.label}`)

function mark(items: SeqItem[], st: DiffStatus): SeqItem[] {
  return items.map((i) => (i.t === 'msg' ? { ...i, status: st } : { ...i, status: st, branches: i.branches.map((b) => ({ label: b.label, items: mark(b.items, st) })) }))
}

export function mergeItems(b: SeqItem[], a: SeqItem[]): SeqItem[] {
  const sb = b.map(sigOf); const sa = a.map(sigOf)
  const n = sb.length; const m = sa.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = sb[i] === sa[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: SeqItem[] = []
  let i = 0; let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && sb[i] === sa[j]) {
      const x = b[i]; const y = a[j]
      if (x.t === 'frame' && y.t === 'frame') {
        const labels = [...new Set([...x.branches.map((q) => q.label), ...y.branches.map((q) => q.label)])]
        const branches = labels.map((l) => {
          const bb = x.branches.find((q) => q.label === l); const ab = y.branches.find((q) => q.label === l)
          return { label: l, items: bb && ab ? mergeItems(bb.items, ab.items) : bb ? mark(bb.items, 'removed') : mark(ab!.items, 'added') }
        })
        const changed = branches.some((q) => q.items.some((it) => it.status !== 'unchanged')) || x.branches.length !== y.branches.length
        out.push({ ...y, status: changed ? 'modified' : 'unchanged', branches })
      } else out.push({ ...y, status: 'unchanged' })
      i++; j++
    } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { out.push(...mark([b[i]], 'removed')); i++ }   // diff convention: − before ＋
    else { out.push(...mark([a[j]], 'added')); j++ }
  }
  return out
}

export function mergeSeq(id: string, title: string, b: RawSeq | null, a: RawSeq | null, source: 'static' | 'ai', fn?: string): SeqDiagram {
  const items = mergeItems(b?.items ?? [], a?.items ?? [])
  const ids = [...new Set([...(b?.participants.keys() ?? []), ...(a?.participants.keys() ?? [])])]
  const used = new Set<string>()
  const scan = (xs: SeqItem[]) => { for (const x of xs) { if (x.t === 'msg') { used.add(x.from); used.add(x.to) } else x.branches.forEach((q) => scan(q.items)) } }
  scan(items)
  const participants: SeqParticipant[] = ids.filter((p) => used.has(p)).map((p) => {
    const inB = b?.participants.get(p); const inA = a?.participants.get(p)
    return { id: p, label: (inA ?? inB)!.label, kind: (inA ?? inB)!.kind, status: inB && inA ? 'unchanged' : inA ? 'added' : 'removed' }
  })
  const changed = items.some((x) => x.status !== 'unchanged') || participants.some((p) => p.status !== 'unchanged')
  return { id, title, status: !b ? 'added' : !a ? 'removed' : changed ? 'modified' : 'unchanged', participants, items, source, ...(fn ? { fn } : {}) }
}
