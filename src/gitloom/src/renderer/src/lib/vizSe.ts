// Software-engineering diagram notation helpers (C4 / UML / IEEE change colours).
// Documented in docs/PLAN.md §12.
import type { EdgeKind, Member, NodeKind } from '@shared/viz'

/** UML visibility mark derived from signature / name prefixes. */
export function visMark(m: Member): string {
  const s = `${m.sig ?? ''} ${m.name}`
  if (/^\s*\+/.test(m.sig ?? '') || /\bpublic\b/i.test(s)) return '+'
  if (/^\s*-/.test(m.sig ?? '') || /\bprivate\b/i.test(s)) return '-'
  if (/^\s*#/.test(m.sig ?? '') || /\bprotected\b/i.test(s)) return '#'
  if (/^\s*~/.test(m.sig ?? '') || /\b(internal|package|fileprivate)\b/i.test(s)) return '~'
  // default: attributes private-ish, methods public-ish (common language default) — leave blank to avoid lying
  return ''
}

/** Strip leading visibility tokens from display name. */
export function memberDisplay(m: Member): string {
  let name = m.name.replace(/^\s*[+\-#~]\s*/, '')
  if (m.kind === 'method' && !/\(/.test(name)) name += '()'
  return name
}

/** Chinese «stereotype» for node kind (C4 / UML role badge). */
export const STEREO: Partial<Record<NodeKind | string, string>> = {
  layer: '容器',
  component: '组件',
  folder: '包',
  file: '文件',
  function: '函数',
  method: '方法',
  class: '类',
  interface: '接口',
  type: '类型',
  enum: '枚举',
  struct: '结构体',
  trait: '特质',
  object: '对象',
  record: '记录',
  route: '路由',
  event: '事件',
  external: '外部系统',
  cluster: '聚类',
  state: '状态',
  initial: '初态',
  final: '终态',
  start: '开始',
  end: '结束',
  decision: '判定',
  step: '活动',
  loop: '循环',
  try: '异常',
  return: '返回',
  throw: '抛出',
  io: '输入输出',
}

export function stereoOf(kind: NodeKind | string, preferClassHead = false): string | null {
  if (preferClassHead && kind === 'class') return null // UML class: name only, no «类» unless interface etc.
  return STEREO[kind] ?? null
}

/** Tooltip explaining the edge notation. */
export const EDGE_NOTE: Partial<Record<EdgeKind, string>> = {
  extends: 'UML 泛化（继承）：实线 + 空心三角箭头，指向父类',
  implements: 'UML 实现：虚线 + 空心三角箭头，指向接口',
  depends: 'UML 依赖：虚线 + 开放箭头',
  uses: 'UML 依赖 / 使用：虚线 + 开放箭头',
  import: '模块导入依赖：虚线 + 开放箭头',
  call: '调用：实线 + 实心箭头（同步）',
  event: '事件 / 消息：实线 + 实心箭头',
  flow: '控制流：实线 + 实心箭头',
  transition: 'UML 状态迁移：事件[守卫]/动作',
  contains: '包含 / 组合：实线',
}

/** Per-tab Chinese notation blurb for the legend strip. */
export const TAB_NOTATION: Record<string, string> = {
  arch: 'C4 风格：外框「容器/层」· 内盒「组件」· 文件为实现单元',
  modules: '模块依赖图（IEEE 变更色）：«模块/文件» + 导入边',
  calls: '调用图：实心箭头 = 同步调用；颜色 = 增删改',
  classes: 'UML 类图：名称 | 属性 | 方法；实线△继承 / 虚线△实现 / 虚线依赖',
  sequence: 'UML 时序：生命线·激活条·实心同步 / 开放异步 / 虚线返回',
  state: 'UML 状态机：●初态 · ◎终态 · 迁移 事件[守卫]/动作',
  flow: '活动/流程图：圆角开始结束 · 菱形判定 · 矩形活动',
  impact: '影响面（维护分析）：热力色 = 距改动点跳数；«影响面»',
  map: '代码地图：按语言/变更/热点着色（与图例一致）',
}
