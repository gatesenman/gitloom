// Two SideModels → every diagram as one merged DiffGraph (+ sequences, state machines, per-function flows, summary).
import { posix } from 'path'
import type { ChangedFile, DiffGraph, DiffStatus, FlowEntry, GEdge, GNode, Member, SeqDiagram, StateMachine, SummaryCount, VizSummary } from '../../shared/viz'
import type { SideModel, FnRef, DeclRef } from './model'
import { buildCfg, diffCfg } from './cfg'
import { buildSeq, mergeSeq } from './seq'
import { machinesOf, ANY, type RawMachine } from './states'

export interface DiffInput {
  before: SideModel
  after: SideModel
  changed: ChangedFile[]
  /** canonical (after) path → original before path, for renamed files */
  beforeOrig: Map<string, string>
  hops?: number
}

export interface Views {
  modules: DiffGraph; calls: DiffGraph; classes: DiffGraph; arch: DiffGraph; impact: DiffGraph
  flows: FlowEntry[]; sequences: SeqDiagram[]; states: StateMachine[]; summary: VizSummary
}

const base = (p: string) => posix.basename(p)
const cnt = (): SummaryCount => ({ added: 0, removed: 0, modified: 0, moved: 0 })
const bump = (c: SummaryCount, s: DiffStatus) => { if (s === 'added') c.added++; else if (s === 'removed') c.removed++; else if (s === 'modified') c.modified++; else if (s === 'moved') c.moved = (c.moved ?? 0) + 1 }
export const isChanged = (s: DiffStatus) => s !== 'unchanged'
const groupStatus = (kids: DiffStatus[]): DiffStatus => !kids.length ? 'unchanged' : kids.every((k) => k === 'added') ? 'added' : kids.every((k) => k === 'removed') ? 'removed' : kids.some((k) => k !== 'unchanged') ? 'modified' : 'unchanged'

function edgeMerge(bEdges: [string, string, number?][], aEdges: [string, string, number?][], kind: GEdge['kind'], prefix: string, files?: { b: (s: string) => string | undefined; a: (s: string) => string | undefined }): GEdge[] {
  const m = new Map<string, GEdge>()
  for (const [s, t, l] of bEdges) { const k = `${s}>${t}`; if (!m.has(k)) m.set(k, { id: `${prefix}${m.size}`, source: s, target: t, kind, status: 'removed', ...(l && files?.b(s) ? { site: { file: files.b(s)!, line: l, side: 'before' as const } } : {}) }) }
  for (const [s, t, l] of aEdges) {
    const k = `${s}>${t}`
    const e = m.get(k)
    if (e) { e.status = 'unchanged'; if (l && files?.a(s)) e.site = { file: files.a(s)!, line: l, side: 'after' } }
    else m.set(k, { id: `${prefix}${m.size}`, source: s, target: t, kind, status: 'added', ...(l && files?.a(s) ? { site: { file: files.a(s)!, line: l, side: 'after' as const } } : {}) })
  }
  return [...m.values()]
}

/** keep `seeds` + everything within `hops` (undirected) — BFS order, capped */
export function cropGraph(g: DiffGraph, seeds: Set<string>, hops: number, cap: number): DiffGraph {
  const adj = new Map<string, string[]>()
  for (const e of g.edges) { (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target); (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source) }
  const keep = new Map<string, number>()
  let frontier = [...seeds].sort()
  frontier.forEach((s) => keep.set(s, 0))
  for (let d = 1; d <= hops && keep.size < cap; d++) {
    const next: string[] = []
    for (const s of frontier) for (const t of (adj.get(s) ?? []).sort()) if (!keep.has(t) && keep.size < cap) { keep.set(t, d); next.push(t) }
    frontier = next
  }
  const leafIds = new Set(keep.keys())
  const parents = new Set(g.nodes.filter((n) => leafIds.has(n.id) && n.parent).map((n) => n.parent!))
  const nodes = g.nodes.filter((n) => leafIds.has(n.id) || parents.has(n.id))
  const total = g.nodes.filter((n) => !n.group).length
  return { nodes, edges: g.edges.filter((e) => leafIds.has(e.source) && leafIds.has(e.target)), truncated: Math.max(0, total - leafIds.size) || undefined }
}

// ---------------------------------------------------------------------------------------------- modules
function moduleDiff(inp: DiffInput) {
  const { before: B, after: A, beforeOrig } = inp
  const all = [...new Set([...B.files.keys(), ...A.files.keys()])].sort()
  const status = new Map<string, DiffStatus>()
  const nodes: GNode[] = []
  for (const p of all) {
    const b = B.files.get(p); const a = A.files.get(p)
    const moved = !!b && !!a && (beforeOrig.get(p) ?? p) !== p
    const st: DiffStatus = !b ? 'added' : !a ? 'removed' : moved ? 'moved' : b.hash !== a.hash ? 'modified' : 'unchanged'
    status.set(p, st)
    const dir = posix.dirname(p)
    nodes.push({ id: `m:${p}`, label: base(p), kind: 'file', status: st, parent: `d:${dir}`, lang: (a ?? b)!.lang,
      sub: dir === '.' ? '' : dir, ...(b ? { before: { file: beforeOrig.get(p) ?? p, line: 1 } } : {}), ...(a ? { after: { file: p, line: 1 } } : {}),
      weight: 0 })
  }
  const dirs = new Map<string, DiffStatus[]>()
  for (const p of all) { const d = posix.dirname(p); (dirs.get(d) ?? dirs.set(d, []).get(d)!).push(status.get(p)!) }
  for (const [d, kids] of [...dirs].sort()) nodes.push({ id: `d:${d}`, label: d === '.' ? '(根目录)' : d, kind: 'folder', group: true, status: groupStatus(kids), count: kids.length })
  const ed = (M: SideModel) => [...M.imports].flatMap(([s, ts]) => [...ts].map(([t, l]) => [`m:${s}`, `m:${t}`, l] as [string, string, number]))
  const edges = edgeMerge(ed(B), ed(A), 'import', 'i', { b: (s) => beforeOrig.get(s.slice(2)) ?? s.slice(2), a: (s) => s.slice(2) })
  const fanIn = new Map<string, number>()
  for (const e of edges) if (e.status !== 'removed') fanIn.set(e.target, (fanIn.get(e.target) ?? 0) + 1)
  for (const n of nodes) if (!n.group) n.weight = fanIn.get(n.id) ?? 0
  let g: DiffGraph = { nodes, edges }
  if (all.length > 2500) g = cropGraph(g, new Set(nodes.filter((n) => !n.group && isChanged(n.status)).map((n) => n.id)), 2, 2500)
  return { graph: g, status, full: { nodes, edges } }
}

// ---------------------------------------------------------------------------------------------- functions
interface FnPair { id: string; b?: FnRef; a?: FnRef; status: DiffStatus }
function fnPairs(inp: DiffInput, modStatus: Map<string, DiffStatus>): FnPair[] {
  const { before: B, after: A } = inp
  const ids = [...new Set([...B.fns.keys(), ...A.fns.keys()])].sort()
  const pairs: FnPair[] = []
  const removed: FnPair[] = []; const added: FnPair[] = []
  for (const id of ids) {
    const b = B.fns.get(id); const a = A.fns.get(id)
    const p: FnPair = { id, b, a, status: !b ? 'added' : !a ? 'removed' : b.f.sig !== a.f.sig ? 'modified' : modStatus.get(a.file) === 'moved' ? 'moved' : 'unchanged' }
    pairs.push(p)
    if (p.status === 'removed') removed.push(p); else if (p.status === 'added') added.push(p)
  }
  // moved between files: same qualified name, unique on both sides
  const q = (r: FnRef) => `${r.f.owner ?? ''}.${r.f.name}`
  const addByQ = new Map<string, FnPair[]>()
  for (const p of added) (addByQ.get(q(p.a!)) ?? addByQ.set(q(p.a!), []).get(q(p.a!))!).push(p)
  const remByQ = new Map<string, FnPair[]>()
  for (const p of removed) (remByQ.get(q(p.b!)) ?? remByQ.set(q(p.b!), []).get(q(p.b!))!).push(p)
  for (const [k, rs] of remByQ) {
    const as = addByQ.get(k)
    if (rs.length !== 1 || as?.length !== 1 || /^\.(constructor|__init__|main|render|default|index|init|run|handler)$/.test(k)) continue
    const r = rs[0]; const a = as[0]
    a.b = r.b; a.status = r.b!.f.sig === a.a!.f.sig ? 'moved' : 'modified'
    pairs.splice(pairs.indexOf(r), 1)
  }
  return pairs
}

function callDiff(inp: DiffInput, pairs: FnPair[], modStatus: Map<string, DiffStatus>, hops: number) {
  const { before: B, after: A, beforeOrig } = inp
  const bMap = new Map<string, string>()
  for (const p of pairs) if (p.b) bMap.set(p.b.id, p.id)
  const nodes: GNode[] = pairs.map((p) => {
    const r = (p.a ?? p.b)!
    return { id: `f:${p.id}`, label: `${r.f.owner ? r.f.owner + '.' : ''}${r.f.name}`, kind: r.f.owner ? 'method' : 'function', status: p.status, parent: `g:${r.file}`,
      sub: `${base(r.file)}:${r.f.line}`, ...(p.b ? { before: { file: beforeOrig.get(p.b.file) ?? p.b.file, line: p.b.f.line, endLine: p.b.f.endLine } } : {}),
      ...(p.a ? { after: { file: p.a.file, line: p.a.f.line, endLine: p.a.f.endLine } } : {}), note: p.a?.f.params ?? p.b?.f.params }
  })
  const ed = (M: SideModel, map?: Map<string, string>) => [...M.calls].flatMap(([s, ts]) => [...ts].map(([t, l]) => [`f:${map?.get(s) ?? s}`, `f:${map?.get(t) ?? t}`, l] as [string, string, number]))
  const fileOf = new Map(nodes.map((n) => [n.id, n]))
  const edges = edgeMerge(ed(B, bMap), ed(A), 'call', 'c', { b: (s) => fileOf.get(s)?.before?.file, a: (s) => fileOf.get(s)?.after?.file })
  const full: DiffGraph = { nodes, edges }
  const seeds = new Set(nodes.filter((n) => isChanged(n.status)).map((n) => n.id))
  for (const e of edges) if (isChanged(e.status)) { seeds.add(e.source); seeds.add(e.target) }
  const cropped = cropGraph(full, seeds, hops, 320)
  const files = [...new Set(cropped.nodes.map((n) => n.parent!).filter(Boolean))].sort()
  cropped.nodes.push(...files.map((g) => { const f = g.slice(2); return { id: g, label: base(f), sub: posix.dirname(f), kind: 'file' as const, group: true, status: modStatus.get(f) ?? 'unchanged' } }))
  return { graph: cropped, full }
}

// ---------------------------------------------------------------------------------------------- classes
function memberDiff(b: DeclRef | undefined, a: DeclRef | undefined): Member[] {
  const out: Member[] = []
  const bm = new Map((b?.d.members ?? []).map((m) => [`${m.kind}:${m.name}`, m]))
  const am = new Map((a?.d.members ?? []).map((m) => [`${m.kind}:${m.name}`, m]))
  for (const m of a?.d.members ?? []) {
    const o = bm.get(`${m.kind}:${m.name}`)
    out.push({ name: m.name, kind: m.kind, status: !b ? 'added' : !o ? 'added' : o.sig !== m.sig ? 'modified' : 'unchanged', sig: m.type })
  }
  for (const m of b?.d.members ?? []) if (!am.has(`${m.kind}:${m.name}`)) out.push({ name: m.name, kind: m.kind, status: 'removed', sig: m.type })
  return out
}

function classDiff(inp: DiffInput, hops: number) {
  const { before: B, after: A, beforeOrig } = inp
  const ids = [...new Set([...B.decls.keys(), ...A.decls.keys()])].sort()
  const nodes: GNode[] = []
  const bMap = new Map<string, string>()
  const added: string[] = []; const removed: string[] = []
  const pair = new Map<string, { b?: DeclRef; a?: DeclRef }>()
  for (const id of ids) { const b = B.decls.get(id); const a = A.decls.get(id); pair.set(id, { b, a }); if (!b) added.push(id); if (!a) removed.push(id) }
  for (const r of removed) {
    const b = pair.get(r)!.b!
    const cands = added.filter((x) => pair.get(x)!.a!.d.name === b.d.name && pair.get(x)!.a!.d.kind === b.d.kind)
    if (cands.length === 1 && removed.filter((x) => pair.get(x)!.b!.d.name === b.d.name).length === 1) { pair.get(cands[0])!.b = b; pair.delete(r); bMap.set(r, cands[0]) }
  }
  for (const [id, { b, a }] of pair) {
    const r = (a ?? b)!
    const members = memberDiff(b, a)
    const moved = !!a && !!b && a.file !== (bMap.has(b.id) ? '' : b.file) && bMap.has(b.id)
    const st: DiffStatus = !b ? 'added' : !a ? 'removed' : b.d.sig !== a.d.sig || members.some((m) => m.status !== 'unchanged') ? 'modified' : moved || (beforeOrig.get(a.file) ?? a.file) !== a.file ? 'moved' : 'unchanged'
    nodes.push({ id: `c:${id}`, label: r.d.name, kind: r.d.kind, status: st, members, sub: base(r.file),
      ...(b ? { before: { file: beforeOrig.get(b.file) ?? b.file, line: b.d.line, endLine: b.d.endLine } } : {}), ...(a ? { after: { file: a.file, line: a.d.line, endLine: a.d.endLine } } : {}) })
  }
  const rel = (M: SideModel, map?: Map<string, string>) => {
    const out: { s: string; t: string; k: GEdge['kind'] }[] = []
    for (const r of M.decls.values()) {
      const s = `c:${map?.get(r.id) ?? r.id}`
      const add = (name: string, k: GEdge['kind']) => { const t = M.findDecl(name.replace(/<.*/, '').split('.').pop()!, r.file); if (t && t.id !== r.id) out.push({ s, t: `c:${map?.get(t.id) ?? t.id}`, k }) }
      r.d.ext.forEach((x) => add(x, 'extends')); r.d.impl.forEach((x) => add(x, 'implements')); r.d.uses.forEach((x) => add(x, 'uses'))
    }
    return out
  }
  const m = new Map<string, GEdge>()
  for (const e of rel(B, bMap)) { const k = `${e.s}>${e.t}|${e.k}`; if (!m.has(k)) m.set(k, { id: `x${m.size}`, source: e.s, target: e.t, kind: e.k, status: 'removed' }) }
  for (const e of rel(A)) { const k = `${e.s}>${e.t}|${e.k}`; const x = m.get(k); if (x) x.status = 'unchanged'; else m.set(k, { id: `x${m.size}`, source: e.s, target: e.t, kind: e.k, status: 'added' }) }
  const full: DiffGraph = { nodes, edges: [...m.values()] }
  const seeds = new Set(nodes.filter((n) => isChanged(n.status)).map((n) => n.id))
  for (const e of full.edges) if (isChanged(e.status)) { seeds.add(e.source); seeds.add(e.target) }
  return { graph: cropGraph(full, seeds, Math.min(hops, 2), 160), full }
}

// ---------------------------------------------------------------------------------------------- architecture (static)
const LAYERS: { id: string; name: string; re: RegExp }[] = [
  { id: 'ui', name: '表现层', re: /(^|\/)(ui|views?|components?|pages?|screens?|renderer|frontend|web|widgets?|templates?|styles?|layouts?)(\/|$)/i },
  { id: 'api', name: '接口层', re: /(^|\/)(controllers?|routes?|routers?|handlers?|api|apis|endpoints?|rest|graphql|grpc|http|ipc|preload|cli|commands?|cmd|resources?)(\/|$)/i },
  { id: 'svc', name: '业务层', re: /(^|\/)(services?|usecases?|use_cases?|domain|core|logic|business|application|workflows?|engine|features?|viz|ai|ops|jobs|workers?|main|server|backend)(\/|$)/i },
  { id: 'data', name: '数据层', re: /(^|\/)(repos?|repository|repositories|dao|db|database|models?|entities|entity|store|stores|persistence|schemas?|migrations?|data|state)(\/|$)/i },
  { id: 'infra', name: '基础层', re: /(^|\/)(utils?|lib|libs|shared|common|helpers?|infra|infrastructure|config|types?|hooks|platform|git|internal|pkg|support|scripts|tools|build)(\/|$)/i },
  { id: 'test', name: '测试', re: /(^|\/)(tests?|spec|specs|__tests__|e2e|testing)(\/|$)/i }
]
export const LAYER_ORDER = [...LAYERS.map((l) => l.id), 'other']
export function componentOf(path: string, deep: Set<string>): string {
  // keep "main" when it is a real module name (electron main/), drop maven src/main/java
  const raw = path.split('/').slice(0, -1)
  const cleaned: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i]
    if (s === 'src') continue
    if ((s === 'main' || s === 'test') && raw[i + 1] && /^(java|kotlin|scala|resources)$/.test(raw[i + 1])) { if (s === 'test') cleaned.push('test'); i++; continue }
    if (/^(com|org|net|io|cn)$/.test(s) && i < raw.length - 2) { i += 1; continue } // com.company.* package roots
    cleaned.push(s)
  }
  if (!cleaned.length) return '(根目录)'
  const first = cleaned[0]
  return deep.has(first) && cleaned.length > 1 ? `${first}/${cleaned[1]}` : first
}
// file-level fallback (small repos where one folder holds everything): classify by words in the last segment
const LOOSE: [string, RegExp][] = [
  ['test', /(test|spec)/i], ['ui', /(view|page|screen|component|widget|template|ui$)/i], ['api', /(controller|handler|router?|endpoint|api|resource|cli|command)/i],
  ['svc', /(service|usecase|manager|engine|workflow|gateway|processor|facade|interactor)/i], ['data', /(repo|repository|dao|model|entity|store|schema|record|status|state|order|user|db)/i],
  ['infra', /(util|helper|config|common|shared|log|audit|event|client)/i]
]
export function layerOf(comp: string): string {
  const lastSeg = comp.split('/').pop() ?? ''
  if (lastSeg !== comp) for (const l of LAYERS) if (l.re.test(lastSeg)) return l.id   // renderer/lib → 基础层
  for (const l of LAYERS) if (l.re.test(comp)) return l.id
  const last = comp.split('/').pop() ?? ''
  for (const [id, re] of LOOSE) if (re.test(last)) return id
  return 'other'
}
export const layerName = (id: string) => LAYERS.find((l) => l.id === id)?.name ?? '其他'

function archDiff(modules: DiffGraph, modStatus: Map<string, DiffStatus>, B: SideModel, A: SideModel): DiffGraph {
  const files = [...modStatus.keys()]
  // a top folder with many files and several sub-folders is split one level deeper
  const byFirst = new Map<string, Set<string>>(); const countFirst = new Map<string, number>()
  for (const p of files) {
    const c = componentOf(p, new Set())
    const segs = p.split('/')
    countFirst.set(c, (countFirst.get(c) ?? 0) + 1)
    const sub = componentOf(p, new Set([c]))
    if (sub !== c) (byFirst.get(c) ?? byFirst.set(c, new Set()).get(c)!).add(sub)
    void segs
  }
  const deep = new Set([...byFirst].filter(([c, subs]) => (countFirst.get(c) ?? 0) > 10 && subs.size >= 2).map(([c]) => c))
  let compOf = new Map(files.map((p) => [p, componentOf(p, deep)]))
  // tiny / flat projects (everything in one package): go down to file level so the picture has structure
  if (new Set(compOf.values()).size <= 2 && files.length >= 3) {
    compOf = new Map(files.map((p) => [p, `${compOf.get(p)}/${p.split('/').pop()!.replace(/\.[^.]+$/, '')}`]))
  }
  const comps = new Map<string, { files: string[]; st: DiffStatus[] }>()
  for (const p of files) { const c = compOf.get(p)!; const x = comps.get(c) ?? comps.set(c, { files: [], st: [] }).get(c)!; x.files.push(p); x.st.push(modStatus.get(p)!) }
  const nodes: GNode[] = []
  const usedLayers = new Set<string>()
  const routesOf = (M: SideModel, fs: string[]) => fs.reduce((n, f) => n + (M.files.get(f)?.routes.length ?? 0), 0)
  for (const [c, x] of [...comps].sort()) {
    const layer = layerOf(c)
    usedLayers.add(layer)
    const add = x.st.filter((s) => s === 'added').length; const del = x.st.filter((s) => s === 'removed').length; const mod = x.st.filter((s) => s === 'modified' || s === 'moved').length
    const routes = routesOf(A, x.files) || routesOf(B, x.files)
    nodes.push({ id: `a:${c}`, label: c.split('/').length > 1 && !deep.has(c.split('/')[0]) ? c.split('/').pop()! : c, kind: 'component', parent: `L:${layer}`, status: groupStatus(x.st), count: x.files.length, weight: x.files.length,
      sub: [`${x.files.length} 文件`, add ? `+${add}` : '', del ? `−${del}` : '', mod ? `~${mod}` : '', routes ? `${routes} 接口` : ''].filter(Boolean).join(' · ') })
  }
  for (const l of LAYER_ORDER) if (usedLayers.has(l)) nodes.push({ id: `L:${l}`, label: layerName(l), kind: 'layer', group: true, status: groupStatus(nodes.filter((n) => n.parent === `L:${l}`).map((n) => n.status)) })
  const agg = new Map<string, { b: number; a: number; s: string; t: string }>()
  for (const e of modules.edges) {
    const s = compOf.get(e.source.slice(2)); const t = compOf.get(e.target.slice(2))
    if (!s || !t || s === t) continue
    const k = `${s}>${t}`
    const x = agg.get(k) ?? agg.set(k, { b: 0, a: 0, s, t }).get(k)!
    if (e.status !== 'added') x.b++
    if (e.status !== 'removed') x.a++
  }
  const edges: GEdge[] = [...agg.values()].sort((p, q) => (`${p.s}>${p.t}` < `${q.s}>${q.t}` ? -1 : 1)).map((x, i) => ({
    id: `ae${i}`, source: `a:${x.s}`, target: `a:${x.t}`, kind: 'depends', weight: Math.max(x.a, x.b),
    status: x.b === 0 ? 'added' : x.a === 0 ? 'removed' : x.a !== x.b ? 'modified' : 'unchanged', label: x.a === x.b ? String(x.a) : `${x.b}→${x.a}`
  }))
  // pub/sub & IPC: emitter component → listener component (dashed "event" edges)
  const evEdges = (M: SideModel) => {
    const emit = new Map<string, Set<string>>(); const on = new Map<string, Set<string>>()
    for (const [p, f] of M.files) for (const ev of f.events) { const c = compOf.get(p); if (!c) continue; const m = ev.dir === 'emit' ? emit : on; (m.get(ev.name) ?? m.set(ev.name, new Set()).get(ev.name)!).add(c) }
    const out = new Map<string, string[]>()
    for (const [name, es] of emit) for (const e of es) for (const l of on.get(name) ?? []) if (e !== l) { const k = `${e}>${l}`; (out.get(k) ?? out.set(k, []).get(k)!).push(name) }
    return out
  }
  const eb = evEdges(B); const ea = evEdges(A)
  let i = 0
  for (const k of [...new Set([...eb.keys(), ...ea.keys()])].sort()) {
    const [s, t] = k.split('>')
    const names = [...new Set([...(ea.get(k) ?? []), ...(eb.get(k) ?? [])])]
    edges.push({ id: `ev${i++}`, source: `a:${s}`, target: `a:${t}`, kind: 'event', status: !eb.has(k) ? 'added' : !ea.has(k) ? 'removed' : 'unchanged', label: names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ') })
  }
  return { nodes, edges }
}

// ---------------------------------------------------------------------------------------------- impact
function impactDiff(modules: DiffGraph): DiffGraph {
  const leaf = modules.nodes.filter((n) => !n.group)
  const seeds = leaf.filter((n) => isChanged(n.status)).map((n) => n.id)
  const rev = new Map<string, string[]>()
  for (const e of modules.edges) (rev.get(e.target) ?? rev.set(e.target, []).get(e.target)!).push(e.source)
  const dist = new Map<string, number>(seeds.map((s) => [s, 0]))
  let frontier = [...seeds].sort()
  for (let d = 1; d <= 4 && dist.size < 220; d++) {
    const next: string[] = []
    for (const s of frontier) for (const t of (rev.get(s) ?? []).sort()) if (!dist.has(t) && dist.size < 220) { dist.set(t, d); next.push(t) }
    frontier = next
  }
  const fanIn = new Map<string, number>()
  for (const e of modules.edges) fanIn.set(e.target, (fanIn.get(e.target) ?? 0) + 1)
  const nodes: GNode[] = leaf.filter((n) => dist.has(n.id)).map((n) => ({ ...n, parent: undefined, id: n.id.replace(/^m:/, 'p:'), dist: dist.get(n.id)!, weight: fanIn.get(n.id) ?? 0,
    sub: dist.get(n.id) === 0 ? '改动点' : `第 ${dist.get(n.id)} 层依赖方` }))
  const edges: GEdge[] = []
  for (const e of modules.edges) {
    const ds = dist.get(e.source); const dt = dist.get(e.target)
    if (ds === undefined || dt === undefined || ds < dt) continue
    edges.push({ ...e, id: `p${edges.length}`, source: e.target.replace(/^m:/, 'p:'), target: e.source.replace(/^m:/, 'p:'), kind: 'depends' })
  }
  return { nodes, edges, truncated: dist.size >= 220 ? leaf.length - nodes.length : undefined }
}

// ---------------------------------------------------------------------------------------------- flows
function flowEntries(pairs: FnPair[], beforeOrig: Map<string, string>): FlowEntry[] {
  const out: FlowEntry[] = []
  for (const p of pairs) {
    if (p.status === 'unchanged' || p.status === 'moved') continue
    const r = (p.a ?? p.b)!
    const label = `${r.f.owner ? r.f.owner + '.' : ''}${r.f.name}`
    const g = diffCfg(p.b ? buildCfg(p.b.f.flow, label) : null, p.a ? buildCfg(p.a.f.flow, label) : null)
    for (const n of g.nodes) { if (n.before) n.before.file = beforeOrig.get(p.b!.file) ?? p.b!.file; if (n.after) n.after.file = p.a!.file }
    const changed = g.nodes.filter((n) => n.status !== 'unchanged').length
    if (p.status === 'modified' && changed === 0 && !g.edges.some((e) => e.status !== 'unchanged')) {
      // body text changed but the control structure did not: still list it, flagged as "structure unchanged"
    }
    out.push({ id: p.id, label, file: r.file, owner: r.f.owner, status: p.status, graph: g, changeSize: p.status === 'modified' ? changed * 3 + Math.abs((p.a?.f.size ?? 0) - (p.b?.f.size ?? 0)) : r.f.size })
  }
  return out.sort((x, y) => y.changeSize - x.changeSize || (x.id < y.id ? -1 : 1)).slice(0, 80)
}

// ---------------------------------------------------------------------------------------------- states
function machineGraph(b?: RawMachine, a?: RawMachine): DiffGraph {
  const vals = [...new Set([...(a?.values ?? []), ...(b?.values ?? [])])]
  const nodes: GNode[] = vals.map((v) => ({ id: `s:${v}`, label: v, kind: 'state', status: !b?.values.includes(v) ? 'added' : !a?.values.includes(v) ? 'removed' : 'unchanged' }))
  const tr = (m?: RawMachine) => { const x = new Map<string, Set<string>>(); for (const t of m?.transitions ?? []) { const k = `${t.from}>${t.to}`; (x.get(k) ?? x.set(k, new Set()).get(k)!).add(t.event) } return x }
  const tb = tr(b); const ta = tr(a)
  const edges: GEdge[] = []
  const usesAny = [...tb.keys(), ...ta.keys()].some((k) => k.startsWith(`${ANY}>`))
  if (usesAny) nodes.push({ id: `s:${ANY}`, label: '任意状态', kind: 'state', status: 'unchanged', note: '在任何状态下都可能发生的迁移' })
  const init = (m?: RawMachine) => m?.initial && m.values.includes(m.initial) ? m.initial : undefined
  const ib = init(b); const ia = init(a)
  if (ib || ia) {
    nodes.push({ id: 's:__init', label: '', kind: 'initial', status: 'unchanged' })
    if (ib && ia && ib === ia) edges.push({ id: 'ti', source: 's:__init', target: `s:${ia}`, kind: 'transition', status: 'unchanged' })
    else { if (ib) edges.push({ id: 'tib', source: 's:__init', target: `s:${ib}`, kind: 'transition', status: 'removed' }); if (ia) edges.push({ id: 'tia', source: 's:__init', target: `s:${ia}`, kind: 'transition', status: 'added' }) }
  }
  let i = 0
  for (const k of [...new Set([...tb.keys(), ...ta.keys()])].sort()) {
    const [from, to] = k.split('>')
    if (!vals.includes(to) || (from !== ANY && !vals.includes(from))) continue
    const evs = [...new Set([...(ta.get(k) ?? []), ...(tb.get(k) ?? [])])]
    edges.push({ id: `t${i++}`, source: `s:${from}`, target: `s:${to}`, kind: 'transition', status: !tb.has(k) ? 'added' : !ta.has(k) ? 'removed' : [...(ta.get(k) ?? [])].sort().join() !== [...(tb.get(k) ?? [])].sort().join() ? 'modified' : 'unchanged',
      label: formatTransitionLabel(evs) })
  }
  // UML final: terminal names, or states with inbound but no outbound (excl. ANY)
  const outDeg = new Map<string, number>()
  const inDeg = new Map<string, number>()
  for (const e of edges) {
    if (e.source.startsWith('s:') && e.source !== 's:__init') outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1)
    if (e.target.startsWith('s:')) inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1)
  }
  const FINAL_RE = /^(end|done|final|complete[d]?|success|idle|stop(ped)?|终[止结]?|结束|完成)$/i
  for (const n of nodes) {
    if (n.kind !== 'state' || n.id === `s:${ANY}`) continue
    const name = n.label || ''
    const noOut = (outDeg.get(n.id) ?? 0) === 0
    const hasIn = (inDeg.get(n.id) ?? 0) > 0
    if (FINAL_RE.test(name) || (noOut && hasIn && vals.length >= 2)) {
      n.kind = 'final'
      n.sub = n.sub || '终态'
      n.note = n.note || 'UML 终止状态（无出边或约定终态名）'
    }
  }
  return { nodes, edges }
}

function formatTransitionLabel(evs: string[]): string {
  // Prefer UML event[guard]/action when the extractor already encoded it; otherwise join events.
  const xs = evs.map((e) => e.trim()).filter(Boolean)
  if (!xs.length) return ''
  return xs.length > 2 ? `${xs.slice(0, 2).join(' / ')} +${xs.length - 2}` : xs.join(' / ')
}

function stateDiff(inp: DiffInput, changedFiles: Set<string>): StateMachine[] {
  const mb = new Map(machinesOf(inp.before).map((m) => [m.key, m]))
  const ma = new Map(machinesOf(inp.after).map((m) => [m.key, m]))
  const out: StateMachine[] = []
  for (const k of [...new Set([...mb.keys(), ...ma.keys()])].sort()) {
    const b = mb.get(k); const a = ma.get(k)
    const g = machineGraph(b, a)
    const changed = g.nodes.some((n) => n.status !== 'unchanged') || g.edges.some((e) => e.status !== 'unchanged')
    const r = (a ?? b)!
    if (!changed && !changedFiles.has(r.file)) continue
    if (!changed && r.transitions.length === 0) continue
    out.push({ id: k, name: r.name, file: r.file, status: !b ? 'added' : !a ? 'removed' : changed ? 'modified' : 'unchanged', graph: g, source: 'static', origin: r.kind === 'machine' ? 'xstate 状态机' : r.kind === 'enum' ? '枚举' : '字面量联合类型' })
  }
  return out.sort((x, y) => Number(y.status !== 'unchanged') - Number(x.status !== 'unchanged') || y.graph.edges.length - x.graph.edges.length).slice(0, 14)
}

// ---------------------------------------------------------------------------------------------- main
export function buildViews(inp: DiffInput): Views {
  const hops = Math.max(1, Math.min(3, inp.hops ?? 2))
  const mod = moduleDiff(inp)
  const pairs = fnPairs(inp, mod.status)
  const calls = callDiff(inp, pairs, mod.status, hops)
  const classes = classDiff(inp, hops)
  const arch = archDiff(mod.full, mod.status, inp.before, inp.after)
  const impact = impactDiff(mod.full)
  const flows = flowEntries(pairs, inp.beforeOrig)
  const changedFiles = new Set(inp.changed.map((c) => c.path))

  // static sequences for the most-changed functions that actually call something
  const seqCands = pairs.filter((p) => p.status === 'modified' || p.status === 'added')
    .map((p) => ({ p, w: (inp.after.calls.get(p.id)?.size ?? 0) + (p.b ? inp.before.calls.get(p.b.id)?.size ?? 0 : 0) + (p.a?.f.calls.length ?? 0) / 10 }))
    .filter((x) => x.w > 0).sort((x, y) => y.w - x.w || (x.p.id < y.p.id ? -1 : 1)).slice(0, 14)
  const sequences: SeqDiagram[] = []
  for (const { p } of seqCands) {
    const r = (p.a ?? p.b)!
    const sb = p.b ? buildSeq(inp.before, p.b.id, 2, 'before') : null
    const sa = p.a ? buildSeq(inp.after, p.a.id, 2, 'after') : null
    if (sb) for (const it of sb.items) if (it.t === 'msg' && it.site) it.site.file = inp.beforeOrig.get(it.site.file) ?? it.site.file
    const d = mergeSeq(`seq:${p.id}`, `${r.f.owner ? r.f.owner + '.' : ''}${r.f.name}()`, sb, sa, 'static', p.id)
    const msgCount = (xs: typeof d.items): number => xs.reduce((n, x) => n + (x.t === 'msg' ? 1 : x.branches.reduce((m, q) => m + msgCount(q.items), 0)), 0)
    if (msgCount(d.items) >= 2) sequences.push(d)
    if (sequences.length >= 10) break
  }
  const states = stateDiff(inp, changedFiles)

  const summary: VizSummary = { files: cnt(), modules: cnt(), deps: cnt(), functions: cnt(), calls: cnt(), classes: cnt(), states: cnt(), routes: cnt() }
  for (const c of inp.changed) bump(summary.files, c.status === 'A' ? 'added' : c.status === 'D' ? 'removed' : c.status === 'R' ? 'moved' : 'modified')
  for (const n of mod.full.nodes) if (!n.group) bump(summary.modules, n.status)
  for (const e of mod.full.edges) bump(summary.deps, e.status)
  for (const p of pairs) bump(summary.functions, p.status)
  for (const e of calls.full.edges) bump(summary.calls, e.status)
  for (const n of classes.full.nodes) bump(summary.classes, n.status)
  for (const s of states) bump(summary.states, s.status)
  const routeSet = (M: SideModel) => new Set([...M.files.values()].flatMap((f) => f.routes.map((r) => `${r.method} ${r.path}`)))
  const rb = routeSet(inp.before); const ra = routeSet(inp.after)
  for (const r of ra) if (!rb.has(r)) summary.routes.added++
  for (const r of rb) if (!ra.has(r)) summary.routes.removed++

  return { modules: mod.graph, calls: calls.graph, classes: classes.graph, arch, impact, flows, sequences, states, summary }
}
