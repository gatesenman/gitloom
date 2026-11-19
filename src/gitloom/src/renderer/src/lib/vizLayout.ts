// Deterministic layouts for 变更可视化. The merged (before ∪ after) graph is laid out ONCE so the before / after
// pictures line up exactly. ELK layered for graphs (sorted input + fixed seed → identical output for identical
// input, whatever the order nodes arrive in); a custom banded layout for the architecture layers.
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode, ElkExtendedEdge, LayoutOptions } from 'elkjs/lib/elk-api'
import type { DiffGraph, GNode, GEdge } from '../../../shared/viz'

export interface Box { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }
/** an ELK-routed edge in absolute (root) coordinates: orthogonal polyline + optional label centre */
export interface Route { pts: Pt[]; label?: Pt }
export interface Layout { boxes: Record<string, Box>; width: number; height: number; dir: 'RIGHT' | 'DOWN'; routes?: Record<string, Route> }
export interface LayoutOpts { /** width / height of the pane the picture will be shown in (component packing target) */ aspect?: number }
export type LayoutKind = 'modules' | 'calls' | 'classes' | 'flow' | 'state' | 'impact' | 'arch'

// ---- text metrics without DOM (CJK ≈ 1em, latin ≈ .56em) so sizes are identical in tests and in the app
export function textWidth(s: string, px = 13): number {
  let w = 0
  for (const ch of s) { const c = ch.codePointAt(0)!; w += c > 0x2e80 ? px : c === 32 ? px * 0.3 : /[A-Z]/.test(ch) ? px * 0.66 : /[il.,:;'|!]/.test(ch) ? px * 0.32 : px * 0.56 }
  return Math.ceil(w)
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
export const MAX_MEMBERS = 10

export function nodeSize(n: GNode): { w: number; h: number } {
  const lines = n.label.split('\n')
  const tw = Math.max(...lines.map((l) => textWidth(l, 12.5)))
  const kind = n.kind === 'file' && n.members?.length ? 'class' : n.kind   // tour file step listing its changed functions
  switch (kind) {
    case 'initial': return { w: 22, h: 22 }
    case 'final': return { w: clamp(tw + 56, 56, 200), h: n.label ? 44 : 28 }
    case 'start': case 'end': return { w: clamp(tw + 44, 88, 240), h: 34 }
    case 'decision': return { w: clamp(tw + 64, 120, 260), h: 62 }
    case 'state': return { w: clamp(tw + 44, 96, 220), h: 40 }
    case 'step': case 'return': case 'throw': case 'loop': case 'try': case 'io':
      return { w: clamp(tw + 32, 120, 320), h: 18 * Math.min(lines.length, 4) + 18 }
    case 'class': case 'interface': case 'type': case 'enum': case 'struct': case 'trait': case 'object': case 'record': {
      // UML compartments: name | attributes | operations — size matches VizNodes.ClassNode
      const ms = n.members ?? []
      const attrs = ms.filter((m) => m.kind === 'field' || m.kind === 'value')
      const methods = ms.filter((m) => m.kind === 'method')
      const attrN = Math.min(attrs.length, MAX_MEMBERS)
      const methN = Math.min(methods.length, Math.max(0, MAX_MEMBERS - attrN))
      const shown = attrN + methN
      const mw = Math.max(0, ...ms.slice(0, MAX_MEMBERS).map((m) => textWidth(m.name + (m.kind === 'method' ? '()' : ''), 11.5) + 36))
      const head = 44 + (n.kind !== 'class' ? 14 : 0)
      const body = shown ? (2 * 4 /* compartment pads */ + Math.max(attrN, 1) * 18 + Math.max(methN, 1) * 18) : 0
      const more = ms.length > shown ? 18 : 0
      return { w: clamp(Math.max(tw + 56, mw), 160, 300), h: head + body + more }
    }
    case 'component': return { w: clamp(Math.max(tw + 48, textWidth(n.sub ?? '', 11) + 40), 150, 230), h: 58 }
    case 'cluster': return { w: clamp(Math.max(tw + 56, textWidth(n.sub ?? '', 11) + 40), 140, 260), h: 54 }
    // + room for stereotype badge / status / hub flame
    default: {
      const stereo = 14 // «角色» line
      return { w: clamp(Math.max(Math.ceil(tw * 1.1) + 46 + (n.status !== 'unchanged' ? 24 : 0) + (n.hub ? 17 : 0), textWidth(n.sub ?? '', 11) + 36), 110, 280), h: (n.sub ? 48 : 36) + stereo }
    }
  }
}

/** proper crossings between orthogonal segments of different routes (layout quality score) */
export function crossings(routes: Record<string, Route>): number {
  const H: [number, number, number, string][] = []; const V: [number, number, number, string][] = []
  for (const [id, r] of Object.entries(routes)) for (let i = 1; i < r.pts.length; i++) {
    const a = r.pts[i - 1], b = r.pts[i]
    if (Math.abs(a.y - b.y) < 0.6) H.push([a.y, Math.min(a.x, b.x), Math.max(a.x, b.x), id])
    else if (Math.abs(a.x - b.x) < 0.6) V.push([a.x, Math.min(a.y, b.y), Math.max(a.y, b.y), id])
  }
  let n = 0
  for (const h of H) for (const v of V) if (h[3] !== v[3] && v[0] > h[1] + 1 && v[0] < h[2] - 1 && h[0] > v[1] + 1 && h[0] < v[2] - 1) n++
  return n
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
type ElkLike = { layout: (g: ElkNode) => Promise<ElkNode> }
let elk: ElkLike | null = null
let factory: () => ElkLike = () => new ELK()
/** the app swaps in a Web Worker backed ELK (keeps the UI responsive on big graphs); tests use the bundled one */
export function setElkFactory(f: () => ElkLike): void { factory = f; elk = null }

const OPTS: Record<Exclude<LayoutKind, 'arch'>, LayoutOptions> = {
  modules: { 'elk.direction': 'RIGHT', 'elk.layered.spacing.nodeNodeBetweenLayers': '46', 'elk.spacing.nodeNode': '16' },
  calls: { 'elk.direction': 'RIGHT', 'elk.layered.spacing.nodeNodeBetweenLayers': '46', 'elk.spacing.nodeNode': '14' },
  classes: { 'elk.direction': 'DOWN', 'elk.layered.spacing.nodeNodeBetweenLayers': '48', 'elk.spacing.nodeNode': '28' },
  flow: { 'elk.direction': 'DOWN', 'elk.layered.spacing.nodeNodeBetweenLayers': '30', 'elk.spacing.nodeNode': '26', 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED' },
  state: { 'elk.direction': 'RIGHT', 'elk.layered.spacing.nodeNodeBetweenLayers': '70', 'elk.spacing.nodeNode': '34', 'elk.spacing.edgeLabel': '6' },
  impact: { 'elk.direction': 'RIGHT', 'elk.layered.spacing.nodeNodeBetweenLayers': '56', 'elk.spacing.nodeNode': '14', 'elk.partitioning.activate': 'true' }
}

/** aspect a side-by-side pane comfortably shows; wider/taller layouts get the other direction tried */
const ADAPT: Partial<Record<LayoutKind, true>> = { modules: true, calls: true, impact: true, state: true }
const skewTo = (l: Layout, target: number) => { const r = (l.width || 1) / (l.height || 1); return Math.max(r / target, target / r) }

export async function layoutGraph(g: DiffGraph, kind: LayoutKind, o: LayoutOpts = {}): Promise<Layout> {
  if (kind === 'arch') return layoutBands(g)
  const target = clamp(o.aspect ?? 1.4, 0.6, 3.2)
  const first = await layoutDir(g, kind, OPTS[kind]['elk.direction'] as 'RIGHT' | 'DOWN', target)
  // deterministic orientation pick: a 20-node call graph laid RIGHT came out 6:1 and rendered at 33 % zoom
  if (!ADAPT[kind] || skewTo(first, target) < 2.2) return first
  const alt = await layoutDir(g, kind, first.dir === 'RIGHT' ? 'DOWN' : 'RIGHT', target)
  return skewTo(alt, target) < skewTo(first, target) * 0.8 ? alt : first
}

/** tighter spacing for orthogonal routing (0.5.2): edges get their own channels, so nodes can sit closer */
const SPACING: LayoutOptions = { 'elk.spacing.edgeNode': '12', 'elk.spacing.edgeEdge': '7', 'elk.layered.spacing.edgeNodeBetweenLayers': '14', 'elk.layered.spacing.edgeEdgeBetweenLayers': '7' }

interface Part { boxes: Record<string, Box>; routes: Record<string, Route>; width: number; height: number; key: string }

async function layoutDir(g: DiffGraph, kind: Exclude<LayoutKind, 'arch'>, dir: 'RIGHT' | 'DOWN', aspect: number): Promise<Layout> {
  elk ??= factory()
  const nodes = [...g.nodes].sort((a, b) => cmp(a.id, b.id))
  const ids = new Set(nodes.map((n) => n.id))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const kids = new Map<string, GNode[]>()
  const roots: GNode[] = []
  for (const n of nodes) { if (n.parent && ids.has(n.parent)) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n); else roots.push(n) }
  const top = (id: string) => { let n = byId.get(id); while (n?.parent && ids.has(n.parent)) n = byId.get(n.parent); return n?.id ?? id }
  const live = [...g.edges].filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
    .sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.id, b.id))
  // connected components over top-level units: ELK puts disconnected parts in one long row / column
  // (60 unrelated classes came out 11164×146 px); each part is laid out alone and the parts are packed into rows
  const uf = new Map<string, string>()
  const find = (x: string): string => { let r = x; while (uf.get(r) !== r) r = uf.get(r)!; let c = x; while (uf.get(c) !== r) { const nx = uf.get(c)!; uf.set(c, r); c = nx } return r }
  for (const r of roots) uf.set(r.id, r.id)
  for (const e of live) { const a = find(top(e.source)), b = find(top(e.target)); if (a !== b) uf.set(a < b ? b : a, a < b ? a : b) }
  const comps = new Map<string, GNode[]>()
  for (const r of roots) { const k = find(r.id); (comps.get(k) ?? comps.set(k, []).get(k)!).push(r) }
  const edgesOf = new Map<string, GEdge[]>()
  for (const e of live) { const k = find(top(e.source)); (edgesOf.get(k) ?? edgesOf.set(k, []).get(k)!).push(e) }

  const toElk = (n: GNode): ElkNode => {
    const ch = kids.get(n.id)
    if (n.group || ch?.length) {
      return { id: n.id, layoutOptions: { 'elk.padding': '[top=32,left=10,bottom=10,right=10]', 'elk.direction': dir }, children: (ch ?? []).map(toElk) }
    }
    const s = nodeSize(n)
    return { id: n.id, width: s.w, height: s.h, ...(kind === 'impact' ? { layoutOptions: { 'elk.partitioning.partition': String(n.dist ?? 0) } } : {}) }
  }
  const big = nodes.length > 120
  const baseOpts = (): LayoutOptions => ({
    'elk.algorithm': 'layered', 'elk.randomSeed': '1', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP', 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.edgeRouting': 'ORTHOGONAL', 'elk.padding': '[top=0,left=0,bottom=0,right=0]', 'elk.layered.mergeEdges': 'false',
    'org.eclipse.elk.json.edgeCoords': 'ROOT',
    // big graphs: fewer crossing-minimisation sweeps (220-node impact graph went 3.7 s → well under 1 s)
    ...(big ? { 'elk.layered.thoroughness': '1', 'elk.layered.compaction.postCompaction.strategy': 'NONE' } : {}),
    ...SPACING, ...OPTS[kind], 'elk.direction': dir
  })
  const elkEdge = (e: { id: string; source: string; target: string; label?: string }) => ({ id: e.id, sources: [e.source], targets: [e.target], ...(e.label && (kind === 'state' || kind === 'flow') ? { labels: [{ text: e.label, width: textWidth(e.label, 11) + 8, height: 16 }] } : {}) })
  type Sec = { startPoint: Pt; endPoint: Pt; bendPoints?: Pt[] }
  type RE = ElkExtendedEdge & { sections?: Sec[]; labels?: { x?: number; y?: number; width?: number; height?: number }[] }
  const run = async (children: ElkNode[], edges: ElkExtendedEdge[], extra: LayoutOptions = {}) => {
    const res = await elk!.layout({ id: '__root', layoutOptions: { ...baseOpts(), ...extra }, children, edges })
    const boxes: Record<string, Box> = {}
    const walk = (n: ElkNode) => { for (const c of n.children ?? []) { boxes[c.id] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0), w: Math.round(c.width ?? 0), h: Math.round(c.height ?? 0) }; walk(c) } }
    walk(res)
    const routes: Record<string, Route> = {}
    for (const e of (res.edges ?? []) as RE[]) {
      const sec = e.sections?.[0]
      if (!sec) continue
      const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }))
      const l = e.labels?.[0]
      routes[e.id] = { pts, ...(l && l.x !== undefined ? { label: { x: Math.round((l.x ?? 0) + (l.width ?? 0) / 2), y: Math.round((l.y ?? 0) + (l.height ?? 0) / 2) } } : {}) }
    }
    return { boxes, routes, width: Math.round(res.width ?? 0), height: Math.round(res.height ?? 0) }
  }
  const PAD_T = 32, PAD_S = 10
  const isGroup = (n: GNode) => !!(n.group || kids.get(n.id)?.length)
  /**
   * compound layout with bundled edges (0.5.2). ELK's INCLUDE_CHILDREN on folder groups spread every group over many
   * layers (GitLoom's own 0.5.1 diff: 3780×2158 px, 426 crossings). Instead:
   *  A) each group's inside is laid out on its own, with an "entry" and an "exit" dummy that every externally
   *     connected child is wired to — ELK routes these fan-in / fan-out lines around the other children;
   *  B) the groups (now fixed-size boxes) and loose nodes are laid out as one flat graph, one trunk per group pair;
   *  C) every node-level edge = fan-out → along the group border → shared trunk → border → fan-in (edge bundling).
   */
  const layOne = async (key: string, members: GNode[], es: GEdge[]): Promise<Part> => {
    if (members.length === 1 && !es.length && !kids.get(members[0].id)?.length && !members[0].group) {
      const s = nodeSize(members[0]); return { key, boxes: { [members[0].id]: { x: 0, y: 0, w: s.w, h: s.h } }, routes: {}, width: s.w, height: s.h }
    }
    if (!members.some(isGroup)) {
      const r = await run(members.map(toElk), es.map(elkEdge))
      return { key, ...r }
    }
    const b = await bundled(key, members, es)
    // small pictures: ELK's own hierarchical layout is often more direct (fewer bends, no fans) — keep whichever
    // reads better at the pane's aspect (bigger fit zoom, fewer crossings, every edge routed)
    const leafN = members.reduce((s, m) => s + leavesUnder(m), 0)
    if (leafN > 40) return b
    const inc = await run(members.map(toElk), es.map(elkEdge))
    if (Object.keys(inc.routes).length < es.length) return b
    const score = (q: { width: number; height: number; routes: Record<string, Route> }) => Math.min(400 * aspect / Math.max(1, q.width), 400 / Math.max(1, q.height)) / (1 + 0.05 * crossings(q.routes))
    const dbg = (globalThis as { __vizLayoutDebug?: (m: string) => void }).__vizLayoutDebug
    dbg?.(`compound ${key}: include ${inc.width}x${inc.height} ×${crossings(inc.routes)} s=${score(inc).toFixed(3)} | bundled ${b.width}x${b.height} ×${crossings(b.routes)} s=${score(b).toFixed(3)}`)
    return score(inc) >= score(b) ? { key, ...inc } : b
  }
  const leavesUnder = (n: GNode): number => { const ch = kids.get(n.id); return ch?.length ? ch.reduce((s, c) => s + leavesUnder(c), 0) : n.group ? 0 : 1 }
  const bundled = async (key: string, members: GNode[], es: GEdge[]): Promise<Part> => {
    const down = dir === 'DOWN'
    // ---- A) inside every group
    const inner = new Map<string, { w: number; h: number; boxes: Record<string, Box>; routes: Record<string, Route>; inPt?: Pt; outPt?: Pt }>()
    const cross = es.filter((e) => top(e.source) !== top(e.target))
    await Promise.all(members.filter(isGroup).map(async (u) => {
      const own = es.filter((e) => top(e.source) === u.id && top(e.target) === u.id)
      const outs = [...new Set(cross.filter((e) => top(e.source) === u.id).map((e) => e.source))]
      const ins = [...new Set(cross.filter((e) => top(e.target) === u.id).map((e) => e.target))]
      const dummies: ElkNode[] = []
      const dEdges: ElkExtendedEdge[] = []
      if (outs.length) { dummies.push({ id: `__out:${u.id}`, width: 2, height: 2, layoutOptions: { 'elk.layered.layering.layerConstraint': 'LAST_SEPARATE' } }); outs.forEach((s, i) => dEdges.push({ id: `__o${i}:${u.id}`, sources: [s], targets: [`__out:${u.id}`] })) }
      if (ins.length) { dummies.push({ id: `__in:${u.id}`, width: 2, height: 2, layoutOptions: { 'elk.layered.layering.layerConstraint': 'FIRST_SEPARATE' } }); ins.forEach((t, i) => dEdges.push({ id: `__i${i}:${u.id}`, sources: [`__in:${u.id}`], targets: [t] })) }
      const r = await run([...(kids.get(u.id) ?? []).map(toElk), ...dummies], [...own.map(elkEdge), ...dEdges])
      const shift = (q: Pt) => ({ x: q.x + PAD_S, y: q.y + PAD_T })
      const boxes: Record<string, Box> = {}
      for (const [id, b] of Object.entries(r.boxes)) if (!id.startsWith('__')) boxes[id] = (byId.get(id)?.parent === u.id) ? { ...b, x: b.x + PAD_S, y: b.y + PAD_T } : b
      const routes: Record<string, Route> = {}
      for (const [id, rt] of Object.entries(r.routes)) routes[id] = { pts: rt.pts.map(shift), ...(rt.label ? { label: shift(rt.label) } : {}) }
      // the dummies' own columns are dropped: the group is as big as its real children (+ room for the fans)
      const real = Object.entries(r.boxes).filter(([id]) => !id.startsWith('__') && byId.get(id)?.parent === u.id).map(([, b]) => b)
      const minX = Math.min(...real.map((b) => b.x)), minY = Math.min(...real.map((b) => b.y))
      const maxX = Math.max(...real.map((b) => b.x + b.w)), maxY = Math.max(...real.map((b) => b.y + b.h))
      const fan = 14
      const ox = down ? 0 : (ins.length ? -minX + fan : -minX), oy = down ? (ins.length ? -minY + fan : -minY) : 0
      const offX = down ? -minX : ox, offY = down ? oy : -minY
      for (const [id, b] of Object.entries(boxes)) if (byId.get(id)?.parent === u.id) boxes[id] = { ...b, x: b.x + offX, y: b.y + offY }
      for (const rt of Object.values(routes)) { rt.pts = rt.pts.map((q) => ({ x: q.x + offX, y: q.y + offY })); if (rt.label) rt.label = { x: rt.label.x + offX, y: rt.label.y + offY } }
      const w = (maxX - minX) + PAD_S * 2 + (down ? 0 : (ins.length ? fan : 0) + (outs.length ? fan : 0))
      const h = (maxY - minY) + PAD_T + PAD_S + (down ? (ins.length ? fan : 0) + (outs.length ? fan : 0) : 0)
      // fan routes end at the dummies; clip them to the group border
      for (const [id, rt] of Object.entries(routes)) {
        if (id.startsWith('__o')) {
          rt.pts = rt.pts.map((q) => (down ? { x: q.x, y: Math.min(q.y, h - 5) } : { x: Math.min(q.x, w - 5), y: q.y }))
          const last = rt.pts[rt.pts.length - 1]; rt.pts[rt.pts.length - 1] = down ? { x: last.x, y: h } : { x: w, y: last.y }
        }
        if (id.startsWith('__i')) {
          rt.pts = rt.pts.map((q) => (down ? { x: q.x, y: Math.max(q.y, PAD_T - 2) } : { x: Math.max(q.x, 5), y: q.y }))
          const first = rt.pts[0]; rt.pts[0] = down ? { x: first.x, y: PAD_T - 8 } : { x: 0, y: first.y }
        }
      }
      inner.set(u.id, { w: Math.max(w, Math.ceil(textWidth(u.label, 11.5) * 1.12) + 96), h, boxes, routes })
    }))
    // ---- B) groups as fixed boxes + loose nodes, one trunk per (unit → unit)
    const trunkOf = (e: GEdge) => `__t:${top(e.source)}>${top(e.target)}`
    const trunks = new Map<string, { id: string; source: string; target: string; n: number }>()
    for (const e of cross) { const k = trunkOf(e); const t = trunks.get(k); if (t) t.n++; else trunks.set(k, { id: k, source: top(e.source), target: top(e.target), n: 1 }) }
    const units: ElkNode[] = members.map((u) => { const i = inner.get(u.id); return i ? { id: u.id, width: i.w, height: i.h } : toElk(u) })
    const r = await run(units, [...trunks.values()].map(elkEdge))
    const boxes: Record<string, Box> = {}
    const routes: Record<string, Route> = {}
    for (const u of members) {
      const b = r.boxes[u.id]; if (!b) continue
      const i = inner.get(u.id)
      boxes[u.id] = i ? { ...b, w: i.w, h: i.h } : b
      if (i) {
        Object.assign(boxes, i.boxes)
        for (const [id, rt] of Object.entries(i.routes)) if (!id.startsWith('__')) routes[id] = { pts: rt.pts.map((q) => ({ x: q.x + b.x, y: q.y + b.y })), ...(rt.label ? { label: { x: rt.label.x + b.x, y: rt.label.y + b.y } } : {}) }
      }
    }
    // ---- C) node-level edges through the trunks
    const fanOf = (gid: string, node: string, out: boolean): Pt[] | null => {
      const i = inner.get(gid); const b = boxes[gid]; if (!i || !b) return null
      const pre = out ? '__o' : '__i'
      for (const [id, rt] of Object.entries(i.routes)) {
        if (!id.startsWith(pre) || !id.endsWith(`:${gid}`)) continue
        const kidEnd = out ? rt.pts[0] : rt.pts[rt.pts.length - 1]
        const kb = i.boxes[node]; if (!kb) continue
        if (kidEnd.x >= kb.x - 2 && kidEnd.x <= kb.x + kb.w + 2 && kidEnd.y >= kb.y - 2 && kidEnd.y <= kb.y + kb.h + 2) return rt.pts.map((q) => ({ x: q.x + b.x, y: q.y + b.y }))
      }
      return null
    }
    const join = (a: Pt[], b: Pt[]): Pt[] => {
      if (!a.length) return b
      if (!b.length) return a
      const p = a[a.length - 1], q = b[0]
      if (Math.abs(p.x - q.x) < 0.6 || Math.abs(p.y - q.y) < 0.6) return [...a, ...b]
      // elbow along the group border
      const mid = down ? { x: q.x, y: p.y } : { x: p.x, y: q.y }
      return [...a, mid, ...b]
    }
    for (const e of cross) {
      const t = r.routes[trunkOf(e)]; if (!t) continue
      const su = top(e.source), tu = top(e.target)
      const fo = su !== e.source ? fanOf(su, e.source, true) : []
      const fi = tu !== e.target ? fanOf(tu, e.target, false) : []
      if (fo === null || fi === null) continue
      const pts = join(join(fo, t.pts), fi)
      const dedup = pts.filter((q, k) => k === 0 || Math.abs(q.x - pts[k - 1].x) > 0.1 || Math.abs(q.y - pts[k - 1].y) > 0.1)
      routes[e.id] = { pts: dedup }
    }
    return { key, boxes, routes, width: r.width, height: r.height }
  }
  const order = [...comps.keys()].sort(cmp)
  const parts = await Promise.all(order.map((k) => layOne(k, comps.get(k)!, edgesOf.get(k) ?? [])))
  // shelf packing: biggest parts first, rows as wide as the pane's aspect asks for
  const PAD = 20, GAP = 28
  parts.sort((a, b) => b.height * b.width - a.height * a.width || cmp(a.key, b.key))
  const area = parts.reduce((s, p) => s + (p.width + GAP) * (p.height + GAP), 0)
  const rowMax = Math.max(Math.max(...parts.map((p) => p.width)), Math.round(Math.sqrt(area * aspect)))
  const boxes: Record<string, Box> = {}
  const routes: Record<string, Route> = {}
  let x = PAD, y = PAD, rowH = 0, width = 0
  for (const p of parts) {
    if (x > PAD && x + p.width > rowMax + PAD) { x = PAD; y += rowH + GAP; rowH = 0 }
    const tops = new Set(Object.keys(p.boxes).filter((id) => { const n = byId.get(id); return !n?.parent || !ids.has(n.parent) }))
    for (const [id, b] of Object.entries(p.boxes)) boxes[id] = tops.has(id) ? { ...b, x: b.x + x, y: b.y + y } : b
    for (const [id, r] of Object.entries(p.routes)) routes[id] = { pts: r.pts.map((q) => ({ x: q.x + x, y: q.y + y })), ...(r.label ? { label: { x: r.label.x + x, y: r.label.y + y } } : {}) }
    x += p.width + GAP; rowH = Math.max(rowH, p.height); width = Math.max(width, x - GAP + PAD)
  }
  return { boxes, routes, width, height: y + rowH + PAD, dir }
}

/** architecture: one horizontal band per layer (UI on top → infrastructure at the bottom), components wrap in rows */
export const LAYER_ORDER = ['表现层', '接口层', '业务层', '数据层', '基础层', '测试', '其他']
export function layoutBands(g: DiffGraph, maxWidth = 1180): Layout {
  const layers = g.nodes.filter((n) => n.group && !n.parent)
  const rank = (n: GNode) => { const i = LAYER_ORDER.findIndex((l) => n.label.startsWith(l)); return i < 0 ? LAYER_ORDER.length : i }
  layers.sort((a, b) => rank(a) - rank(b) || cmp(a.label, b.label) || cmp(a.id, b.id))
  const boxes: Record<string, Box> = {}
  const LABEL_W = 92; const GAP = 22; const PAD = 14
  let y = 0
  let width = 0
  const placedLeaves = new Set<string>()
  for (const L of layers) {
    const comps = g.nodes.filter((n) => n.parent === L.id).sort((a, b) => cmp(a.label, b.label) || cmp(a.id, b.id))
    let x = LABEL_W; let rowH = 0; let yy = PAD
    for (const c of comps) {
      const s = nodeSize(c)
      if (x + s.w > maxWidth && x > LABEL_W) { x = LABEL_W; yy += rowH + GAP; rowH = 0 }
      boxes[c.id] = { x, y: yy, w: s.w, h: s.h }
      placedLeaves.add(c.id)
      x += s.w + GAP; rowH = Math.max(rowH, s.h)
      width = Math.max(width, x)
    }
    const h = Math.max(70, yy + rowH + PAD)
    boxes[L.id] = { x: 0, y, w: 0, h }
    y += h + 16
  }
  width = Math.max(width + PAD - GAP, 520)
  for (const L of layers) boxes[L.id].w = width
  // components without a layer (AI may return them) go into a trailing row
  let x = LABEL_W
  for (const n of g.nodes) if (!n.group && !placedLeaves.has(n.id) && !boxes[n.id]) { const s = nodeSize(n); boxes[n.id] = { x, y, w: s.w, h: s.h }; x += s.w + GAP }
  return { boxes, width, height: y + (x > LABEL_W ? 80 : 0), dir: 'DOWN' }
}
