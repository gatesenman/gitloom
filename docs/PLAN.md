# GitLoom 织线 — 产品规划（PLAN）

> 版本：v0.4.1（导航重整：日常标签 + 「更多 ▾」，按钮布局统一）· 2026-10-19；v0.4.0（P1+P2 高级生命周期 / AI / Forge）  
> 产品名：**GitLoom（中文名：织线）**。寓意：把多个仓库、多个分支、多个工作树的 Git 工作流"织"在一起。Logo 为一条主干（trunk）与一条特性分支交织后合并，背景是织机的纬线。  
> 技术栈：Electron 33 + React 18 + TypeScript + Vite（electron-vite）+ Monaco Editor，底层调用系统 `git` CLI（`child_process.spawn`，不经 shell）。

---

## 1. 参考项目 Zide 调研结论

调研方式：GitHub API（`api.github.com/repos/zide-software/Zide`）、浅克隆仓库、拉取全部 22 个 Release 的发布说明（v0.6.0-beta.16 → v0.7.5，`VERSION` 文件为 v0.7.6-rc.1）、官网 zide.dev 与文档 docs.zide.dev。

**关键事实**

| 项目 | 结论 |
|---|---|
| 仓库是否存在 | ✅ 存在，公开：<https://github.com/zide-software/Zide>（描述：Native development workspace for issues, code, AI assistance, git, CI, and pull requests） |
| 是否开源 | ❌ **闭源专有软件**。README 明确写 "Zide is closed-source proprietary software"。公开仓库只有 README / VERSION / CONTRIBUTING / SECURITY / CODE_OF_CONDUCT、Issue 模板、2 个 issue 自动化 workflow 和 logo 资源，**没有任何源代码**（源码在私有仓库 Zide-src）。 |
| 技术栈 | Tauri + Rust（官网与 release notes 中的 rustls / RUSTSEC / tokio 记录可证实），前端编辑器用 CodeMirror |
| 平台 | Windows 10/11（x64/arm64，含 Microsoft Store 版）、macOS（dmg，arm64）、Linux（AppImage / deb，需 glibc ≥ 2.39） |
| 功能来源 | 以下功能**全部来自其官方 release notes / 官网 / 文档的文字描述**，未作臆测；无法读取源码，因此只能对标"行为"而非实现。 |

**Zide 功能清单（按其发布说明归纳）与 GitLoom 对应计划**

| Zide 功能（出处：release notes / zide.dev） | GitLoom 阶段 | 说明 |
|---|---|---|
| 多仓库工作区、Project Tab、多项目并行 | **P1 ✅** | 侧边栏多仓库，自动识别目录下所有仓库 |
| Staging：按块（hunk）暂存、丢弃、工作区 diff 随磁盘变化自动刷新 | **P1 ✅** | 文件 / 块 / **按行** 暂存、取消暂存、丢弃；4 秒轮询刷新 |
| Commit 视图、Diffs 视图（提交 / 储藏 / reflog 的所有改动文件） | **P1 ✅（部分）** | 提交详情 + 文件列表 + Monaco 差异；储藏差异；Stacked 多文件同屏 P2 |
| 超大 diff 延迟渲染（Show Diff） | **P1 ✅（简化）** | >4MB 文件跳过渲染；P2 增加"仍然显示"按钮 |
| Commits：HEAD 标记、标签跳转、从提交/标签/reflog 创建分支 | **P1 ✅** | 分支图中 HEAD/本地/远程/标签徽标；右键从提交建分支；reflog"恢复为分支" |
| 交互式变基（重排/改写/编辑/压缩/fixup/丢弃，计划可保存，前后对比） | **P2 ✅（v0.4）** | `GIT_SEQUENCE_EDITOR` 注入计划文件实现 |
| Fixup 提交 & Autosquash | P2 | `commit --fixup` + `rebase -i --autosquash` |
| Bisect（标记 good/bad、过程记录、跟随终端中的 bisect） | **P2 ✅（v0.4）** | P1 已能识别 BISECTING 状态并提供"中止" |
| 搜索改动代码（pickaxe `-S` / `-G` 正则 + 路径） | **P2 ✅（v0.4）** | P1 支持按提交信息 `--grep` 搜索 |
| Compare Refs（任意两个引用比较） | **P2 ✅（v0.4）** | |
| 文件历史（分页 >50）、Blame | **P2 ✅（v0.4）** | 服务层已支持 `log --follow -- file` |
| 提交 / 标签签名引导（GPG / SSH）、Test Signing、单次提交签名开关 | P1 状态展示 ✅ / P2 引导 | P1 设置页显示签名状态；服务层支持 `-S` / `--no-gpg-sign` |
| 部分克隆（partial clone）按需下载历史对象 | P3 | P1 检测浅克隆 |
| LFS：文件级 LFS 状态、Pull/Push/Track | **P1 检测 ✅ / P2 ✅（v0.4）** | P1 检测仓库是否使用 LFS、是否安装 git-lfs |
| clean / smudge 过滤器、working-tree-encoding、post-checkout 钩子时走 git 原生路径 | **P1 ✅（天然满足）** | GitLoom 所有写操作都通过 git CLI，天然遵守过滤器与钩子 |
| 子模块：init/update/sync/deinit、嵌套、树状态 | **P2 ✅（v0.4）** | P1 服务层能列出子模块；状态中识别子模块 |
| Subtrees（添加 / split / 同步状态 / 配置） | P3 | |
| 稀疏检出（cone 模式、选择目录） | P3 | P1 检测是否启用 |
| 工作树：列表 / 创建 / 打开 / 锁定 / 移除 / 修复 / "完成工作树"（合并回父分支并清理） | **P1 ✅（列表/创建/打开/锁定/移除/prune）** / P2（repair、finish 向导） | |
| QuickTree：根据一句提示创建工作树并开启 AI 会话 | P2 | 结合 AI 分支名建议 + 工作树创建 |
| Git Clean（先审阅清理计划、可含 ignored 文件、保护嵌套仓库） | **P2 ✅（v0.4）** | P1 可丢弃未跟踪文件 |
| 仓库配置编辑器（按作用域优先级） | **P2 ✅（v0.4）** | P1 可编辑 user.name/email（本仓库/全局） |
| Hooks 列表（启用/禁用、不可用原因、钩子管理器徽标） | **P1 ✅** | 并新增模板库（含 llmwiki） |
| 远程管理（多 fetch URL、安全检查） | P1 基础 ✅ / P2 | 添加/移除/抓取远程 |
| 同步预览（拉取/推送前预览将发生什么）、推送前子模块检查 | P2 | P1 显示 ahead/behind 计数 |
| Fetch History（抓取历史记录） | P2 | P1 有完整的 Git 命令日志面板 |
| GitHub / GitLab：Issue、PR/MR、CI 状态徽章 | **P2 ✅（v0.4 基础）** / Bitbucket P3 | 先做 GitHub（REST + Device Flow 登录） |
| Zide Assist：多轮对话（绑定仓库差异）、快捷工具、BYOK | **P1 ✅ / P2 ✅（v0.4 多轮）** / 会话树 P3 | P1：OpenAI 兼容任意模型（含本地），7 种 AI 动作；P3：多轮会话与智能体 |
| Crosscheck：用第二个模型复审 AI 提交 | P2 | 在"AI 审查"中可选第二模型 |
| CLI Agent 集成、MCP 设置 | P3 | |
| 终端（1 万行回滚）、文件编辑器（CodeMirror、LSP 诊断/悬停/跳转、查找、符号、大纲、十六进制、文档预览）、内置浏览器 | P3 / 不在范围 | GitLoom 定位为 Git 客户端，P1 提供"在 VS Code / 终端中打开" |
| Universal Finder（命令面板 v2：模糊+最近+上下文建议） | **P2 ✅（v0.4）** | P1 有 Ctrl+1..8 视图切换、Ctrl+, 设置、Ctrl+Enter 提交 |
| Minimap（Minimap/Blocks/Hidden） | P2 | Monaco 自带 minimap，可在设置中开启 |
| 账户 / 许可证 / 订阅 / Microsoft Store | 不在范围 | 商业化相关 |

> 结论：Zide 是"开发者全工作流桌面"，Git 只是其中一部分。"支持 Zide 的全部功能"在一个阶段内不现实，以上表格已把**每一项可公开查证的功能**映射到 P1/P2/P3；凡 release notes 中没有出现的能力，本文档不作臆测。

---

## 2. 竞品分析

| 产品 | 技术 | 最值得借鉴的能力 | GitLoom 移植情况 |
|---|---|---|---|
| **GitHub Desktop** | Electron + React | 极简的"变更 → 提交"流程；按行勾选暂存；提交摘要 + 描述；"提交并推送"；发布分支 | **P1 ✅** 变更视图、按行暂存、摘要长度提示、发布分支（push -u） |
| **GitKraken** | Electron | 漂亮的彩色提交图；拖拽合并/变基；工作区（多仓库）；GitKraken AI 提交信息；冲突编辑器 | **P1 ✅** 彩色车道图、多仓库、AI 提交信息、三栏冲突视图；拖拽 P2 |
| **Fork** | 原生 | 上图下详情布局；交互式变基 UI；快速搜索；Git LFS；储藏预览；冲突合并工具 | **P1 ✅** 图谱 + 下方提交详情 + Monaco 差异、储藏预览；交互式变基 P2 |
| **Sourcetree** | 原生 | 侧边栏分支/标签/远程/储藏树；git-flow；自定义动作 | **P1 ✅** 分支/标签/远程/引用日志页；git-flow P2；自定义动作 P3 |
| **SmartGit** | Java | 一体化日志窗口、分布式 reflog、子模块与 SVN 桥 | **P1 ✅** reflog 恢复；子模块 P2 |
| **Tower** | 原生 | **撤销（Cmd+Z）任意操作**、拖拽、快速操作、PR 管理 | P1 通过 reflog"重置到此/恢复为分支"实现撤销；全局 Undo 栈 P2 |
| **lazygit** | TUI(Go) | 按行/块暂存；命令日志可见；自定义快捷键；交互式变基极快 | **P1 ✅** Git 命令日志面板（展示每条 git 命令）、按行暂存 |
| **GitButler** | Tauri + Svelte | 虚拟分支（同一工作区并行多分支）、AI 提交信息、撤销时间线 | 工作树作为"真实"并行分支 **P1 ✅**；虚拟分支 P3（研究） |
| **VS Code Git Graph** | VS Code 扩展 | 经典车道图算法、右键菜单涵盖 checkout/cherry-pick/revert/reset/tag/merge | **P1 ✅** 同类车道算法 + 完整右键菜单 |

---

## 3. 完整功能清单与阶段

图例：✅ P1 已实现并测试；🟡 P1 部分实现；⬜ 计划中（P2/P3）

### 3.1 需求映射

| # | 需求 | 功能点 | 阶段 |
|---|---|---|---|
| 1 | 选择 IDE 项目目录，查看改动 | 选择文件夹 → 自动发现仓库（可配置深度）；变更视图（冲突/未暂存/已暂存）；状态轮询 | ✅ |
| 2 | 多项目/多仓库 | 侧边栏仓库列表（分支、改动数、↑↓计数、工作树标识）；右键：文件管理器/VS Code/终端/抓取/移除；筛选 | ✅ |
| 3 | 完整 Git 生命周期 | 见 3.2 | ✅/⬜ |
| 4 | 工作树 | 列表（主/当前/锁定/失效/改动数）、创建（新分支/已有分支/分离）、打开到工作区、VS Code/终端、锁定/解锁、移除（含删除分支）、prune | ✅；repair / finish 向导 ⬜P2 |
| 5 | Diff + AI 提交信息 | Monaco 并排/统一差异；AI 生成 Conventional/Gitmoji/简洁风格提交信息 | ✅ |
| 6 | 基础 AI 功能 | 提交信息、解释差异（文件/提交）、审查暂存区、PR 描述 + Changelog、冲突解决建议（可一键写回）、分支名建议、自然语言→Git 命令（确认后执行，仅 git、无 shell）；OpenAI 兼容 Base URL + Key + 模型，Key 用 safeStorage 加密，不硬编码 | ✅；多轮对话/Crosscheck ⬜P2 |
| 7 | 可视化分支图 | 车道布局（父提交左对齐、合并汇流、贝塞尔曲线、10 色）、引用徽标、HEAD 高亮、虚拟滚动、当前分支/全部分支、搜索 | ✅；拖拽合并/变基、列宽自定义 ⬜P2 |
| 8 | Git 钩子管理 | 列出标准钩子（尊重 core.hooksPath）、启用/禁用（重命名为 .disabled，跨平台）、Monaco 编辑、新建/删除、模板库 6 个；**llmwiki post-commit 模板**（生成 docs/llmwiki/index.md + changelog.md，可选 AI 摘要；GitLoom 通过环境变量注入 AI 配置，密钥不落盘） | ✅ |
| 9 | 前后对比可视化 | Monaco 并排 + 统一视图、语法高亮（60+ 语言）、折叠未改动区域、分块/按行暂存视图 | ✅ |
| 10 | 其余生命周期 | 见 3.2 | |
| 11 | 竞品能力移植 | 见第 2 节 | |
| 13 | Zide | 见第 1 节 | |
| 14 | 跨平台桌面 | Electron；electron-builder：Win（NSIS x64/arm64 + 便携版）、macOS（dmg/zip x64+arm64）、Linux（AppImage/tar.gz/deb）；GitHub Actions 三平台构建 | ✅ |
| 15 | Logo | SVG 设计 → 16…1024 PNG、ICO、ICNS（脚本生成），用作窗口与安装包图标 | ✅ |

### 3.2 Git 生命周期全景

| 生命周期环节 | 功能 | 阶段 |
|---|---|---|
| 获取仓库 | init、clone（可浅克隆）、添加本地文件夹 | ✅ |
| 工作区 | 状态、暂存/取消（文件/块/行）、丢弃（文件/块/行/全部）、.gitignore（文件/扩展名） | ✅ |
| 提交 | 提交、修改上次提交（amend）、Sign-off、跳过钩子、提交并推送、Ctrl+Enter | ✅ |
| 分支 | 列表（上游/ahead/behind）、新建（任意起点）、切换（远程分支自动建跟踪分支）、重命名、删除（-d/-D）、删除远程分支、推送/发布 | ✅ |
| 集成 | merge（--no-ff/--squash）、rebase、cherry-pick、revert（合并提交自动 -m 1）、reset soft/mixed/hard | ✅ |
| 进行中操作 | 识别 MERGING/REBASING/CHERRY-PICKING/REVERTING/BISECTING；继续/中止横幅 | ✅ |
| 冲突解决 | 三栏视图（ours / 当前文件 / theirs）、采用我方/对方、编辑器中解决、标记已解决、AI 建议并写回 | ✅；行级三方合并编辑器 ⬜P2 |
| 储藏 | push（含未跟踪/keep-index/仅暂存）、apply/pop（尝试恢复 index）、drop、转为分支、差异预览 | ✅ |
| 标签 | 轻量/附注标签创建、删除、推送、检出 | ✅ |
| 远程 | 列表、添加、移除、fetch（--all --prune --tags）、pull（merge/rebase）、push（-u / --force-with-lease / --tags）、自动抓取 | ✅ |
| 历史 | 当前分支/全部分支日志、搜索、提交详情（统计 +/-）、每文件差异 | ✅ |
| 撤销 / 恢复 | reflog 列表、恢复为分支、重置到此 | ✅；全局 Undo 栈 ⬜P2 |
| 工作树 | 见需求 4 | ✅ |
| 钩子 | 见需求 8 | ✅ |
| 配置 | user.name/email（本仓库/全局）、签名状态、LFS/子模块/浅克隆/稀疏检出检测 | ✅；完整配置编辑器 ⬜P2 |
| 可观测性 | Git 命令日志（每条命令、耗时、退出码、错误） | ✅ |
| 交互式变基 / fixup / autosquash | | ⬜P2 |
| 文件历史 / Blame / 按行历史 | | ⬜P2 |
| Bisect 向导 | | ⬜P2 |
| Compare refs / 分支对比 | | ⬜P2 |
| 子模块管理（init/update/deinit/同步） | | ⬜P2 |
| GPG/SSH 签名引导 + 测试签名 | | ⬜P2 |
| Git LFS 管理（track/untrack/lock/pull file） | | ⬜P2 |
| git-flow / 发布流程 | | ⬜P2 |
| 补丁：format-patch / apply / am | | ⬜P2 |
| Git Clean 审阅式清理 | | ⬜P2 |
| 拖拽（分支到分支 = 合并/变基） | | ⬜P2 |
| 命令面板 / 设置搜索 | | ⬜P2 |
| 托管平台（GitHub/GitLab/Bitbucket）：PR/MR、Issue、CI、Release | | ⬜P3 |
| Subtree、稀疏检出、部分克隆 | | ⬜P3 |
| 多轮 AI 会话 / Agent / MCP / QuickTree | | ⬜P3（QuickTree P2） |
| 虚拟分支（GitButler 式） | | ⬜P3 研究 |
| 内置终端 | | ⬜P3 |
| 自动更新（electron-updater）、代码签名与公证 | | ⬜P2 |
| 国际化（en-US） | | ⬜P3 |

---

## 4. 架构

```
┌──────────────── Renderer (React + TS, contextIsolation) ────────────────┐
│ App shell: Sidebar(多仓库) · Topbar(抓取/拉取/推送) · OperationBanner      │
│ Views: Changes · History/Graph · Branches(含标签/远程/reflog) · Worktrees │
│        Stash · Hooks · AI · Settings · Welcome · CommandLog              │
│ lib/graph.ts (车道布局, 纯函数, 单测)  components/DiffPane (Monaco Diff)   │
└───────────────▲─────────────── window.api (preload, contextBridge) ──────┘
                │ ipcRenderer.invoke('git:call', method, args)  白名单方法
┌───────────────┴──────────────── Main (Node) ─────────────────────────────┐
│ index.ts   窗口/图标/IPC/对话框/外部打开/自动截图                           │
│ git/exec.ts   GitRunner：spawn(git, args) 无 shell；GIT_TERMINAL_PROMPT=0、 │
│               GIT_EDITOR=true；命令日志                                     │
│ git/parse.ts  纯解析器：porcelain v2 状态、log、分支、标签、worktree、diff、 │
│               部分补丁构造（按块/按行，正向/反向）                           │
│ git/service.ts GitService：全部 Git 操作（Electron 无关，可单测）            │
│ git/hookTemplates.ts  钩子模板（llmwiki 等）                               │
│ ai.ts      OpenAI 兼容 /chat/completions、/models；提示词库；去 <think>      │
│ store.ts   设置与工作区 JSON（userData）；API Key 用 safeStorage 加密        │
└───────────────────────────────────────────────────────────────────────────┘
                │ child_process
           系统 git CLI（≥2.30，支持 worktree / hooks / LFS / 签名）
```

设计要点

- **只用 git CLI**：保证与命令行、钩子、LFS、过滤器、签名、worktree 行为完全一致（与 Zide "使用 Git 原生路径" 的理念一致）。
- **安全**：渲染进程只能调用白名单方法；参数以数组传给 `spawn`，从不拼接 shell；AI 生成的命令必须用户确认，且只允许 `git` 开头；CSP 禁止远程脚本与 eval；Monaco 完全本地打包（离线可用）。
- **密钥**：AI Key 仅存本机（safeStorage 加密），钩子通过环境变量 `LLMWIKI_API_KEY` 临时获得，不写入仓库或 `.git/config`。
- **性能**：提交列表虚拟滚动；状态轮询仅针对活动仓库；超大文件跳过 diff 渲染；Monaco 只加载 Monarch 语法高亮，不启动语言服务 worker。

## 5. 测试策略

| 层 | 内容 | 结果（P1） |
|---|---|---|
| 单元（vitest） | 解析器、部分补丁构造、车道布局、GitService（在 /tmp 真实仓库上：暂存/按块/按行/丢弃、提交/amend、分支/合并冲突/中止/继续、cherry-pick/revert/reset/标签/reflog、worktree 增删锁、储藏、fetch/pull/push 对裸仓库、钩子与 llmwiki、.gitignore）、AI 客户端（模拟 OpenAI 服务，含 llmwiki 钩子 AI 摘要） | 27/27 通过 |
| 端到端（Playwright + Electron + xvfb） | 启动、多仓库、Monaco 差异、双击暂存、按块暂存、AI 生成提交信息、提交触发 llmwiki、amend、分支图+提交详情、AI 分支名+新建分支、切换分支、创建/移除工作树、安装/禁用钩子、储藏 push/pop、自然语言→Git 并执行、冲突采用 theirs + 继续合并、主题切换 | 19/19 通过 |
| 截图 | `GITLOOM_AUTOSHOT` 自动巡检所有主视图（深色/浅色） | 见 screenshots/ |

## 6. 里程碑

- **P1（本次）**：MVP，上述 ✅ 项；Linux AppImage/tar.gz/deb 本地构建；三平台 CI。
- **P2**：交互式变基、fixup/autosquash、文件历史/Blame、Bisect 向导、Compare refs、子模块/LFS/签名管理、Git Clean、全局撤销、命令面板、拖拽、同步预览、QuickTree、Crosscheck、自动更新与签名。
- **P3**：GitHub/GitLab/Bitbucket 集成（PR/Issue/CI/Release）、多轮 AI 会话与 Agent/MCP、Subtree/稀疏检出/部分克隆、虚拟分支研究、内置终端、英文界面。

## 7. v0.4.2 大项目日常打磨 + AI 服务商体系

**测试项目**：`scripts/make-bigproject-fixture.sh` 仿照真实的 EVER-BUDDY 目录生成 24 个仓库，外加 `.kilo/worktrees/*` 和 `worktree/*` 工作树。仓库状态覆盖领先、落后、分叉、有改动、已暂存、无上游、分离 HEAD 和远程不可达几种情况。

| 走查中遇到的问题 | 改进 |
|---|---|
| 24 个仓库里找“要处理的那几个”要一路往下翻 | 侧边栏加「只看有改动」开关（会记住），底部显示筛选标记；树视图会保留匹配仓库的上级文件夹 |
| 徽标含义只能猜 | 底部加 ⓘ 图例；仓库悬停时显示分支 → 上游、领先 / 落后 / 改动数；新增「无上游」徽标（工作树不显示，避免满屏都是） |
| 早上要一个个仓库点拉取 | 概览加「全部拉取 N 个落后」「推送所有领先的 N」（仅快进、不会产生合并提交），可看进度和逐个仓库的结果 |
| 批量失败只显示 git 原文最后一行 | 成功和失败都用中文写明结果；失败附原因、建议和「去处理」按钮，原始输出放在悬停提示里 |
| 拉取 / 推送失败只弹英文错误 | 识别 10 类常见错误，给出中文标题和建议，并带一键修复按钮（推送并设置上游 / 变基拉取 / 储藏后重试 / 去处理 / 在此建分支 / 重试 等） |
| 差异折叠后想看全文只能一段段点开 | 差异工具栏加「显示全部行 / 折叠未改动」，选择会被记住 |
| 只能用鼠标逐个暂存文件 | `J/K` 在文件间移动，`S` 暂存后自动跳到下一个，`U` 取消暂存；文件列表底部显示快捷键提示 |
| 常写相似的提交信息；切换仓库后草稿丢失 | 「历史」弹层可复用最近 20 条提交信息（支持搜索）；草稿按仓库自动保存 |
| AI 只能填一个 OpenAI 兼容地址 | 改为服务商预设（23 个）、多配置、按任务选模型、备用链、全协议流式输出、测试连接（见 README） |

**性能**（`scripts/perf-big.mjs`，从进程启动起算）：冷启动时仓库树约 1.25 s、全部徽标约 1.83 s；热启动时仓库树约 1.16–1.19 s、全部徽标约 1.67–1.71 s。分析结论：首帧前约 280 ms 花在 Blink 的首次排版（字体回退），属于固有开销；24 个仓库的状态在并发 6 下约 0.5 s 全部就绪。目前没有必要再优化。

**测试**：单元测试 124 个（新增 aiClient 19、gitErrors 15、commitHistory 4、tree 2）；端到端 20 + 15 + 14 + 11（新增 `e2e/e2e-042.mjs`，覆盖 AI 设置流程和模拟服务器）。

## 8. v0.4.3 修复：历史 → AI 解释 连点闪烁

**根因**（`e2e/e2e-043.mjs` 用慢速流式模拟服务器先复现：5 次点击 → 4 个并发请求，结果面板挂载/卸载 3 次，文字回退 13 次）：
1. 按钮没有防重入，每次点击都新开一个流式请求；多个流同时 `setExplain(各自的全文)`，文字在几个流之间来回跳。
2. 结果抽屉在第一个字到达时才挂载，它的遮罩盖住按钮；再点一次落在遮罩上把抽屉关掉，下一个字又把它打开并重放动画 → 持续闪烁。
3. 结果状态放在 HistoryView 里，每个 token 都会重渲整个视图（提交列表、详情、Monaco 差异）。
4. 最先结束的请求就把 loading 置为 false，后结束的结果覆盖先前的。

**修复**：
- `lib/aiRun.ts`（纯类 `AIRun`）：按 key 单飞、AbortController、过期回调序号作废、每帧最多刷新一次、LRU 缓存；`hooks/useAIRun.ts` 用 useSyncExternalStore 只订阅需要的字段。
- 端到端取消：渲染进程 signal → `ai:cancel(reqId)` → 主进程 inflight AbortController → fetch；`AIError.kind = 'cancelled'`，取消时不走备用链。
- 历史页：`CommitExplainButton`（开关 / 生成中… / 停止）+ `CommitExplainPanel`（差异区上方固定高度面板，打开即挂载，骨架屏、来自缓存、重新生成、行内中文错误 + 重试）；缓存键 `repo|sha|preset:id:model`。
- 其他入口：变更页 AI 解释、提交框 AI 生成 / AI 审查、AI 助手对话与工具、测试连接 / 获取模型全部改为同样的单飞 + 可停止；AI 抽屉生成中忽略遮罩点击（Esc / × / 停止关闭）。
- Git：抓取/拉取/推送/变基拉取同组互斥、提交互斥（state.tsx `EXCLUSIVE_GROUP`），顶栏同步按钮忙时禁用，提交 Ctrl+Enter 防重入，全部拉取防重入。

**测试**：单元测试 137 个（新增 aiRun 10、aiClient 取消 3）；端到端 20 + 15 + 14 + 11 + 10（新增 `e2e/e2e-043.mjs`）。截图：`screenshots/v7/`。

## 9. v0.5.0 变更可视化（Change Visualizer）

**目标**：一次改动几十个文件时，先用图看结构变化（改动前 / 改动后），再进入代码。不依赖 AI；AI 只做增强。

**用户故事**：评审 30 个文件的重构 PR → 架构图看分层与跨层依赖、状态图看状态机变化、点节点直达 Monaco 差异；提交前自查影响范围；导出 PNG / Mermaid 写 PR 描述。

**架构**
```
渲染进程 VizView ──viz:analyze(req, reqId)──▶ 主进程 VizService ──▶ git (ls-tree / diff / cat-file --batch)
   │  React Flow 8 视图 + SVG 时序图                │  解析：VizPool（worker_threads ≤4）→ FactParser（web-tree-sitter + 9 个语法 WASM）
   │  ELK 布局在 Web Worker（固定种子、排序输入）     │        按 blob 哈希缓存 FileFacts（≤40000）；worker 不可用时进程内解析
   │  lib/vizGraph：侧面过滤 / 聚焦 N 跳 / 自动聚簇    │  模型：SideModel（符号解析、调用、继承、状态机）× 改动前 / 改动后
   │  导出 PNG / SVG / Mermaid / PlantUML             │  视图：diff.ts（arch / modules / calls / classes / impact）、cfg.ts（控制流）、seq.ts（时序 LCS 合并）、states.ts
   └──viz:ai(id, reqId)──▶ ai.ts：提示词（静态事实 + 精简 diff ≤14000 字）→ chatWithFallback → repairJson → zod 校验（含引用完整性）→ 失败重试 1 次 → convertAI → 缓存（范围 key + 模型）
```
- 取消：渲染进程 AbortSignal → `ai:cancel(reqId)` → 主进程 inflight AbortController（分析与 AI 共用）。
- 打包：`out/main/**` asarUnpack（worker 脚本要能被 worker_threads 读取）；语法 WASM 通过 extraResources 放到 `resources/grammars`。
- 合并图：改动前 = 除新增外全部，改动后 = 除删除外全部；并集只布局一次，所以两边位置完全对齐。

**启发式（自测中修正）**
- 平铺的小项目（Java / Python 单目录）组件少于 3 个时按文件拆组件，用文件名词语（Controller / Service / Repo…）归层。
- 目录归层先看最后一段（`renderer/lib` → 基础层，而不是表现层）。
- 没有任何转换的联合类型 / 枚举只有名字像状态（status / state / phase / stage / step / mode / lifecycle）时才算状态机；转换的事件名取 if 条件里的字符串字面量（`'cancel'`）。
- 影响范围的边保留 `dist(源) ≥ dist(目标)`（原先只保留相邻距离，全部改动时一条边都没有）。
- 布局方向自适应：宽高比超过约 2.9:1 时试另一个方向；孤立节点改为网格排布（60 个无关类原来排成一行 11164×146）；>120 节点时降低 ELK 交叉最小化强度（220 节点 3.7 s → 1.3 s）。

**测试**：单元 201 个（新增 vizParse 14：9 种语言、vizService 16：真实 git 夹具上的范围 / 视图 / 缓存 / 取消 / AI 重试与单飞、vizAi 16：JSON 修复 / schema / 转换、vizGraph 12：聚焦 / 聚簇 / 导出 / 布局确定性、vizModel 6）；
端到端 `e2e/e2e-050.mjs` 36 步（8 视图 × 并排 / 叠加、滑块、同步平移、聚焦、搜索、侧栏 + Monaco、连线提示、4 种导出、控制流、时序、范围 / 分支 / 过滤、取消、缓存、
模拟 AI（schema 重试、分层架构、业务流程、时序、状态、缓存、停止）、无 AI 提示、4 个入口、Python、Java、1500 文件性能、自举 GitLoom、浅色 + 1024 px），截图在 `screenshots/v8/`。

## 10. v0.5.1 代码地图对比（Codemap 式对比）

需求原话：「类似 codemap 对比的一些支持」。

### 10.1 调研（2026-10）
| 工具 | 做什么 | 跟"对比"有关的能力 | 借鉴到 GitLoom |
|---|---|---|---|
| **Windsurf / Devin Desktop Codemaps**（Cognition，2025-11 发布，[博客](https://cognition.com/blog/codemaps)、[文档](https://docs.devin.ai/desktop/codemaps)） | 针对一个问题（"认证怎么走的"）由 AI 生成分组、嵌套的代码路径图；文本视图 + 可视化视图；每个节点链接到精确的文件 / 行；"See more" 展开 trace guide 解释为什么这几行是一组 | 本身是快照，不做前后对比；文档提醒"生成的快照可能过时、可能漏路径，需要回到源码确认" | **改动导览**：带编号的路径步骤（1、1a、1b…），分组 + 每组一句导读，每步直达代码；AI 版可输入问题；只允许引用我们给出的候选位置（静态分析得出），避免编造行号；同样给出改动前 / 改动后两条路径 |
| **codemap CLI**（[JordanCoin/codemap](https://github.com/JordanCoin/codemap)，Go） | 项目树（文件数、大小、扩展名）；`--deps` 依赖流 + HUBS（被引用最多的文件）；`--importers` 谁依赖这个文件（≥ 阈值报 HUB FILE 警告）；`blast-radius` 评审包（diff + 依赖 + 引用方，Markdown / JSON） | `--diff [--ref 分支]`：只显示相对某分支改动的文件树，带 `(new)`、`+45 −12`，并提示"handlers.go 被 3 个文件使用"；每个依赖结论带覆盖度 complete / partial / unavailable | **代码地图**视图：树状清单 / 方块图（treemap），大小前→后、行 +/−、被引用数前→后、影响面（传递依赖方数）、热点文件标记；"改动了热点文件"风险提示；覆盖度说明；导出 Markdown 评审包 / JSON |
| **CodeSee Review Maps**（[文档](https://docs.codesee.io/docs/review-map-guide)，已停止服务） | 每个 PR 自动生成文件依赖图：绿 = 新增、红 = 删除、橙 = 修改、白 = 未改但依赖改动文件（可能受影响）；Tours 引导评审；逐文件"已审阅"勾选 + 进度条 | 正是 PR 前后对比 | 地图里"受影响但未改动"文件单独着色；导览每步可勾"已看过"，显示进度 |
| **Sourcetrail**（社区 fork，C/C++/Java） | 离线符号级浏览：符号的调用方 / 被调用方图 + 代码 | 无 | 已有：调用图 + 节点面板 |
| **Gource** | 版本历史动画 | 无结构对比 | 不做 |

### 10.2 方案（0.5.1）
1. **代码地图**（新视图，排第一位之后）：主进程在 analyze 时顺带算 `CodeMap`（`git ls-tree -r -l` 拿两侧字节数，SideModel 拿行数与 import 图）——每个文件：状态、大小前/后、行数前/后、+/−、直接引用方前/后（新增 / 失去的引用方）、影响面 = 传递引用方数、是否热点（引用数 ≥ max(5, 前 3%)）。
   - 两种画法：**树状清单**（像 `codemap --diff`，目录可折叠，列：大小、行变化、被引用、影响面）和**方块图**（squarified treemap，面积 = 大小，按目录嵌套）。
   - 着色：按改动 / 按热度（被引用数）/ 按大小变化；默认"只看改动 + 受影响"，可切到全部文件。
   - 顶部风险条："改动了 N 个热点文件"，点击定位；覆盖度：完整 / 部分（大仓库截断）/ 无源码。
   - 点文件 → 现有侧栏（补丁 + 打开差异）。导出：Markdown 评审包、JSON（`gitloom.codemap/v1`）、PNG。
2. **改动导览**（新视图）：静态版按"调用方在前、被调用方在后"的拓扑序排改动文件，按层分组，每个文件下列改动函数（1、1a、1b…），每步写明为什么重要（新增 / 被 N 个文件引用 / 调用了第几步）。AI 版：输入问题（默认"这次改动的主要执行路径"），模型只能从候选位置 id 里挑步骤并写标题 / 说明 / 每组导读（zod 校验 + 引用完整性 + 一次重试 + 按 key|问题|模型 缓存）。
   - 左侧编号清单（可勾"已看过"，进度条），右侧用现有 GraphDiff 画路径图（并排 / 叠加 / 滑块照常可用）；点步骤 → 侧栏代码。导出 Markdown。
3. **对比任意版本更顺手**：范围 / 分支输入框的候选加入标签；⇄ 交换两侧；"快捷对比"菜单（上一个提交、最近标签→HEAD、当前分支 ↔ main、未推送的提交）。
4. **热点标记**也出现在模块依赖 / 影响范围图的节点上（🔥 被 N 个文件引用）。
5. 不删除任何现有功能；新增单元测试（codemap 计算、treemap 布局、导览排序、AI 导览 schema）+ e2e（e2e-051）+ 全量回归；截图 `screenshots/v9/`。

### 10.3 结果（0.5.1）
- 单元测试 223 个（18 个文件，新增 `tests/codemap.test.ts` 22 个）；typecheck 通过。
- e2e-051 16/16（快捷对比、代码地图树 / 方块图前后切换 / 着色 / 导出、热点标记、阅读路线 + 进度保存、AI 路径重试 + 缓存、无 AI、标签 + 交换、1500 文件仓库：树 0.87 s、方块图 0.24 s、浅色 + 1024 px）。
- 全量回归：e2e-050 36/36、e2e-regress-050 14/14、e2e 20/20、e2e-multi 15/15、e2e-advanced 14/14、e2e-042 11/11、e2e-043 10/10。
- 修复：小仓库热点阈值退化为最大值；squarify 等值时不确定；同一秒创建的标签排序错误（改用不依赖 ICU 的自然排序）；导览图把函数画成独立节点导致缩到 14% 不可读（改为文件节点内列函数 + 阅读顺序连线）；节点徽标挤掉标题；方块图模式工具栏换行（图例移到概要行）。
- 截图：`screenshots/v9/70–86`。

## 11. v0.5.2 可视化深度优化

需求原话：「可视化的深度优化一版本然后放到我电脑上」。审计先行，再按发现落地；不删功能。

### 11.1 审计发现（0.5.1 → 审计基线，dog / ts / shop / java / big × 1024/1440/1920 × 深浅色）

1. **初始缩放过小**：大图 fit-all 常落到 12%，节点不可读。
2. **连线穿方块**：INCLUDE_CHILDREN 稀疏排版时边直穿节点（dog modules through=81）。
3. **交叉过多**：正交采样交叉数千（dog modules 1668）。
4. **未改上下文挤满视野**：changeCluster 缺省未开，双击才能折叠。
5. **长条状布局**：组件未按窗格纵横比货架打包。
6. **小窗小地图挡内容**：窄 pane 仍常显 minimap。
7. **标签冗余/截断**：`orders.ts · orders.ts`、字宽不够被截。
8. **无改动导航 / 键盘 / 路径 / 同步悬停**。
9. **导出只截当前视口**，非整图。
10. **1024 范围条换行**（容器查询阈值过宽）；导出钮曾挤出工具栏。
11. **图例「修改」被全局 `.md` 样式放大**。
12. **叠加模式无前后过渡播放**。
13. **无「这张图在说什么」白话摘要**。
14. **空状态尚可**（state / flow 空图可接受）。
15. **架构分层图**带状布局、边无路由（through 不变）——本版未改，记为后续。
16. **性能可接受**（1500 文件交互仍流畅）。
17. **滑块「改动前/对半/改动后」被底部摘要条挡住**（e2e 暴露）。

### 11.2 方案与落地

| 项 | 做法 |
|---|---|
| 布局 | 两阶段 compound 捆束正交路由（组内 fan + 组间 trunk）；≤40 叶组件 hybrid：INCLUDE_CHILDREN vs bundled 按 scorer 取优；连通分量按窗格纵横比货架打包；组宽/节点宽按标签实测加宽 |
| 聚类 | `changeCluster` 默认折叠未改上下文，单击展开、收起还原 |
| 视口 | 可读阈值 READABLE=0.5；低于则框住改动最密窗口（zoom≈0.72）；语义缩放 z-far/z-mid |
| 导航 | 底部摘要条 + 上/下一处改动；键盘 N/]/F/C/Enter/`/`；Shift+点两节点最短路径高亮；同步悬停；叠加播放 |
| 标签 | `tidyLabels`；图例 `.md` 重置；远景组标签带底 |
| 导出 | 整图 PNG/SVG + 当前画面 PNG |
| AI | 「解读本图」：grounded prompt、流式、`「名」` 可点跳转 |
| 1024 | 容器查询收紧 + 紧凑 scope；滑块 flip 移到顶部防挡 |
| 边样式 | 未改边实线低对比，避免捆束叠成白杠 |

### 11.3 结果（关键指标 old→new）

| 视图 | zoom | crossings | through | trunc |
|---|---|---|---|---|
| dog modules 1440 | 12→80 | 1668→208 | 81→5 | 4→0 |
| dog impact | 17→72 | 582→72 | 74→0 | 10→1 |
| dog calls | 12→72 | 169→60 | 36→0 | 25→0 |
| big modules | 12→74 | 1108→402 | 91→75 | 42→1 |
| big impact | 12→74 | 126→4 | 22→0 | 60→1 |
| ts calls 1024 | 19→91 | — | 8→0 | 9→0 |
| shop impact | 40→57 | 30→8 | 8→0 | 10→0 |
| 1024 scopeWrapped | True→False | | | |

说明：小图采样 crossings 偶升（捆束汇合点被 20px 格计入）；正交段计数仍 bundled ≤ include。arch 未改。

### 11.4 测试

- 单元：240 / 19 文件（新增 `tests/viz052.test.ts` 17）
- e2e-052：16/16；e2e-051：16/16；e2e-050：36/36
- 回归：e2e-regress-050 14、e2e-advanced 14、e2e 20、e2e-multi 15、e2e-042 11、e2e-043 10
- 截图：`screenshots/v10/`（含 cmp-01…06 新旧对照）

### 11.5 未做 / 已知

- arch 带状图边仍不路由（through 不变）
- 影响面偶有长顶绕线（分区边，非回边）
- 小图采样 crossings 略升（度量噪声）

## 12. v0.5.3 — 软件工程记号对齐（C4 / UML / IEEE）

用户诉求：「可视化的效果按软件工程的体系在标准还一点」。在不删功能的前提下，把各图对齐业界常见记号，并在图例旁用中文说明。

### 12.1 具体标准决策

| 视图 | 采用体系 | 记号要点 |
|---|---|---|
| 架构 | **C4** 容器/组件暗示 | 层 = «容器» 虚线边界；组件 = «组件»；文件/函数带角色徽标 |
| 类图 | **UML 2 类图** | 三隔间（名称 / 属性 / 操作）；可见性 `+ - # ~`；继承=实线空心△；实现=虚线空心△；依赖/导入/使用=虚线开放箭头 |
| 时序 | **UML 时序图** | 生命线；激活条（执行规格）；同步实心箭头；异步/返回/创建=开放箭头（返回/创建虚线） |
| 状态 | **UML 状态机** | ● 初态；◎ 终态（名称启发式或无出边）；迁移标签 `事件[守卫]/动作`（若源已编码） |
| 流程 | **活动图 / 结构化流程图** | 起止圆角；菱形判定；矩形活动；中文 tooltips |
| 调用/模块/影响 | **IEEE 变更着色 + 维护分析** | 增绿/删红/改黄/移蓝 与图例一致；«模块»«函数»«影响面» 等角色徽标 |

### 12.2 实现落点

- `vizSe.ts`：可见性、stereotype、边说明、页签记号文案
- `VizNodes`：类隔间、终态牛眼、角色徽标、C4 组标签
- `GraphDiff`：UML 箭头 defs（空心三角 / 开放箭头）+ 悬停记号说明
- `SequenceView`：激活条 + 异步/返回/创建箭头
- `diff.ts` / `ai.ts`：终态启发式
- `viz.css`：隔间、终态、C4 虚线层、依赖虚线边、激活条
- `VizView` 图例：`data-testid="viz-notation"` 中文提示

### 12.3 非目标

- 不引入完整 SysML / 不强制用户切换「严格 UML」模式
- 不删除 0.5.2 布局/导航能力；泳道仅在有明确多模块父节点时保留既有分组，不强行重排 CFG

## 13. 0.6.0 — 六大模块导航（2026-10-24）
- 顶层新增模块栏：日常 Git / 工作区 / 看懂改动 / 架构与知识 / 质量把关 / 自动化；右侧范围切换：当前仓库 / 整个项目 / 仓库组（按项目子文件夹）。
- 原有 变更/历史/分支/更多 与 概览/跨仓库变更 标签保持不变（快捷键 Ctrl+0..3、Ctrl+K/P 不变）。
- 新增三个模块主页：架构与知识（架构图、代码地图、阅读路线入口；Wiki 规划中）、质量把关（AI 审查、比较分支、影响范围入口 + 外部工具检测与安装引导，不打包）、自动化（内嵌 Git 钩子与模板库 + 运行记录）。
- DG-2：设置 → Git 钩子 保留，并显示“已移动到自动化”提示；命令面板新增「模块：…」条目。
- 需求决策见 docs/GitLoom-需求收敛-v1.1.md §8。测试：e2e/e2e-060.mjs（12 步）。

## 14. 0.6.1 — 看懂改动 / 当前架构 C4 / 体检 / AI 定时任务（2026-10-24）

- **看懂改动**（模块首页）：全局摘要卡（统计、影响模块、风险提示、可选 AI 解释）→ 影响模块 → 逐文件；每条结论都链接到代码位置。原有可视化、对比、代码地图、阅读路线作为「深入」入口保留。
- **当前架构**（架构与知识）：C4 三层（系统 / 容器 / 组件），每项带证据（源文件位置）与置信度。
- **工作区体检列**：Dashboard 新增「体检」列（分数 + 问题提示）。
- **AI 定时任务**（自动化）：任务 = 名称 + 提示词 + 范围（仓库 / 项目 / 分组）+ 频率（每天 / 工作日 / 每周 + 时间，或仅手动）。
  - 仅在 GitLoom 打开时于本机运行（当前无托盘）；错过的显示「已错过，立即运行」，不自动补跑。结果保存在应用内（最近 30 次，Markdown），可选桌面通知。
  - 默认只读：git 只读子命令白名单（log/branch/diff/show/status/grep…，拦截 -d/-D/--delete/--output 等）、仓库内读文件、npm audit；写入命令须逐任务显式开启。
  - 内置模板（可编辑、可复制）：线上问题日志日报（通用 HTTP/JSON 接口 + 令牌 safeStorage 加密、不落日志；未接入则不运行；全量翻页）、主动安全扫描（先确定性静态规则，AI 只判断可利用性；无文件+行号不报；与上次对比标「本周新增」）、陈旧本地分支清理建议（事实由 git 确定性计算；仅「已合并且无未推送提交」建议删除；绝不执行删除）。

## 15. 0.6.2 — 新功能体验打磨（2026-10-24）
路线调整：原 0.6.2「项目 Wiki」顺延到 **0.6.3**，「体检报告/质量报告」顺延到 0.6.4。
- 修复：0.6.1 摘要表格里的「热点」徽标误用 `.hub` 类名，导致所有模块首页整页染红（亮色下最明显）→ 改为 `.us-hot`。
- 修复：任务面板按钮用了不存在的 `btn primary / btn ghost` 类，主次按钮无区分 → 统一为 `btn-primary / btn-ghost`。
- AI 定时任务：任务卡片（图标、频率/下次/范围徽标、最近结果状态+标题）、可键盘操作；新建菜单分组带图标；空状态模板卡。
- 编辑器：三段式（做什么 / 在哪里什么时候 / 通知与权限），24 小时制时间、周一起始的星期选择、实时「下次运行：…」、模板预览、恢复模板原文、保存前校验提示、Esc 关闭。
- 运行结果：头部指标（按结果着色）、元信息（时间/用时/触发方式）、按 ### 分组可折叠、全部收起/展开、复制报告；Markdown 支持一层嵌套列表。
- 看懂改动：风险等级/置信度图例、「深入查看」分组、统一空/加载/错误状态（各一个主操作）、数字列对齐。
- 当前架构：C4 层级面包屑（带计数）、图例、点容器跳到对应组件组、表格列宽固定不再竖排换行。
- 模块栏/范围切换在 1024 宽下不再裁切；模板提示词按「排查/扫描/盘点内容 · 要求 · 输出格式」重写。

## 15.1 0.6.2-hotfix.1 — 模块页 class 加固（2026-10-24）

用户反馈亮色下「架构与知识」仍整页偏粉/红。根因是 0.6.1 热点徽标 `.hub` 与模块页容器 `className="hub"` 撞名；0.6.2 已把徽标改为 `.us-hot`。本补丁进一步把模块页根类与相关样式从 `hub`/`hub-*` 全面改为 `mod-hub`/`mod-hub-*`，并为 `.mod-hub` 设置 `background: var(--bg)`，避免再被任何同名规则染色。代码地图 `file.hub`、`.cm-cell.hub`、`.us-hot` 不动。版本号用合法 semver `0.6.2-hotfix.1`（electron-builder 拒绝四段 `0.6.2.1`）。

## 15.2 0.6.3 — 菜单归属重整 + 项目 Wiki MVP（2026-10-25）

目标：模块主页是**终点**而不再是中转站；补齐项目 Wiki MVP；质量把关本页完成审查/比较/钩子。

### 菜单归属
- **架构与知识**：主区直接内嵌 C4（`ArchitectureView`）；「当前架构图」走独立 view `architecture-graph`（复用 VizView，但挂在 knowledge 的 `views` 下，顶栏不跳到「看懂改动」）。删除代码地图/阅读路线作为主卡片（降为「相关：在看懂改动中打开」）。旧版 llmwiki 钩子改为次要链接到自动化。
- **质量把关**：本页内嵌 AI 审查（暂存区优先，否则工作区）、比较分支结果列表、常用 pre-commit/pre-push 一键安装；影响范围降为相关链接；质量报告「基础版」汇总卡（工具检测 + 冲突/暂存数字）。外部工具检测表保留。
- **看懂改动**：仍承担改动摘要 + 深入（前后对比图、影响范围、变更向代码地图/阅读路线）。
- **nav.ts**：`architecture-graph` ∈ knowledge；MOVED 提示补充新归属；快捷键与「更多 → 变更可视化」保留。

### 项目 Wiki MVP
- 存储：`<userData>/projects/<projectId>/wiki/`（projectId = 项目根路径 sha1 前 16 位）；含 SCHEMA.md / index.md / log.md / pages/ / wiki-settings.json（`enabledAuto:false`）。
- IPC：`wiki:status|ensure|list|read|ingest|migrate|saveSettings`。
- UI：架构与知识页「项目 Wiki」区：建库、列页、预览 Markdown、手动吸收最近提交（规则化摘要 + 可选 AI）、从 `docs/llmwiki` 迁移复制（不删原文件）。无项目时显示空状态。

### 其它
- `reviewStaged`：暂存区为空时回退到工作区 diff。
- 版本号 → `0.6.3`。测试：modules 归属、wiki 路径/建库/吸收/迁移；e2e-060/061 选择器跟随新主页。

## 15.3 0.6.3-hotfix.1 — 关窗崩溃修复（2026-10-25）

关窗/退出时偶发 `Object has been destroyed` 崩溃。根因是窗口已销毁后仍向 `webContents` 发 IPC（GitRunner 日志、ProjectManager、定时任务 emit、最大化状态）。本补丁：
- 新增 `sendToWin`：`win` 为空或 `isDestroyed` / `webContents.isDestroyed` 时直接跳过。
- GitRunner.onLog、ProjectManager 推送、`sendMax`、tasks.emit 均走安全发送。
- `closed` / `before-quit` 置 `win = null`；`uncaughtException` 吞掉 quit 阶段的 Object has been destroyed。
- 版本号 → `0.6.3-hotfix.1`。Electron 主进程难单测，未加 vitest；既有 typecheck / 单元测试保持绿。



## 15.4 0.6.4 — 质量把关 → 体检报告（2026-10-26）

目标：统一**体检报告**替换质量页「基础版」汇总卡；发现项可筛选、改状态、导出；密钥/静态/卫生/工具 + 可选 AI/ocr/Wiki Lint。

### 数据模型（shared）
- `Finding`：severity / category / evidence / status / source / confidence 等。
- `HealthReport`：scope、checksRun、findings、summary、durationMs、notes。

### 主进程 `src/main/health/`
- 可取消（AbortSignal）一键体检；检查项可开关；短缓存 + `<userData>/health-reports/<repoId>/` 历史。
- 内置：静态启发式、密钥泄露扫描、工作区卫生、工具状态 info、Wiki 孤儿/空 index lint。
- AI 审查 / ocr：无配置或未安装则跳过并写入 notes。
- IPC：`health:run|list|get|latest|export|setFindingStatus|cancel|mergeReview`；`wiki:query` 问百科。

### UI
- 质量页：一键体检 + 范围/检查项 + 严重级别芯片 + 发现列表（筛选/折叠/状态/导出）。
- 保留本页 AI 审查、比较分支、钩子、工具检测；审查结果可「并入体检」。
- Dashboard「体检」列：状态分 + 最近报告最高严重级别色点，点击进入质量页。
- Wiki：轻量「问百科」（有 AI 则结合相关页作答，否则全文搜索）。

### 其它
- 关窗 `sendToWin` 安全发送保留。
- 版本号 → `0.6.4`。测试：Finding schema、密钥/静态规则、报告汇总；e2e testid：`health-run` / `health-findings` / 导出按钮。

## 15.5 0.6.5 — 边界 IA + tree-sitter 静态 + Wiki 补实 + 真实图谱（2026-10-26）

目标：看懂改动 ↔ 架构与知识 **硬边界**；体检补 tree-sitter 结构化静态；Wiki 可写可管；知识图谱 MVP（本地 JSON，非 planned）。

### 产品边界（硬规则）
- **看懂改动**：只服务某次改动（工作区/暂存/提交/分支对比）——摘要、代码地图、阅读路线、改动向可视化。禁止主路径跳进「架构与知识」。
- **架构与知识**：只服务当前现状（默认 HEAD）——页内 C4、HEAD 模块架构图（`ArchGraphEmbed`）、项目 Wiki、llmwiki 管理、真实知识图谱。禁止 `setView('viz'|'summary'|…)` 完成主功能；页脚可文字说明改动对比在侧栏，无 onClick。
- **质量把关**：「在看懂改动中打开可视化对比」仅 secondary 小链接，比较结果留在质量页。

### tree-sitter 静态 Finding（`src/main/health/staticAst.ts`）
- 圈复杂度（flow）、死导出、删除仍引用、简易克隆、blast 影响面；与既有正则启发式并存；解析失败则跳过该项不中断体检。

### 项目 Wiki 补实
- `wiki:write` / `wiki:reveal`；新建/编辑/保存、问百科「存为新页」、`enabledAuto` + `dailyTokenCap`、打开文件夹、预览↔编辑。
- llmwiki 安装引导内嵌知识页（不跳自动化完成主路径）。

### 知识图谱 MVP（`src/main/graph/`）
- 纯 TS 邻接表 → `userData/projects/<id>/graph.json`（无 better-sqlite3）。
- 节点：File / Module / Symbol / Wiki；边：CONTAINS / IMPORTS / CALLS / DEFINES / MENTIONS + confidence。
- FactParser 构建；IPC：`graph:status|build|search|neighbors|blastRadius|getNode` + progress。
- UI：`KnowledgeGraphPanel` 内嵌知识页；原「planned:0.7」入口删除。

### IA
- `KnowledgeView` 卡片仅 `scrollIntoView`；`ArchGraphEmbed` 独立组件，不复用会改全局 view 的 `architecture-graph` 路由。
- nav tip 写清边界；命令面板「当前架构」→ `knowledge`。

### 其它
- 版本号 → `0.6.5`。测试：`health065` / `graph065` / wiki write；typecheck + vitest 全绿。

## 15.6 0.6.5-hotfix.1 — 关窗加固 + exe 图标 + 日常 Git 平铺入口（2026-10-26）

0.6.3-hotfix.1 已有 `sendToWin` + `uncaughtException` 过滤，但关窗时未完成的 git `ChildProcess` close 仍会进 `GitRunner.onLog`，Electron 仍弹主进程错误框。本补丁：
- `GitRunner` close：`onLog` 经 `safeInvoke` try/catch；`onLog` 已清空则跳过。
- 尽早注册 `uncaughtException` / `unhandledRejection`，吞掉 `Object has been destroyed|Render frame was disposed|WebFrameMain`。
- `close` / `before-quit`：先 `runner.onLog = undefined` 再 `win = null` / stop tasks / `projects.dispose()`；macOS 重开窗时 `attachWindowIpc` 恢复回调。
- `sendToWin`：先 `win.isDestroyed()`，再取 `webContents`。
- 单测：`quitGuard`（`isQuitDestroyedError` / `safeInvoke`）。版本 → `0.6.5-hotfix.1`。
- 图标：`signAndEditExecutable: false` 导致 Linux 打包时 rcedit 跳过、exe 无 ICON；`afterPack`（`scripts/after-pack-win-icon.mjs`）用 wine+rcedit 写入 `build/icon.ico`；`extraResources` 增加 `icon.ico`；`BrowserWindow.icon` 在 win 优先 .ico。
- **日常 Git IA**：去掉「更多 ▾」；ADVANCED（整理提交/二分/追溯/子模块/PR/AI）与储藏/工作树平铺为顶栏入口；**变更可视化从日常彻底移除**，只属于「看懂改动」；模块间无交叉跳转；命令面板日常项不含 viz。
- **外部工具检测 / 一键安装**：`tools/detect.ts` 增强 PATH（`%APPDATA%\npm`、npm prefix、Node 目录），Windows 试 `ocr.cmd`/`ocr.exe`；`runOcr` 用解析路径；安装文案改为 `npm install -g @alibaba-group/open-code-review`；质量页「一键安装」→ `app:installTool`（ocr/semgrep/osv-scanner）；推荐说明：ocr 体验、semgrep 安全、osv-scanner/npm audit 依赖漏洞、密钥扫描内置不必装 gitleaks。


