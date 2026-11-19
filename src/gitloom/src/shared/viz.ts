// 变更可视化 (Change Visualizer) — types shared by the main-process pipeline and the renderer.
//
// Pipeline: git (before/after trees, no checkout) → tree-sitter facts per file (worker, cached by blob sha)
//   → CodeModel per side → typed graph diff (every node/edge: added/removed/modified/moved/unchanged)
//   → optional AI enrichment (strict JSON, zod-validated, grounded on the static facts).
// Every diagram is ONE merged DiffGraph; the "before" picture = all items except `added`, "after" = all except
// `removed`. Laying out the merged graph once gives before/after pictures that line up pixel for pixel.

export type DiffStatus = 'added' | 'removed' | 'modified' | 'moved' | 'unchanged'

export type VizScope =
  | { kind: 'working' }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'refs'; base: string; head: string }

export interface VizRequest {
  repo: string
  scope: VizScope
  /** path prefix / folder / package filter (repo-relative, posix) */
  filter?: string
  /** neighbour hops kept around changed nodes in the call/class graphs (1..3) */
  hops?: number
}

export interface Loc { file: string; line: number; endLine?: number }

export type NodeKind =
  | 'layer' | 'component' | 'folder' | 'file' | 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum'
  | 'struct' | 'trait' | 'object' | 'record' | 'route' | 'event' | 'external'
  | 'start' | 'end' | 'step' | 'decision' | 'loop' | 'try' | 'return' | 'throw' | 'io'
  | 'state' | 'initial' | 'final' | 'cluster'

export type EdgeKind = 'import' | 'call' | 'extends' | 'implements' | 'uses' | 'flow' | 'transition' | 'depends' | 'event' | 'contains'

export interface Member { name: string; kind: 'field' | 'method' | 'value'; status: DiffStatus; sig?: string }

export interface GNode {
  id: string
  label: string
  kind: NodeKind
  status: DiffStatus
  parent?: string
  /** secondary line (file name, counts, layer…) */
  sub?: string
  before?: Loc
  after?: Loc
  members?: Member[]
  /** impact distance (0 = changed) */
  dist?: number
  /** fan-in / size hint */
  weight?: number
  /** this node is a container (folder / layer / file group) */
  group?: boolean
  /** nodes collapsed into this cluster */
  count?: number
  lang?: string
  note?: string
  /** hub file: imported by ≥ CodeMap.hubMin files (0.5.1) */
  hub?: boolean
}

export interface GEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
  status: DiffStatus
  label?: string
  /** call / import site for the hover card */
  site?: Loc & { side: 'before' | 'after' }
  weight?: number
}

export interface DiffGraph { nodes: GNode[]; edges: GEdge[]; truncated?: number }

// ---- sequence diagrams ------------------------------------------------------------------------------------
export interface SeqParticipant { id: string; label: string; kind?: 'actor' | 'class' | 'module' | 'external' | 'service' | 'db'; status: DiffStatus }
export type SeqItem =
  | { t: 'msg'; from: string; to: string; label: string; status: DiffStatus; ret?: boolean; async?: boolean; depth?: number; site?: Loc & { side: 'before' | 'after' } }
  | { t: 'frame'; kind: 'alt' | 'loop' | 'opt' | 'try' | 'par'; label: string; status: DiffStatus; branches: { label: string; items: SeqItem[] }[] }
export interface SeqDiagram { id: string; title: string; status: DiffStatus; participants: SeqParticipant[]; items: SeqItem[]; source: 'static' | 'ai'; fn?: string }

// ---- state machines ---------------------------------------------------------------------------------------
export interface StateMachine { id: string; name: string; file?: string; status: DiffStatus; graph: DiffGraph; source: 'static' | 'ai'; origin?: string }

// ---- per-function control flow ----------------------------------------------------------------------------
export interface FlowEntry { id: string; label: string; file: string; status: DiffStatus; owner?: string; graph: DiffGraph; changeSize: number; source?: 'static' | 'ai' }

export interface ChangedFile { path: string; oldPath?: string; status: 'A' | 'D' | 'M' | 'R'; lang?: string; add?: number; del?: number }

export interface SummaryCount { added: number; removed: number; modified: number; moved?: number }
export interface VizSummary {
  files: SummaryCount
  modules: SummaryCount
  deps: SummaryCount
  functions: SummaryCount
  calls: SummaryCount
  classes: SummaryCount
  states: SummaryCount
  routes: SummaryCount
}

export interface VizStats { files: number; parsed: number; cached: number; ms: number; parseMs: number; gitMs: number; langs: Record<string, number>; unsupported: number; truncatedFiles?: number }

export interface VizResult {
  id: string
  repo: string
  scope: VizScope
  filter?: string
  beforeRef: string
  afterRef: string
  beforeLabel: string
  afterLabel: string
  /** stable key for AI caching: before sha + after sha (+ worktree content hash) + filter */
  key: string
  files: ChangedFile[]
  summary: VizSummary
  arch: DiffGraph
  modules: DiffGraph
  calls: DiffGraph
  classes: DiffGraph
  impact: DiffGraph
  flows: FlowEntry[]
  sequences: SeqDiagram[]
  states: StateMachine[]
  /** codemap-style project map with before/after sizes, importers, blast radius (0.5.1) */
  map?: CodeMap
  /** static review / code-path tour over the changed files (0.5.1) */
  tour?: Tour
  stats: VizStats
  warnings: string[]
}

// ---- code map (codemap-style tree / treemap with before ↔ after) ------------------------------------------
export interface MapFile {
  /** after path (before path when removed) */
  path: string
  oldPath?: string
  status: DiffStatus
  /** unchanged file that (transitively) imports a changed file */
  affected?: boolean
  lang?: string
  bytesB?: number
  bytesA?: number
  linesB?: number
  linesA?: number
  add?: number
  del?: number
  /** direct importers before / after */
  inB?: number
  inA?: number
  /** files this one imports (after, or before when removed) */
  out?: number
  /** transitive importers (who may break) */
  blast?: number
  hub?: boolean
  /** importers gained / lost by this change (≤ 20 each) */
  gained?: string[]
  lost?: string[]
  /** a few current importers (≤ 12) */
  importers?: string[]
  /** changed functions in the file: added / removed / modified */
  fns?: [number, number, number]
}
export type Coverage = 'complete' | 'partial' | 'none'
export interface CodeMap {
  files: MapFile[]
  totals: { filesB: number; filesA: number; bytesB: number; bytesA: number; linesB: number; linesA: number; add: number; del: number; changed: number; affected: number }
  /** importer count at which a file counts as a hub */
  hubMin: number
  /** hub paths, most imported first (after side) */
  hubs: string[]
  /** dependency coverage, codemap-style: complete / partial (big repo cropped) / none (no source files) */
  coverage: Coverage
  coverageNote?: string
  /** files left out of the map (huge repos) */
  truncated?: number
}

// ---- tour (Codemaps-style numbered code path, static or AI) -----------------------------------------------
export interface TourStep {
  /** "1", "1a", "1b"… */
  n: string
  id: string
  title: string
  status: DiffStatus
  kind: 'file' | 'function' | 'class'
  file: string
  before?: Loc
  after?: Loc
  /** plain-language why this step matters */
  why: string
  /** step ids this step calls / imports (drawn as edges) */
  next?: string[]
  hub?: boolean
}
export interface TourGroup { id: string; title: string; guide?: string; steps: TourStep[] }
export interface Tour { id: string; title: string; summary?: string; source: 'static' | 'ai'; question?: string; model?: string; groups: TourGroup[] }

/** AI enrichment, already validated + converted to the same diff structures. */
export interface VizAIResult {
  key: string
  model: string
  headline?: string
  risk?: 'low' | 'medium' | 'high'
  arch?: DiffGraph
  sequences: SeqDiagram[]
  states: StateMachine[]
  flows: FlowEntry[]
  repaired?: boolean
  retried?: boolean
}

export type VizViewId = 'map' | 'tour' | 'arch' | 'modules' | 'calls' | 'flow' | 'sequence' | 'state' | 'classes' | 'impact'

export const VIZ_VIEWS: { id: VizViewId; label: string; icon: string; tip: string }[] = [
  { id: 'map', label: '代码地图', icon: 'codemap', tip: '项目文件地图：每个文件改动前后的大小、行数、被多少文件引用、影响面；标出热点文件（类似 codemap --diff）' },
  { id: 'tour', label: '改动导览', icon: 'tour', tip: '按调用顺序编号的阅读路线：先看哪个文件、再看哪个函数，每步直达代码；AI 可按你的问题生成路径' },
  { id: 'arch', label: '架构图', icon: 'layers', tip: '分层 / 组件视角：哪些组件新增、删除或被改动，组件间依赖怎么变' },
  { id: 'modules', label: '模块依赖', icon: 'modules', tip: '文件 / 模块之间的 import 依赖，按文件夹聚类，可折叠' },
  { id: 'calls', label: '调用图', icon: 'calls', tip: '改动的函数及其调用方 / 被调用方' },
  { id: 'flow', label: '流程图', icon: 'flow', tip: '选中函数的控制流（分支、循环、返回、异常）前后对比；AI 可生成业务流程' },
  { id: 'sequence', label: '时序图', icon: 'sequence', tip: '主要调用链的时序：参与者、消息、alt / loop 片段' },
  { id: 'state', label: '状态图', icon: 'state', tip: '状态枚举 / 状态机的状态与迁移前后对比' },
  { id: 'classes', label: '类 / 数据模型', icon: 'classes', tip: '类、接口、类型及成员的增删改，继承与实现关系' },
  { id: 'impact', label: '影响范围', icon: 'impact', tip: '从改动点出发，谁依赖它（热度 = 距离）' }
]

export const scopeLabel = (s: VizScope): string =>
  s.kind === 'working' ? '工作区改动' : s.kind === 'commit' ? `提交 ${s.sha.slice(0, 7)}` : s.kind === 'range' ? `${s.from.slice(0, 12)}..${s.to.slice(0, 12)}` : `${s.base} ↔ ${s.head}`
