# GitLoom 织线

**0.6.14** · 跨平台多仓库 Git 桌面客户端（Electron + React + TypeScript），内置 AI 助手。

## 功能特性

- 同时管理多个本地 Git 仓库：状态、提交、分支、差异与常用工作流。
- 内置 AI 助手，可协助解释变更、撰写说明等（需自行配置模型）。
- 使用 Electron + React + TypeScript，可通过 electron-vite 开发与打包。

## 技术栈

- Electron + Vite + React + TypeScript
- Git

## 从源码运行

源码在仓库根目录。本仓库不包含安装包。

```bash
npm install
npm run dev
npm test
npm run build
```
完整功能与开发说明见该目录 README。

## 文档

- [`）、`F`、`C`、`Enter`、`/` | 变更可视化（先点一下图）：下 / 上一处改动、看全图、对准改动、打开详情、搜索；`Shift + 点击` 两个方块看路径 |
| `Ctrl/⌘ + Enter` | 提交（在提交信息框里）；AI 助手里发送消息 |
| `Esc` | 关闭弹层 / 对话框 |
---
## 性能（24 个仓库 + 6 个工作树的 EVER-BUDDY 测试项目，Linux，开启文件监视）
| 阶段（从进程启动起算） | 冷启动 | 热启动 |
|---|---|---|
| Electron 就绪 | ~300 ms | ~250–290 ms |
| 窗口显示 | ~750 ms | ~670–720 ms |
| 工作区载入 | ~770 ms | ~690–740 ms |
| 仓库树显示 | ~1.3 s | ~1.1–1.16 s |
| 全部仓库徽标就绪 | ~1.8 s | ~1.6–1.7 s |
复现：`bash scripts/make-bigproject-fixture.sh /tmp/gitloom-big && npm run build && node scripts/perf-big.mjs 3`
---
## 开发
```bash
npm install
npm run dev          # 开发模式
npm test             # 单元测试（vitest，会在 /tmp 创建临时仓库）
npm run typecheck
npm run build        # 类型检查 + 打包到 out/
xvfb-run -a node e2e/e2e.mjs            # 端到端：基础流程
xvfb-run -a node e2e/e2e-multi.mjs      # 端到端：多仓库项目
xvfb-run -a node e2e/e2e-advanced.mjs   # 端到端：导航与高级视图
xvfb-run -a node e2e/e2e-042.mjs        # 端到端：0.4.2（AI 服务商设置 + 模拟服务器、一键同步、快捷键等）
xvfb-run -a node e2e/e2e-043.mjs        # 端到端：0.4.3（AI 连点 / 停止 / 切换取消 / 缓存，慢速流式模拟服务器）
xvfb-run -a node e2e/e2e-050.mjs        # 端到端：0.5.0 变更可视化（SHOTS_DIR=screenshots/v8 刷新截图）
xvfb-run -a node e2e/e2e-051.mjs        # 端到端：0.5.1 代码地图 / 改动导览 / 快捷对比（SHOTS_DIR=screenshots/v9 刷新截图）
xvfb-run -a node e2e/e2e-regress-050.mjs # 端到端：全功能回归
node scripts/viz-fixtures.mjs /tmp/viz  # 生成可视化测试用的示例仓库（TS 服务 / Python / Java / 带热点文件与标签的 web-shop / 1500 文件大仓库）
xvfb-run -a node scripts/shots-v6.mjs   # 生成 screenshots/v6
npm run icons        # 由 build/logo.svg 生成 PNG / ICO / ICNS
```
## 打包
```bash
npm run dist:win     # NSIS 安装包 + 便携版 + zip
npm run dist:mac     # dmg + zip
npm run dist:linux   # AppImage + tar.gz + deb
```
## llmwiki 钩子
设置 → Git 钩子 → 模板 → 「llmwiki：自动维护 LLM 项目百科」→ 安装。之后每次提交都会生成：
- `docs/llmwiki/index.md`：README 摘要、基本信息、目录结构、文件类型统计、热点文件、最近提交
- `docs/llmwiki/changelog.md`：每次提交记一条（最新的在前）；配置了 AI 时追加「AI 摘要」
通过 GitLoom 提交时，当前默认 AI 配置会以环境变量（`LLMWIKI_BASE_URL` / `LLMWIKI_MODEL` / `LLMWIKI_API_KEY`）传给钩子。在命令行提交时，可以自己设置这些环境变量，或使用 `git config llmwiki.baseUrl/model`。`LLMWIKI_SKIP=1` 可跳过一次。
规划与调研见 [docs/PLAN.md](docs/PLAN.md)
- [docs/MULTI-REPO.md](docs/MULTI-REPO.md)

## 贡献

欢迎通过 Issue 和 Pull Request 参与，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。参与时请遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 许可证

`package.json` 声明为 MIT。仓库根目录未附带 LICENSE 文件。

---

## English

# GitLoom

**0.6.14** · A cross-platform multi-repo Git desktop client (Electron + React + TypeScript) with a built-in AI assistant.

## Features

- Work with multiple local Git repositories: status, commits, branches, diffs, and common workflows.
- Built-in AI assistant for explaining changes and drafting messages (bring your own model config).
- Electron + React + TypeScript, developed and packaged with electron-vite.

## Tech stack

- Electron + Vite + React + TypeScript
- Git

## Getting started

Source is at the repository root. This repository does not include installers.

```bash
npm install
npm run dev
npm test
npm run build
```
See that directory's README for the full feature and development guide.

## Documentation

- [`）、`F`、`C`、`Enter`、`/` | 变更可视化（先点一下图）：下 / 上一处改动、看全图、对准改动、打开详情、搜索；`Shift + 点击` 两个方块看路径 |
| `Ctrl/⌘ + Enter` | 提交（在提交信息框里）；AI 助手里发送消息 |
| `Esc` | 关闭弹层 / 对话框 |
---
## 性能（24 个仓库 + 6 个工作树的 EVER-BUDDY 测试项目，Linux，开启文件监视）
| 阶段（从进程启动起算） | 冷启动 | 热启动 |
|---|---|---|
| Electron 就绪 | ~300 ms | ~250–290 ms |
| 窗口显示 | ~750 ms | ~670–720 ms |
| 工作区载入 | ~770 ms | ~690–740 ms |
| 仓库树显示 | ~1.3 s | ~1.1–1.16 s |
| 全部仓库徽标就绪 | ~1.8 s | ~1.6–1.7 s |
复现：`bash scripts/make-bigproject-fixture.sh /tmp/gitloom-big && npm run build && node scripts/perf-big.mjs 3`
---
## 开发
```bash
npm install
npm run dev          # 开发模式
npm test             # 单元测试（vitest，会在 /tmp 创建临时仓库）
npm run typecheck
npm run build        # 类型检查 + 打包到 out/
xvfb-run -a node e2e/e2e.mjs            # 端到端：基础流程
xvfb-run -a node e2e/e2e-multi.mjs      # 端到端：多仓库项目
xvfb-run -a node e2e/e2e-advanced.mjs   # 端到端：导航与高级视图
xvfb-run -a node e2e/e2e-042.mjs        # 端到端：0.4.2（AI 服务商设置 + 模拟服务器、一键同步、快捷键等）
xvfb-run -a node e2e/e2e-043.mjs        # 端到端：0.4.3（AI 连点 / 停止 / 切换取消 / 缓存，慢速流式模拟服务器）
xvfb-run -a node e2e/e2e-050.mjs        # 端到端：0.5.0 变更可视化（SHOTS_DIR=screenshots/v8 刷新截图）
xvfb-run -a node e2e/e2e-051.mjs        # 端到端：0.5.1 代码地图 / 改动导览 / 快捷对比（SHOTS_DIR=screenshots/v9 刷新截图）
xvfb-run -a node e2e/e2e-regress-050.mjs # 端到端：全功能回归
node scripts/viz-fixtures.mjs /tmp/viz  # 生成可视化测试用的示例仓库（TS 服务 / Python / Java / 带热点文件与标签的 web-shop / 1500 文件大仓库）
xvfb-run -a node scripts/shots-v6.mjs   # 生成 screenshots/v6
npm run icons        # 由 build/logo.svg 生成 PNG / ICO / ICNS
```
## 打包
```bash
npm run dist:win     # NSIS 安装包 + 便携版 + zip
npm run dist:mac     # dmg + zip
npm run dist:linux   # AppImage + tar.gz + deb
```
## llmwiki 钩子
设置 → Git 钩子 → 模板 → 「llmwiki：自动维护 LLM 项目百科」→ 安装。之后每次提交都会生成：
- `docs/llmwiki/index.md`：README 摘要、基本信息、目录结构、文件类型统计、热点文件、最近提交
- `docs/llmwiki/changelog.md`：每次提交记一条（最新的在前）；配置了 AI 时追加「AI 摘要」
通过 GitLoom 提交时，当前默认 AI 配置会以环境变量（`LLMWIKI_BASE_URL` / `LLMWIKI_MODEL` / `LLMWIKI_API_KEY`）传给钩子。在命令行提交时，可以自己设置这些环境变量，或使用 `git config llmwiki.baseUrl/model`。`LLMWIKI_SKIP=1` 可跳过一次。
规划与调研见 [docs/PLAN.md](docs/PLAN.md)
- [docs/MULTI-REPO.md](docs/MULTI-REPO.md)

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately via [SECURITY.md](SECURITY.md). This project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

`package.json` declares MIT. There is no LICENSE file at the repository root.
