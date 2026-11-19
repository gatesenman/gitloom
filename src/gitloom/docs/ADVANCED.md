# GitLoom v0.4 · 高级 Git 生命周期 / AI / Forge

> v0.4.1 起：整理提交（变基）、二分查错、文件追溯（原「工具」）、子模块（仅当仓库有子模块时）、PR 与 Issue、AI 助手 位于仓库视图顶部的「更多 ▾」下拉；Git 钩子位于「设置 → Git 钩子 · 当前仓库」。全部可在命令面板（Ctrl/⌘+K）中搜索。

## Round 1 — 高级生命周期
- 交互式变基：`GIT_SEQUENCE_EDITOR` 注入计划；UI 支持拖拽与动作修改；进行中可读/写 `git-rebase-todo`。
- 二分：状态来自 `BISECT_LOG` / `refs/bisect/*`；UI 展示剩余提交估计。
- Blame / 文件历史：`git blame --line-porcelain`、`git log --follow`。
- Pickaxe：`git log -S` / `-G`；比较引用：`rev-list --left-right` + `diff --numstat`。
- Clean：先 `-n` 预览，排除含 `.git` 的嵌套仓库后再 `-f`。
- 配置：`--local/--global/--system --list --show-origin`；签名状态与一键配置。
- LFS：`git lfs version/ls-files/pull/push/track`。
- 子模块：解析 `.gitmodules` + `submodule status`，支持 init/update(--recursive)/sync/deinit。

## Round 2 — AI + Forge + 打磨
- 命令面板：最近命令持久化到 localStorage；根据冲突 / 变基 / 二分 / ahead/behind / 改动给出「建议」。
- AI 多轮：`ai:chat` 在 system 消息中注入分支与差异摘要。
- Forge：解析 origin URL；GitHub REST / GitLab API v4；Token 经 safeStorage 加密。
- 父仓库 `summary.changes` 排除自身为 git 仓库的未跟踪路径；监视目录上限 5000。
