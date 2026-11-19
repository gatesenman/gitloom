// 0.6.1 看懂改动: deterministic change summary built from a VizResult. Every claim carries evidence (file[:line]).
import type { VizResult, GNode, MapFile, DiffStatus } from '@shared/viz'

export type Confidence = 'high' | 'medium' | 'low'
export interface Evidence { file: string; line?: number; note?: string }
export interface Claim { text: string; evidence: Evidence[]; confidence: Confidence }
export interface AffectedModule { id: string; name: string; layer: string; status: DiffStatus; files: string[]; changed: number; blast: number; evidence: Evidence[] }
export interface RiskHint { id: string; level: '高' | '中' | '低'; title: string; detail: string; evidence: Evidence[]; confidence: Confidence }
export interface FileRow { path: string; oldPath?: string; status: DiffStatus; add: number; del: number; fns?: [number, number, number]; blast: number; hub: boolean; module?: string; importers: string[] }
export interface ChangeSummary {
  stats: { files: number; add: number; del: number; fnAdded: number; fnRemoved: number; fnModified: number; depsChanged: number; modules: number; affectedFiles: number }
  headline: Claim
  modules: AffectedModule[]
  risks: RiskHint[]
  files: FileRow[]
}

const isChanged = (s: DiffStatus) => s !== 'unchanged'
const TEST_RE = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|Test\.java$/i
const CFG_RE = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|requirements\.txt|pyproject\.toml|go\.mod|pom\.xml|build\.gradle|Cargo\.toml|Dockerfile|\.env[^/]*|.*\.ya?ml)$/i

/** file → component id ("a:<prefix>") using the same prefixes the arch graph uses */
export function componentFor(path: string, comps: GNode[]): GNode | undefined {
  // arch component ids drop a common root (e.g. "src/"), so try the path and its suffixes
  const segs = path.split('/')
  for (let k = 0; k < segs.length; k++) {
    const p = segs.slice(k).join('/')
    const noext = p.replace(/\.[^./]+$/, '')
    let best: GNode | undefined
    for (const c of comps) {
      const pre = c.id.slice(2)
      if ((p.startsWith(pre + '/') || noext === pre || p === pre) && (!best || pre.length > best.id.length - 2)) best = c
    }
    if (best) return best
    if (k > 0 && segs.length - k === 1) { const root = comps.find((c) => c.id === 'a:(根目录)'); if (root && /\.(ts|tsx|js|jsx|mjs|py|go|java|kt|rs|cs|vue)$/.test(p)) return root }
  }
  return undefined
}

export function buildSummary(r: VizResult): ChangeSummary {
  const map = r.map
  const mfiles: MapFile[] = map?.files ?? []
  const byPath = new Map(mfiles.map((f) => [f.path, f]))
  const comps = r.arch.nodes.filter((n) => n.kind === 'component')
  const layerName = new Map(r.arch.nodes.filter((n) => n.kind === 'layer').map((n) => [n.id, n.label]))
  const files: FileRow[] = r.files.map((cf) => {
    const m = byPath.get(cf.path)
    const st: DiffStatus = cf.status === 'A' ? 'added' : cf.status === 'D' ? 'removed' : cf.status === 'R' ? 'moved' : 'modified'
    return { path: cf.path, oldPath: cf.oldPath, status: st, add: cf.add ?? m?.add ?? 0, del: cf.del ?? m?.del ?? 0, fns: m?.fns, blast: m?.blast ?? 0, hub: !!m?.hub, module: componentFor(cf.path, comps)?.id, importers: m?.importers ?? [] }
  }).sort((a, b) => b.blast - a.blast || (b.add + b.del) - (a.add + a.del) || a.path.localeCompare(b.path))
  const modules: AffectedModule[] = comps.filter((c) => isChanged(c.status) || files.some((f) => f.module === c.id)).map((c) => {
    const fs = files.filter((f) => f.module === c.id)
    return { id: c.id, name: c.label, layer: layerName.get(c.parent ?? '') ?? '其他', status: c.status, files: fs.map((f) => f.path), changed: fs.length, blast: fs.reduce((n, f) => Math.max(n, f.blast), 0),
      evidence: fs.slice(0, 3).map((f) => ({ file: f.path, note: `${f.status === 'added' ? '新增' : f.status === 'removed' ? '删除' : '修改'} +${f.add} −${f.del}` })) }
  }).filter((m) => m.changed > 0).sort((a, b) => b.changed - a.changed || b.blast - a.blast)
  const sum = r.summary
  const stats = {
    files: files.length, add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0),
    fnAdded: sum.functions.added, fnRemoved: sum.functions.removed, fnModified: sum.functions.modified,
    depsChanged: sum.deps.added + sum.deps.removed, modules: modules.length, affectedFiles: map?.totals.affected ?? 0
  }
  const risks = riskHints(files, stats, r)
  const top = modules.slice(0, 3).map((m) => m.name).join('、')
  const headline: Claim = {
    text: files.length === 0 ? '这次没有文件改动。' : `改了 ${stats.files} 个文件（+${stats.add} −${stats.del}），集中在 ${modules.length} 个模块${top ? `（${top}${modules.length > 3 ? ' 等' : ''}）` : ''}` +
      `${stats.affectedFiles ? `，可能波及另外 ${stats.affectedFiles} 个引用它们的文件` : ''}。`,
    evidence: files.slice(0, 3).map((f) => ({ file: f.path })), confidence: 'high'
  }
  return { stats, headline, modules, risks, files }
}

export function riskHints(files: FileRow[], stats: ChangeSummary['stats'], r: Pick<VizResult, 'map'>): RiskHint[] {
  const out: RiskHint[] = []
  const hubs = files.filter((f) => f.hub && f.status !== 'added')
  if (hubs.length) out.push({ id: 'hub', level: '高', title: `改了 ${hubs.length} 个核心文件`, detail: '这些文件被很多文件引用，出错影响面大，建议重点审查并补测试。', evidence: hubs.slice(0, 5).map((f) => ({ file: f.path, note: `被 ${f.blast} 个文件间接引用` })), confidence: 'high' })
  const wide = files.filter((f) => !f.hub && f.blast >= 10)
  if (wide.length) out.push({ id: 'blast', level: '中', title: `${wide.length} 个文件影响面较广`, detail: '每个文件都有 10 个以上的直接或间接引用方。', evidence: wide.slice(0, 5).map((f) => ({ file: f.path, note: `影响 ${f.blast} 个文件` })), confidence: 'high' })
  const removedFns = files.filter((f) => (f.fns?.[1] ?? 0) > 0 && f.importers.length > 0)
  if (removedFns.length) out.push({ id: 'removed-api', level: '高', title: '删除了仍被引用文件中的函数', detail: '被删除的函数如果仍被调用，会导致运行出错。', evidence: removedFns.slice(0, 5).map((f) => ({ file: f.path, note: `删除 ${f.fns![1]} 个函数；引用方如 ${f.importers[0]}` })), confidence: 'medium' })
  const src = files.filter((f) => !TEST_RE.test(f.path) && !CFG_RE.test(f.path) && f.status !== 'removed')
  const tests = files.filter((f) => TEST_RE.test(f.path))
  if (src.length >= 1 && tests.length === 0 && stats.add + stats.del > 20) out.push({ id: 'no-tests', level: '中', title: '改了代码但没有改测试', detail: '本次没有任何测试文件改动，建议确认已有测试能覆盖。', evidence: src.slice(0, 3).map((f) => ({ file: f.path })), confidence: 'medium' })
  const cfg = files.filter((f) => CFG_RE.test(f.path))
  if (cfg.length) out.push({ id: 'config', level: '中', title: '改了依赖或配置文件', detail: '依赖、构建或环境配置改动可能影响所有人，合并前确认版本与环境。', evidence: cfg.slice(0, 5).map((f) => ({ file: f.path })), confidence: 'high' })
  if (stats.add + stats.del > 800 || stats.files > 40) out.push({ id: 'big', level: '低', title: '改动量大', detail: `共 ${stats.files} 个文件、${stats.add + stats.del} 行，建议拆成更小的提交便于审查。`, evidence: files.slice(0, 3).map((f) => ({ file: f.path })), confidence: 'high' })
  if (r.map?.coverage === 'partial') out.push({ id: 'partial', level: '低', title: '依赖分析不完整', detail: r.map.coverageNote ?? '仓库过大，只分析了部分文件，影响范围可能被低估。', evidence: [], confidence: 'low' })
  return out
}

// ── 当前架构 (C4: 系统上下文 → 容器 → 组件), single side (HEAD) ──
export interface C4Component { id: string; name: string; files: number; evidence: Evidence[]; confidence: Confidence; dependsOn: { id: string; name: string; count: number }[]; usedBy: number }
export interface C4Container { id: string; name: string; components: C4Component[]; confidence: Confidence }
export interface C4Model { system: { name: string; files: number; langs: string[]; routes: number }; externals: { name: string; evidence: Evidence[] }[]; containers: C4Container[]; notes: string[] }

export function buildC4(r: VizResult, repoName: string): C4Model {
  const comps = r.arch.nodes.filter((n) => n.kind === 'component')
  const mfiles = r.map?.files ?? []
  const filesOf = (c: GNode) => mfiles.filter((f) => componentFor(f.path, [c]) && componentFor(f.path, comps)?.id === c.id)
  const deps = r.arch.edges.filter((e) => e.kind === 'depends' && e.status !== 'removed')
  const name = new Map(comps.map((c) => [c.id, c.label]))
  const containers: C4Container[] = r.arch.nodes.filter((n) => n.kind === 'layer').map((l): C4Container => {
    const cs = comps.filter((c) => c.parent === l.id).map((c): C4Component => {
      const fs = filesOf(c).sort((a, b) => (b.inA ?? 0) - (a.inA ?? 0))
      const out = deps.filter((e) => e.source === c.id)
      const conf: Confidence = l.id === 'L:other' ? 'low' : out.length || deps.some((e) => e.target === c.id) ? 'high' : 'medium'
      return {
        id: c.id, name: c.label, files: c.count ?? fs.length, confidence: conf,
        evidence: fs.slice(0, 3).map((f) => ({ file: f.path, line: 1, note: f.inA ? `被 ${f.inA} 个文件引用` : undefined })),
        dependsOn: out.map((e) => ({ id: e.target, name: name.get(e.target) ?? e.target.slice(2), count: e.weight ?? 1 })).sort((a, b) => b.count - a.count),
        usedBy: deps.filter((e) => e.target === c.id).length
      }
    })
    return { id: l.id, name: l.label, components: cs, confidence: l.id === 'L:other' ? 'low' : 'medium' }
  }).filter((c) => c.components.length)
  const extNames = new Map<string, Evidence[]>()
  for (const sq of r.sequences) for (const p of sq.participants) if (p.kind === 'external' || p.kind === 'db' || p.kind === 'service') {
    const site = sq.items.find((i) => i.t === 'msg' && i.to === p.id && i.site)
    if (!extNames.has(p.label)) extNames.set(p.label, site && site.t === 'msg' && site.site ? [{ file: site.site.file, line: site.site.line }] : [])
  }
  const routes = comps.reduce((n, c) => n + Number(/(\d+) 接口/.exec(c.sub ?? '')?.[1] ?? 0), 0)
  return {
    system: { name: repoName, files: r.map?.totals.filesA ?? mfiles.length, langs: Object.keys(r.stats.langs), routes },
    externals: [...extNames].slice(0, 20).map(([name, evidence]) => ({ name, evidence })),
    containers,
    notes: [
      '层级按目录名与依赖关系推断（静态分析，不运行代码）。',
      '置信度：高 = 有源码 import 依赖佐证；中 = 仅目录命名推断；低 = 无法归类（放在「其他」）。',
      ...(r.map?.coverage === 'partial' ? [r.map.coverageNote ?? '仓库过大，只分析了部分文件。'] : [])
    ]
  }
}
