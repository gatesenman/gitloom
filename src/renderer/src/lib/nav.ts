export type View = 'changes' | 'history' | 'graph' | 'branches' | 'tags' | 'worktrees' | 'stash' | 'hooks' | 'ai' | 'settings' | 'dashboard' | 'allchanges' | 'repos' | 'rebase' | 'bisect' | 'tools' | 'submodules' | 'forge' | 'blame' | 'viz' | 'knowledge' | 'quality' | 'automation' | 'aitasks' | 'summary' | 'architecture' | 'architecture-graph'

/** Everyday tabs, always visible in the repo view (Mod+1..3). `story` = the user story shown in its empty state. */
export interface PrimaryTab { id: View; label: string; icon: string; tip: string; story: string; /** views that highlight this tab */ match: View[] }
export const PRIMARY: PrimaryTab[] = [
  { id: 'changes', label: '变更', icon: 'changes', tip: '查看改动、暂存并提交', match: ['changes'],
    story: '改了几个文件，想先看看到底动了哪些行，挑出要提交的部分，写一句说明后提交。' },
  { id: 'history', label: '历史', icon: 'history', tip: '提交历史：列表 / 提交图（所有分支）切换', match: ['history', 'graph'],
    story: '想知道这个项目最近都发生了什么、某个功能是哪天合进来的，或者各分支是怎么分叉又合并的。' },
  { id: 'branches', label: '分支', icon: 'branch', tip: '本地/远程分支、标签与发布、远程仓库与引用日志', match: ['branches', 'tags'],
    story: '要开始做一个新功能、切回 main 修个紧急 bug，或者给发布版本打个标签。' }
]

/** Sub-sections of the 分支 tab. */
export const BRANCH_SECTIONS: { id: View; label: string; icon: string; tip: string }[] = [
  { id: 'branches', label: '分支与标签', icon: 'branch', tip: '本地/远程分支、标签、远程仓库与引用日志' },
  { id: 'tags', label: '标签与发布', icon: 'tag', tip: '本地/远程标签、创建附注或轻量标签、推送/删除、发布说明草稿' },
  { id: 'stash', label: '储藏', icon: 'stash', tip: '临时收起未提交的改动，稍后再取回（git stash）' },
  { id: 'worktrees', label: '工作树', icon: 'worktree', tip: '同一仓库同时检出多个分支到不同文件夹（git worktree）' }
]

/** Intro card content (what it is + the user story) for every non-everyday view. */
export interface ViewStory { id: View; label: string; icon: string; desc: string; story: string }
export const STORIES: ViewStory[] = [
  { id: 'viz', label: '变更可视化', icon: 'viz', desc: '把一次改动画成「改动前 / 改动后」的架构图、依赖图、调用图、流程图、时序图、状态图、类图和影响范围',
    story: '同事提了一个动了 30 个文件的重构 PR，想先看一眼「分层有没有变、哪些模块之间多了依赖、状态机多了哪个状态」，再决定从哪里开始审代码。' },
  { id: 'rebase', label: '整理提交（变基）', icon: 'rebase', desc: '重新排序、合并、改写或丢弃最近的若干提交（git rebase -i）',
    story: '功能做完了，但提交记录里全是「wip」「修个 typo」「再改一下」，推送前想把这 8 个零碎提交合成 2 个干净的提交。' },
  { id: 'bisect', label: '二分查错', icon: 'bisect', desc: '标记好/坏提交，自动对半缩小范围，找到第一个出问题的提交（git bisect）',
    story: '上周还好好的，今天坏了，中间有 200 个提交，对半查找是哪次搞坏的——大约 8 次测试就能定位。' },
  { id: 'tools', label: '文件追溯', icon: 'blame', desc: '逐行追溯（blame）与文件历史，外加忽略规则、代码搜索、比较分支、清理、配置、LFS 与签名',
    story: '看到一行奇怪的代码，想知道是谁、在哪次提交、为什么这样改的；或者想找出「这个函数名是哪次提交删掉的」。' },
  { id: 'submodules', label: '子模块', icon: 'repo-submodule', desc: '初始化、更新、同步当前仓库引用的其它仓库（git submodule）',
    story: '刚克隆下来的项目编译报错，原来 vendor 里的几个子模块还是空的，需要一键拉下来并更新到正确版本。' },
  { id: 'forge', label: 'PR 与 Issue', icon: 'pr', desc: '查看和创建 GitHub Pull Request / GitLab Merge Request、Issue 与 CI 状态',
    story: '分支推上去了，想直接在这里发起 PR，顺便看看同事的 PR 有没有通过 CI，而不用切到浏览器。' },
  { id: 'ai', label: 'AI 助手', icon: 'ai', desc: '就当前仓库提问，生成提交信息、解释改动或冲突、把自然语言转成 git 命令',
    story: '休假回来，想问一句「这两周仓库里都改了什么？」，或者忘了命令，直接说「撤销上一次提交但保留改动」。' },
  { id: 'hooks', label: 'Git 钩子', icon: 'hook', desc: '在提交、推送等时刻自动运行的脚本（.git/hooks）',
    story: '团队总有人提交了没格式化的代码，想让每次提交前自动跑一遍 lint，提交信息不符合规范就拦下来。' },
  { id: 'tags', label: '标签与发布', icon: 'tag', desc: '列出本地/远程标签，创建附注或轻量标签，推送与删除，并可从近期提交生成中文发布说明草稿',
    story: '准备发版：想看本地和远程各有哪些标签、打一个 v1.2.0、推上去，再根据近期提交写一段白话发布说明。' },
  { id: 'stash', label: '储藏', icon: 'stash', desc: '把未提交的改动临时收起来，稍后再取回（git stash）',
    story: '写到一半，老板让你马上修线上 bug；先把手头的改动「收进抽屉」，切分支修完再拿出来继续写。' },
  { id: 'worktrees', label: '工作树', icon: 'worktree', desc: '把同一仓库的另一个分支检出到另一个文件夹，同时打开（git worktree）',
    story: '正在 feature 分支上跑一个很久的构建，又要在 main 上看同事的代码——不想来回切换，就给 main 开一个独立的工作文件夹。' }
]
export const storyOf = (v: View): ViewStory | undefined => STORIES.find((s) => s.id === v)

export interface AdvancedItem { id: View; label: string; short: string; icon: string; desc: string; keywords: string; /** only listed when the repo has submodules */ needsSubmodules?: boolean }

/** Flat secondary tabs in 日常 Git (0.6.5-hotfix.1: no 「更多 ▾」, no viz). Also in command palette. 变更可视化 → 看懂改动；Git 钩子 → 设置/自动化. */
export const ADVANCED: AdvancedItem[] = [
  /* viz 仅属「看懂改动」，不进日常 Git 平铺（0.6.5-hotfix.1） */
  { id: 'rebase', label: '整理提交（变基）', short: '整理提交', icon: 'rebase', desc: '推送前合并、重排、改写或丢弃最近的提交', keywords: 'rebase interactive squash fixup reword 变基 交互式 合并提交' },
  { id: 'bisect', label: '二分查错', short: '二分查错', icon: 'bisect', desc: '对半查找是哪次提交引入了 bug', keywords: 'bisect 二分 bug 回归 定位' },
  { id: 'tools', label: '文件追溯', short: '文件追溯', icon: 'blame', desc: '这行代码是谁、何时、为何改的（blame / 文件历史 / 忽略规则 / 代码搜索）', keywords: 'blame annotate file history pickaxe compare clean config lfs signing gitignore ignore 忽略 工具 追溯 搜索 比较 清理 配置 签名' },
  { id: 'submodules', label: '子模块', short: '子模块', icon: 'repo-submodule', desc: '初始化、更新、同步引用的其它仓库', keywords: 'submodule 子模块 gitmodules', needsSubmodules: true },
  { id: 'forge', label: 'PR 与 Issue', short: 'PR 与 Issue', icon: 'pr', desc: '在 GitHub / GitLab 上的 PR、Issue 与 CI 状态', keywords: 'forge github gitlab pull request merge request issue ci pr mr' },
  { id: 'ai', label: 'AI 助手', short: 'AI 助手', icon: 'ai', desc: '就当前仓库提问，或用中文描述要执行的 git 操作', keywords: 'ai chat assistant 助手 提交信息 解释' }
]

export const advancedOf = (v: View): AdvancedItem | undefined => ADVANCED.find((a) => a.id === v)
export const isAdvanced = (v: View): boolean => !!advancedOf(v)
/** The primary tab that should be highlighted for a given view (or undefined). */
export const primaryOf = (v: View): PrimaryTab | undefined => PRIMARY.find((p) => p.match.includes(v))
/** Advanced tabs visible for a repo: 子模块 only when the repo actually has submodules. */
export const visibleAdvanced = (ctx: { submoduleCount: number | null }): AdvancedItem[] => ADVANCED.filter((a) => !a.needsSubmodules || (ctx.submoduleCount ?? 0) > 0)
export const introKey = (id: View) => `gitloom.intro.${id}`

// ── 0.6.0: six top-level modules (see docs/GitLoom-需求收敛-v1.1.md §4/§6) ──
export type ModuleId = 'daily' | 'workspace' | 'understand' | 'knowledge' | 'quality' | 'automation'
export interface ModuleDef { id: ModuleId; label: string; icon: string; tip: string; home: View; /** views that belong to (highlight) this module */ views: View[]; /** needs an open repo */ needsRepo: boolean }
export const MODULES: ModuleDef[] = [
  { id: 'daily', label: '日常 Git', icon: 'branch', home: 'changes', needsRepo: true, tip: '纯 Git 操作：提交、历史、分支、标签与发布、储藏、工作树、变基、二分查错、文件追溯、子模块、PR 与 Issue、AI 助手（不含可视化/架构/Wiki）',
    views: ['changes', 'history', 'graph', 'branches', 'tags', 'stash', 'worktrees', 'rebase', 'bisect', 'tools', 'blame', 'submodules', 'forge', 'ai'] },
  { id: 'workspace', label: '工作区', icon: 'dashboard', home: 'dashboard', needsRepo: false, tip: '整个项目或一组仓库：概览（状态/批量）、跨仓变更、仓库与扫描（列表/固定/隐藏/重扫）',
    views: ['dashboard', 'allchanges', 'repos'] },
  { id: 'understand', label: '看懂改动', icon: 'viz', home: 'summary', needsRepo: true, tip: '只服务某次改动（工作区/暂存/提交/分支对比）：改动摘要与可视化（前后对比图/代码地图/阅读路线等）。与「架构与知识」（当前现状）互不跳转',
    views: ['summary', 'viz'] },
  { id: 'knowledge', label: '架构与知识', icon: 'book', home: 'knowledge', needsRepo: false, tip: '只服务当前现状（默认 HEAD）：页内 C4、模块架构图、项目 Wiki、知识图谱、llmwiki。不服务某次 diff，不跳进「看懂改动」',
    views: ['knowledge', 'architecture', 'architecture-graph'] },  /* architecture* 仅兼容旧路由高亮；主入口是 knowledge 页内嵌 */
  { id: 'quality', label: '质量把关', icon: 'shield', home: 'quality', needsRepo: false, tip: '提交前一键体检：密钥、坏味道、依赖漏洞；可选 AI 审查、钩子与工具。不用会命令行',
    views: ['quality'] },
  { id: 'automation', label: '自动化', icon: 'zap', home: 'automation', needsRepo: false, tip: '事件触发规则、Git 钩子与模板库、AI 定时任务；各区自带运行记录',
    views: ['automation', 'hooks', 'aitasks'] }
]
export const moduleOf = (v: View): ModuleDef | undefined => MODULES.find((m) => m.views.includes(v))

/** Which secondary strip ViewTabs renders: workspace / daily / understand, or none (hubs). */
export type ViewTabStrip = 'workspace' | 'daily' | 'understand' | 'automation' | null
export const isWorkspaceView = (v: View): boolean => moduleOf(v)?.id === 'workspace'
export const viewTabStrip = (v: View): ViewTabStrip => {
  const id = moduleOf(v)?.id
  if (id === 'workspace') return 'workspace'
  if (id === 'daily') return 'daily'
  if (id === 'understand') return 'understand'
  if (id === 'automation') return 'automation'
  return null
}
export type Scope = 'repo' | 'project' | 'group'
export const SCOPES: { id: Scope; label: string; tip: string }[] = [
  { id: 'repo', label: '当前仓库', tip: '只看左侧选中的一个仓库' },
  { id: 'project', label: '整个项目', tip: '项目文件夹里的全部仓库' },
  { id: 'group', label: '仓库组', tip: '项目里某个文件夹下的一组仓库（点击选择文件夹）' }
]
/** which scope the current view represents */
export const scopeOf = (v: View, folderScope: string | null): Scope =>
  isWorkspaceView(v) ? (folderScope ? 'group' : 'project') : 'repo'
/** Title-bar crumb for the current view (module / secondary tab). Null for everyday daily-Git tabs that already show repo+branch. */
export function crumbViewLabel(v: View): string | null {
  if (v === 'settings') return '设置'
  const mod = moduleOf(v)
  if (!mod) return null
  if (mod.id === 'workspace') {
    if (v === 'allchanges') return '跨仓变更'
    if (v === 'repos') return '仓库与扫描'
    return '概览'
  }
  if (mod.id === 'automation') {
    if (v === 'hooks') return '钩子'
    if (v === 'aitasks') return '定时任务'
    return '事件触发'
  }
  if (mod.id === 'understand') {
    if (v === 'viz') return '可视化'
    return '改动摘要'
  }
  if (mod.id === 'knowledge') return '架构与知识'
  if (mod.id === 'quality') return '质量把关'
  return null
}

/** DG-2: hints shown at old locations for one major version */
export const MOVED: { from: string; to: string }[] = [
  { from: '设置 → Git 钩子', to: '自动化 → 钩子（设置中的入口保留）' },
  { from: '自动化顶栏「运行记录 / 事件触发（规划中）」', to: '自动化二级：事件触发 | 钩子 | 定时任务（各区自带运行记录）' },
  { from: '日常 Git → 变更可视化（已移除）', to: '看懂改动模块（改动摘要 | 可视化）；日常 Git 不再提供入口' },
  { from: '看懂改动 → 深入三按钮（前后对比图 / 代码地图 / 阅读路线）', to: '已合并为二级「可视化」；摘要页用「打开可视化」进入，工具子页签在可视化内' },
  { from: '概览 / 跨仓库变更', to: '工作区' },
  { from: '工作区顶栏曾混排日常 Git 标签（变更/历史/分支/…）', to: '工作区仅保留「概览」「跨仓变更」「仓库与扫描」；其余在「日常 Git」（选中仓库后）' },
  { from: '架构与知识 → 代码地图 / 阅读路线', to: '看懂改动（改动向）；架构与知识只做 HEAD 现状，页内不再跳转' },
  { from: '质量把关 → 去变更页审查', to: '质量把关本页即可审查（变更页入口保留）' }
]
