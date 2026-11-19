# GitLoom 设计系统（v0.2 视觉打磨）

目标：对标 Linear / Raycast / Fork / GitKraken / Tower / VS Code 的现代桌面开发工具质感；只改外观与交互细节，不新增 Git 功能。

## 设计令牌（`src/renderer/src/styles.css` `:root`）
| 类别 | 令牌 | 说明 |
|---|---|---|
| 间距 | `--s-1…--s-10` | 4px 网格（4/8/12/16/20/24/32/40） |
| 圆角 | `--r-xs…--r-xl`, `--r-full` | 4/6/8/12/16 |
| 字号 | `--fs-2xs…--fs-2xl` | 10.5 / 11.5 / 12.5 / 13 / 15 / 18 / 24 |
| 阴影 | `--shadow-sm/md/lg` | 深色主题叠加 1px 内描边，避免"糊" |
| 动效 | `--t-fast 120ms`, `--t 160ms`, `--t-slow 200ms`, `--ease` | `prefers-reduced-motion` 时全部降为 1ms |
| 字体 | `--font-ui`（Inter Variable）, `--font-mono`（JetBrains Mono） | 本地打包（@fontsource），无 CDN；CJK 回退 PingFang SC → 微软雅黑 → Noto Sans CJK SC |

## 颜色
- **表面分层**（深色）：canvas `#111216` → sidebar `#15161b` → panel `#18191f` → raised `#1e2027` → popover `#252731`。不用纯黑；浅色主题同理（`#f4f4f7` → `#fbfbfc` → `#ffffff`）。
- **唯一强调色**取自 Logo 渐变中段的靛紫：深色 `#7b74ff`、浅色 `#5b52e8`；作文字时用 `--accent-text`（深色 6.3:1、浅色 7:1）。Logo 青色 `#2ec4c9` 仅用于远程分支 / theirs。
- **Git 语义色**全局一致（文件状态徽标 · Hunk 面板 · Monaco 差异 · 冲突视图 · 状态栏）：新增 `--add`、删除 `--del`、修改 `--mod`、重命名 `--ren`、冲突 `--conf`（品红，与"删除"区分）、未跟踪（新增色描边）。
- **对比度**：正文 / 次要 / 弱化文字在面板上分别约 15:1 / 6.6:1 / 4.5:1，满足 WCAG AA。

## 组件
按钮（default / primary / danger / ghost-danger / ai，三档尺寸）、输入框、分段控件、下划线标签页、样式化 Tooltip（自动接管所有 `title` 属性）、上下文菜单、对话框、Toast、带插画的空状态、骨架屏、键位提示 `kbd`、命令面板（`Ctrl/⌘+K`）。

## 外壳
- 自定义标题栏：macOS 使用 `hiddenInset` 并为红绿灯留出空间；Windows / Linux 无边框 + 自绘最小化/最大化/关闭；标题栏可拖动、双击最大化。
- 侧边栏可折叠（`Ctrl/⌘+B`，记忆状态）：仓库显示彩色字母头像、工作树角标、改动圆点。
- 最小窗口 1024×680；≤1180px 时侧边栏收窄、按钮只显示图标、提交列表隐藏作者名/日期。

## 分支图
新车道配色（首色为品牌色）、平滑 S 形贝塞尔曲线、悬停时高亮整条车道并淡化其他车道、节点内显示作者首字母、合并提交为空心节点、HEAD 外环、引用徽标改为胶囊样式（HEAD 实心、本地 / 远程 / 标签分色）。

## 差异
Monaco 主题与应用令牌一一对应（背景、行号、选区、滚动条、插入/删除行与词级高亮、折叠区域），禁用连字，行高 20px。
