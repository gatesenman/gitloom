import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, Menu, Notification, safeStorage } from 'electron'
import { TaskService } from './tasks/service'
import { TEMPLATES } from './tasks/templates'
import type { AiTaskDef, RunTrigger } from '../shared/tasks'
import { spawn } from 'child_process'
import * as path from 'path'
import { promises as fsp, existsSync, mkdirSync } from 'fs'
import { GitService } from './git/service'
import { GitRunner } from './git/exec'
import { Store } from './store'
import { ProjectManager } from './projects'
import { DEFAULT_IGNORE, probeRepo } from './git/discovery'
import { buildPrompt, chat, unfence } from './ai'
import { callProfile, listProfileModels, migrateAI, chatWithFallback, resolveCandidates } from './aiClient'
import { VizService, type VizDeps } from './viz/service'
import { VizPool } from './viz/pool'
import { gitSpawn } from './viz/local'
import type { VizRequest } from '../shared/viz'
import { splitArgs } from './git/parse'
import { detectForge, listPRs, createPR, listIssues } from './forge'
import type { AIAction, AppSettings, WorkspaceState, AIChatMessage, AIProfile } from '../shared/types'
import * as wiki from './wiki'
import * as kgraph from './graph'
import { HealthEngine, mergeReviewIntoReport } from './health'
import type { HealthRunOptions, FindingStatus } from '../shared/health'
import { reportToMarkdown } from '../shared/health'
import { isQuitDestroyedError } from './quitGuard'
import { detectTools as detectExternalTools, installTool as installExternalTool, configureToolRoots } from './tools/detect'

// Register BEFORE app ready / any git work — Electron shows an error box for uncaught main-process exceptions otherwise.
process.on('uncaughtException', (err) => {
  if (isQuitDestroyedError(err)) return
  console.error('[uncaught]', err)
})
process.on('unhandledRejection', (reason) => {
  if (isQuitDestroyedError(reason)) return
  console.error('[unhandledRejection]', reason)
})

let win: BrowserWindow | null = null
let store: Store
/** Safe IPC to the main window — git/log / scan callbacks can fire after the window is destroyed on quit. */
function sendToWin(channel: string, ...args: unknown[]): void {
  const w = win
  if (!w || w.isDestroyed()) return
  try {
    const wc = w.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send(channel, ...args)
  } catch { /* window / webContents gone mid-send */ }
}

/** Stop git log IPC (keep runner usable). Call before the window is destroyed. */
function detachWindowIpc(): void {
  runner.onLog = undefined
}
function attachWindowIpc(): void {
  runner.onLog = (e) => sendToWin('git:log', e)
}
// isolated profiles (tests / screenshots): keep localStorage (layout prefs) next to the data file
if (process.env.GITLOOM_DATA_DIR) app.setPath('userData', path.resolve(process.env.GITLOOM_DATA_DIR, 'profile'))
const runner = new GitRunner('git', (e) => sendToWin('git:log', e))
const git = new GitService(runner)
const projects = new ProjectManager(git, (ch, payload) => sendToWin(ch, payload), () => ({
  maxDepth: store.settings.scanDepth || 6, ignore: store.settings.scanIgnore ?? DEFAULT_IGNORE, followSymlinks: true,
  slowMs: Number(process.env.GITLOOM_SCAN_SLOWMO ?? 0),
  concurrency: store.settings.concurrency ?? 6, watch: store.settings.watch !== false && !process.env.GITLOOM_NO_WATCH
}))

function applySettings(s: AppSettings): void {
  runner.gitPath = s.gitPath || 'git'
  nativeTheme.themeSource = s.theme
  git.hookEnv = s.aiEnvForHooks && s.ai.baseUrl
    ? { LLMWIKI_BASE_URL: s.ai.baseUrl, LLMWIKI_MODEL: s.ai.model, ...(s.ai.apiKey ? { LLMWIKI_API_KEY: s.ai.apiKey } : {}) }
    : {}
}

function iconPath(): string {
  // Packaged Windows: prefer .ico (taskbar/title); extraResources ships both .ico and .png.
  const res = process.resourcesPath ?? ''
  const candidates = [
    ...(process.platform === 'win32' ? [path.join(res, 'icon.ico'), path.join(__dirname, '../../build/icon.ico')] : []),
    path.join(res, 'icon.png'),
    path.join(__dirname, '../../build/icon.png'),
    path.join(app.getAppPath(), 'build/icon.png'),
    path.join(app.getAppPath(), 'build/icon.ico')
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 2]
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 680, show: false,
    title: 'GitLoom', icon: iconPath(), autoHideMenuBar: true,
    // Custom title bar: macOS keeps inset traffic lights, Windows/Linux draw their own controls in the renderer.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 17 } }
      : { frame: false }),
    backgroundColor: store.settings.theme === 'light' ? '#f7f7f9' : '#111216',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  win.on('ready-to-show', () => { perf('ready-to-show'); win?.show() })
  // Clear onLog before destroy so ChildProcess 'close' cannot send IPC (macOS may reopen later).
  win.on('close', () => { detachWindowIpc() })
  win.on('closed', () => { win = null })
  attachWindowIpc()
  const sendMax = () => { if (win && !win.isDestroyed()) sendToWin('win:maximized', win.isMaximized()) }
  win.on('maximize', sendMax); win.on('unmaximize', sendMax)
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
  if (process.env.GITLOOM_AUTOSHOT) win.webContents.once('did-finish-load', () => { void autoShot() })
}

// Methods of GitService callable from the renderer.
const GIT_METHODS = new Set([
  'version', 'isRepo', 'root', 'discover', 'init', 'clone', 'summary', 'status', 'stage', 'stageAll', 'unstage', 'unstageAll',
  'discard', 'fileDiff', 'applyHunk', 'diffContents', 'commit', 'lastCommitMessage', 'log', 'commitDetail', 'reflog',
  'branches', 'createBranch', 'checkout', 'deleteBranch', 'deleteRemoteBranch', 'renameBranch', 'setUpstream', 'merge', 'rebase',
  'cherryPick', 'revert', 'reset', 'continueOp', 'abortOp', 'resolveWith', 'conflictVersions', 'tags', 'createTag', 'deleteTag', 'remoteTags', 'pushTag', 'deleteRemoteTag',
  'remotes', 'addRemote', 'removeRemote', 'fetch', 'pull', 'push', 'worktrees', 'addWorktree', 'removeWorktree', 'pruneWorktrees',
  'lockWorktree', 'stashes', 'stashPush', 'stashApply', 'stashDrop', 'stashFiles', 'hooks', 'readHook', 'writeHook',
  'setHookEnabled', 'deleteHook', 'installHookTemplate', 'hookTemplates', 'ignore', 'config', 'setConfig', 'repoInfo', 'submodules',
  'buildRebasePlan', 'startInteractiveRebase', 'readRebaseTodo', 'writeRebaseTodo',
  'bisectStatus', 'bisectStart', 'bisectMark', 'bisectReset',
  'blame', 'fileHistory', 'pickaxe', 'compareRefs', 'cleanPreview', 'cleanApply',
  'listConfig', 'unsetConfig', 'signingStatus',
  'lfsStatus', 'lfsPull', 'lfsPush', 'lfsTrack',
  'submoduleDetails', 'submoduleRun',
  'listIgnoreSources', 'readIgnoreFile', 'writeIgnoreFile', 'checkIgnorePath', 'fileAuthors'
])

function registerIpc(): void {
  ipcMain.handle('win:minimize', () => win?.minimize())
  ipcMain.handle('win:toggleMaximize', () => { if (!win) return false; if (win.isMaximized()) win.unmaximize(); else win.maximize(); return win.isMaximized() })
  ipcMain.handle('win:close', () => win?.close())
  ipcMain.handle('win:isMaximized', () => win?.isMaximized() ?? false)
  ipcMain.handle('git:call', async (_e, method: string, args: unknown[]) => {
    if (!GIT_METHODS.has(method)) throw new Error(`不允许的方法：${method}`)
    const fn = (git as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]
    return fn.apply(git, args)
  })
  ipcMain.handle('git:raw', async (_e, repo: string, command: string) => {
    const args = splitArgs(command)
    if (args[0] !== 'git') throw new Error('只允许执行 git 命令')
    if (args.some((a) => /[|;&<>`$]/.test(a) && !a.startsWith('-'))) {
      // arguments are passed without a shell, but refuse obvious shell syntax to avoid surprises
      if (args.some((a) => ['|', ';', '&&', '>', '<'].includes(a))) throw new Error('不支持管道或多条命令')
    }
    return git.raw(repo, args.slice(1))
  })
  ipcMain.handle('git:commandLog', () => runner.log)
  ipcMain.handle('git:summaries', (_e, repos: string[]) => git.summaries(repos, store.settings.concurrency ?? 6))
  ipcMain.handle('project:scan', (_e, scanId: string, root: string, sub?: string) => { void projects.scan(scanId, root, sub).catch(() => undefined); return scanId })
  ipcMain.handle('project:probe', (_e, dir: string) => probeRepo(dir))
  ipcMain.handle('project:scanCancel', (_e, scanId: string) => projects.cancel(scanId))
  ipcMain.handle('project:watch', (_e, root: string, on: boolean) => { if (on) projects.watch(root); else projects.unwatch(root) })

  ipcMain.handle('app:settings', () => store.settings)
  ipcMain.handle('app:setSettings', async (_e, s: AppSettings) => { await store.setSettings(s); applySettings(store.settings); return store.settings })
  ipcMain.handle('app:workspace', () => store.workspace)
  ipcMain.handle('app:setWorkspace', async (_e, w: WorkspaceState) => { await store.setWorkspace(w) })
  ipcMain.handle('app:pickFolder', async (_e, title?: string) => {
    const r = await dialog.showOpenDialog(win!, { title: title ?? '选择文件夹', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('app:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('app:openExternal', (_e, url: string) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url) })
  ipcMain.handle('app:openInEditor', (_e, p: string) => {
    const cmd = process.platform === 'win32' ? 'code.cmd' : 'code'
    const child = spawn(cmd, [p], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' })
    child.on('error', () => shell.openPath(p))
    child.unref()
  })
  // 0.6.6 质量把关: builtin-first tools (bundled ocr/osv-scanner; app-local semgrep)
  // ── 0.6.1 AI 定时任务 ──
  ipcMain.handle('tasks:state', () => tasks.state())
  ipcMain.handle('tasks:templates', () => TEMPLATES)
  ipcMain.handle('tasks:save', (_e, t: AiTaskDef) => tasks.save(t))
  ipcMain.handle('tasks:remove', (_e, id: string) => tasks.remove(id))
  ipcMain.handle('tasks:run', (_e, id: string, trigger: RunTrigger) => tasks.run(id, trigger === 'missed' ? 'missed' : 'manual'))
  ipcMain.handle('tasks:connector', (_e, c: { url: string; authHeader?: string; token?: string | null }) => tasks.setConnector(c))
  ipcMain.handle('app:detectTools', async () => detectExternalTools())
  ipcMain.handle('app:installTool', async (_e, id: string) => installExternalTool(String(id || '')))
  ipcMain.handle('app:openTerminal', (_e, p: string) => {
    let child
    if (process.platform === 'win32') child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd: p, detached: true, stdio: 'ignore' })
    else if (process.platform === 'darwin') child = spawn('open', ['-a', 'Terminal', p], { detached: true, stdio: 'ignore' })
    else child = spawn('x-terminal-emulator', [], { cwd: p, detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  })
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron, userData: app.getPath('userData') }))
  ipcMain.handle('app:writeFile', async (_e, repo: string, rel: string, content: string) => {
    const full = path.resolve(repo, rel)
    if (!full.startsWith(path.resolve(repo))) throw new Error('路径越界')
    await fsp.writeFile(full, content)
  })

  const activeProfile = (): AIProfile | undefined => { const ai = migrateAI(store.settings.ai); return ai.profiles?.find((p) => p.id === ai.activeProfile) }
  // models of a (possibly unsaved) profile: live /models list, preset suggestions as fallback
  // In-flight AI requests by renderer request id → AbortController. 停止 / switching commit / unmount sends ai:cancel,
  // which aborts the HTTP stream (the provider stops generating and billing) instead of letting it run in the background.
  const inflight = new Map<string, AbortController>()
  const track = async <T,>(reqId: string | undefined, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> => {
    if (!reqId) return fn(undefined)
    const ctl = new AbortController()
    inflight.get(reqId)?.abort()
    inflight.set(reqId, ctl)
    try { return await fn(ctl.signal) } finally { if (inflight.get(reqId) === ctl) inflight.delete(reqId) }
  }
  ipcMain.handle('ai:cancel', (_e, reqId: string) => { inflight.get(reqId)?.abort(); inflight.delete(reqId) })
  ipcMain.handle('ai:models', (_e, p?: AIProfile, reqId?: string) => track(reqId, async (signal) => {
    const prof = p ?? activeProfile()
    if (!prof) return { models: [], source: 'preset' as const, error: '还没有配置 AI 服务商' }
    return listProfileModels(prof, fetch, signal)
  }))
  // 测试连接: one tiny streamed request against exactly this profile (no fallback)
  ipcMain.handle('ai:test', (_e, p?: AIProfile, reqId?: string) => track(reqId, async (signal) => {
    const prof = p ?? activeProfile()
    const t0 = Date.now()
    let first = 0
    const text = await callProfile(prof as AIProfile, [{ role: 'user', content: '只回复两个字：你好' }], { timeoutMs: 30000, maxTokens: 32, signal, onDelta: () => { if (!first) first = Date.now() - t0 } })
    return { text, ms: Date.now() - t0, firstTokenMs: first || Date.now() - t0, model: prof?.model ?? '' }
  }))
  // ---------------------------------------------------------------- 变更可视化 (static analysis in worker threads)
  const vizDir = (): { grammarDir: string; runtimeWasm: string } => {
    const res = path.join(process.resourcesPath ?? '', 'grammars')
    if (app.isPackaged && existsSync(res)) return { grammarDir: res, runtimeWasm: path.join(res, 'tree-sitter.wasm') }
    const root = app.getAppPath()
    return { grammarDir: path.join(root, 'node_modules/tree-sitter-wasms/out'), runtimeWasm: path.join(root, 'node_modules/web-tree-sitter/tree-sitter.wasm') }
  }
  const workerScript = path.join(__dirname, 'vizWorker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  let vizPool: VizPool | null = null
  let localParse: VizDeps['parseMany'] | null = null
  const vizDeps: VizDeps = {
    git: async (cwd, args, o) => { const r = await gitSpawn(cwd, args, o?.input, runner.gitPath); if (r.code !== 0 && !o?.allowFail) throw new Error(r.stderr.trim() || `git ${args[0]} 失败`); return { stdout: r.buf.toString('utf8'), ok: r.code === 0 } },
    gitBuf: async (cwd, args, input) => (await gitSpawn(cwd, args, input, runner.gitPath)).buf,
    parseMany: async (items, onProgress) => {
      if (!localParse && existsSync(workerScript) && !process.env.GITLOOM_VIZ_NO_WORKER) {
        try { vizPool ??= new VizPool(workerScript, vizDir()); return await vizPool.parseMany(items, onProgress) }
        catch (e) { console.warn('[viz] worker failed, parsing in-process:', (e as Error).message); vizPool?.dispose(); vizPool = null }
      }
      if (!localParse) { const { localDeps } = await import('./viz/local'); const d = vizDir(); localParse = localDeps(d.grammarDir, d.runtimeWasm).parseMany }
      return localParse(items, onProgress)
    }
  }
  const viz = new VizService(vizDeps)
  ipcMain.handle('viz:analyze', (e, req: VizRequest, reqId?: string) => track(reqId, async (signal) => {
    let last = 0
    const slow = Number(process.env.GITLOOM_VIZ_SLOWMO ?? 0)   // e2e: make 停止 testable on tiny / cached fixtures
    for (let i = 0; slow && i < 20 && !signal?.aborted; i++) await new Promise((r) => setTimeout(r, slow / 20))
    if (signal?.aborted) throw new Error("已取消")
    return viz.analyze(req, (p) => { const now = Date.now(); if (p.phase !== 'parse' || now - last > 120) { last = now; if (!e.sender.isDestroyed()) e.sender.send('viz:progress', { reqId, ...p }) } }, signal)
  }))
  ipcMain.handle('viz:snippet', (_e, id: string, o: Parameters<VizService['snippet']>[1]) => viz.snippet(id, o))
  ipcMain.handle('viz:patch', (_e, id: string, file: string, oldFile?: string) => viz.patch(id, file, oldFile))
  ipcMain.handle('viz:contents', (_e, id: string, before?: string, after?: string) => viz.contents(id, before, after))
  const vizModel = (): string => { const c = resolveCandidates(store.settings.ai, 'explain')[0]; return c ? `${c.profile.name} · ${c.model || '默认'}` : '' }
  ipcMain.handle('viz:aiInfo', (_e, id?: string) => { const model = vizModel(); return { model, cached: !!(id && model && viz.aiCached(id, model)) } })
  ipcMain.handle('viz:ai', (e, id: string, reqId?: string) => track(reqId, async (signal) => {
    const model = vizModel()
    if (!model) throw new Error('还没有配置 AI 服务商，请在「设置 → AI 模型」中添加')
    return viz.ai(id, model, async (messages, sig, onDelta) => (await chatWithFallback(store.settings.ai, 'explain', messages, { signal: sig, onDelta, temperature: 0.1, maxTokens: 6000, timeoutMs: 180000 })).text, signal,
      (chars, attempt) => { if (!e.sender.isDestroyed()) e.sender.send('viz:progress', { reqId, phase: 'ai', done: chars, total: 0, text: attempt > 1 ? `结构校验未通过，正在让 AI 修正…（${chars} 字）` : `AI 正在生成图表数据…（${chars} 字）` }) })
  }))
  // AI 路径导览 (Codemaps-style)
  ipcMain.handle('viz:tour', (e, id: string, question: string, reqId?: string) => track(reqId, async (signal) => {
    const model = vizModel()
    if (!model) throw new Error('还没有配置 AI 模型')
    return viz.tour(id, question ?? '', model, async (messages, sig, onDelta) => (await chatWithFallback(store.settings.ai, 'explain', messages, { signal: sig, onDelta, temperature: 0.1, maxTokens: 4000, timeoutMs: 180000 })).text, signal,
      (chars, attempt) => { if (!e.sender.isDestroyed()) e.sender.send('viz:progress', { reqId, phase: 'ai', done: chars, total: 0, text: attempt > 1 ? `结构校验未通过，正在让 AI 修正…（${chars} 字）` : `AI 正在规划代码路径…（${chars} 字）` }) })
  }))
  // export PNG / SVG / Mermaid: GITLOOM_SAVE_DIR skips the dialog (e2e)
  ipcMain.handle('viz:save', async (_e, name: string, data: string, encoding: 'utf8' | 'base64' = 'utf8') => {
    const safe = name.replace(/[\\/:*?"<>|]+/g, '_')
    let target: string | undefined
    if (process.env.GITLOOM_SAVE_DIR) { mkdirSync(process.env.GITLOOM_SAVE_DIR, { recursive: true }); target = path.join(process.env.GITLOOM_SAVE_DIR, safe) }
    else {
      const ext = path.extname(safe).slice(1)
      const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('downloads'), safe), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
      if (r.canceled || !r.filePath) return null
      target = r.filePath
    }
    await fsp.writeFile(target, Buffer.from(data, encoding))
    return target
  })
  ipcMain.handle('forge:detect', async (_e, repo: string) => detectForge(await git.remotes(repo)))
  ipcMain.handle('forge:prs', async (_e, repo: string) => {
    const f = detectForge(await git.remotes(repo)); if (!f) throw new Error('无法识别远程 Forge（需要 GitHub / GitLab origin）')
    return listPRs(f, store.settings.forge ?? { githubToken: '', gitlabToken: '', gitlabBaseUrl: 'https://gitlab.com' })
  })
  ipcMain.handle('forge:issues', async (_e, repo: string) => {
    const f = detectForge(await git.remotes(repo)); if (!f) throw new Error('无法识别远程 Forge')
    return listIssues(f, store.settings.forge ?? { githubToken: '', gitlabToken: '', gitlabBaseUrl: 'https://gitlab.com' })
  })
  ipcMain.handle('forge:createPR', async (_e, repo: string, input: { title: string; body?: string; head: string; base: string; draft?: boolean }) => {
    const f = detectForge(await git.remotes(repo)); if (!f) throw new Error('无法识别远程 Forge')
    return createPR(f, store.settings.forge ?? { githubToken: '', gitlabToken: '', gitlabBaseUrl: 'https://gitlab.com' }, input)
  })
  const streamTo = (e: Electron.IpcMainInvokeEvent, reqId?: string) => reqId ? (delta: string) => { if (!e.sender.isDestroyed()) e.sender.send('ai:chunk', { reqId, delta }) } : undefined
  ipcMain.handle('ai:chat', (e, messages: AIChatMessage[], repo?: string, reqId?: string) => track(reqId, async (signal) => {
    const s = store.settings.ai
    let grounded = messages
    if (repo) {
      try {
        const st = await git.status(repo)
        const patch = (await git.workingPatch(repo).catch(() => '')) || (await git.stagedPatch(repo).catch(() => ''))
        const sys = { role: 'system' as const, content: `你是 GitLoom 的仓库助手。当前仓库：${repo}\n分支：${st.branch}（领先 ${st.ahead} / 落后 ${st.behind}）；暂存 ${st.staged.length}，未暂存 ${st.unstaged.length}，冲突 ${st.conflicted.length}。\n以下是当前差异摘要（可能截断）：\n\`\`\`\n${(patch || '(无差异)').slice(0, 12000)}\n\`\`\`\n请用简体中文回答，给出可执行的 git 建议，不要编造不存在的命令输出。` }
        grounded = [sys, ...messages.filter((m) => m.role !== 'system')]
      } catch { /* ignore grounding errors */ }
    }
    return chat(s, grounded, { action: 'chat', signal, onDelta: streamTo(e, reqId) })
  }))
  ipcMain.handle('ai:run', (e, action: AIAction, repo: string, payload: Record<string, string | undefined> = {}) => track(payload.reqId, async (signal) => {
    const s = store.settings.ai
    const input: { diff?: string; context?: string; question?: string; branch?: string; log?: string } = { context: payload.context, question: payload.question }
    if (action === 'reviewStaged') {
      input.diff = await git.stagedPatch(repo)
      if (!input.diff.trim()) input.diff = await git.workingPatch(repo)
      if (!input.diff.trim()) throw new Error('没有可审查的改动（暂存区与工作区均为空）')
      input.branch = (await git.status(repo)).branch ?? undefined
    } else if (action === 'commitMessage') {
      input.diff = await git.stagedPatch(repo)
      if (!input.diff.trim()) throw new Error('暂存区为空，请先暂存要提交的改动')
      input.branch = (await git.status(repo)).branch ?? undefined
    } else if (action === 'explainDiff') {
      if (payload.sha) input.diff = await git.commitPatch(repo, payload.sha)
      else input.diff = await git.workingPatch(repo, payload.file, payload.staged === 'true')
      if (!input.diff?.trim()) throw new Error('没有差异可解释')
    } else if (action === 'prDescription') {
      const base = payload.base || 'main'
      const r = await git.raw(repo, ['log', '--no-merges', '--format=- %h %s', `${base}..HEAD`])
      input.log = `提交记录（${base}..HEAD）：\n${r.output}`
      input.diff = (await git.raw(repo, ['diff', '--stat', `${base}...HEAD`])).output
    } else if (action === 'conflictHelp') {
      const v = await git.conflictVersions(repo, payload.file!)
      input.diff = `文件：${payload.file}\n\n=== BASE ===\n${v.base}\n=== OURS（当前分支）===\n${v.ours}\n=== THEIRS（合入方）===\n${v.theirs}\n=== 当前文件（含冲突标记）===\n${v.merged}`.slice(0, 60000)
    } else if (action === 'designReview') {
      const cands = ['DESIGN.md', 'design.md', 'docs/DESIGN.md', '.design/DESIGN.md']
      let text = ''
      let used = ''
      for (const c of cands) {
        try {
          const full = path.join(repo, c)
          if (existsSync(full)) { text = await fsp.readFile(full, 'utf8'); used = c; break }
        } catch { /* */ }
      }
      if (!text.trim()) throw new Error('未找到 DESIGN.md（可在仓库根或 docs/ 下创建）')
      input.diff = `文件：${used}\n\n${text}`.slice(0, 80000)
    } else if (action === 'nlToGit') {
      const st = await git.status(repo)
      const br = (await git.branches(repo)).map((b) => b.name).slice(0, 30).join(', ')
      input.context = `当前分支：${st.branch}；领先 ${st.ahead} 落后 ${st.behind}；暂存 ${st.staged.length}，未暂存 ${st.unstaged.length}；分支：${br}`
    }
    if (signal?.aborted) throw new Error('已停止生成')
    const text = await chat(s, buildPrompt(action, s, input), { action, signal, onDelta: streamTo(e, payload.reqId) })
    if (action === 'commitMessage') return unfence(text)
    return text
  }))

  // ── 0.6.3 项目 Wiki（本地，不进仓库）──
  const ud = () => app.getPath('userData')
  ipcMain.handle('wiki:status', (_e, projectRoot: string, repoHint?: string) => wiki.statusOf(projectRoot, ud(), repoHint))
  ipcMain.handle('wiki:ensure', (_e, projectRoot: string) => wiki.ensureWiki(projectRoot, ud()))
  ipcMain.handle('wiki:list', (_e, projectRoot: string) => wiki.listWikiPages(projectRoot, ud()))
  ipcMain.handle('wiki:read', (_e, projectRoot: string, rel: string) => wiki.readWikiPage(projectRoot, ud(), rel))
  ipcMain.handle('wiki:ingest', async (_e, projectRoot: string, repo: string, limit = 10) => {
    const commits = await git.log(repo, { limit })
    const withFiles = []
    for (const c of commits.slice(0, limit)) {
      let files: string[] = []
      try { const d = await git.commitDetail(repo, c.hash); files = (d?.files ?? []).map((f: { path: string }) => f.path) } catch { /* */ }
      withFiles.push({ hash: c.hash, short: c.short, subject: c.subject, body: c.body, files })
    }
    return wiki.ingestWiki({ projectRoot, userData: ud(), repo, commits: withFiles, ai: store.settings.ai })
  })
  ipcMain.handle('wiki:migrate', (_e, projectRoot: string, legacyDir: string) => wiki.migrateLegacyWiki(projectRoot, ud(), legacyDir))
  ipcMain.handle('wiki:saveSettings', (_e, projectRoot: string, patch: Partial<wiki.WikiSettings>) => wiki.saveWikiSettings(projectRoot, ud(), patch))
  ipcMain.handle('wiki:write', (_e, projectRoot: string, opts: { rel?: string; title: string; content: string; summary?: string }) => wiki.writeWikiPage(projectRoot, ud(), opts))
  ipcMain.handle('wiki:reveal', (_e, projectRoot: string) => { const root = wiki.wikiRoot(projectRoot, ud()); shell.showItemInFolder(root); return root })
  // ── 0.6.5 knowledge graph ──
  ipcMain.handle('graph:status', (_e, projectRoot: string) => kgraph.graphStatus(projectRoot, ud()))
  ipcMain.handle('graph:search', (_e, projectRoot: string, q: string, limit?: number) => kgraph.search(projectRoot, ud(), q, limit))
  ipcMain.handle('graph:neighbors', (_e, projectRoot: string, id: string, limit?: number) => kgraph.neighbors(projectRoot, ud(), id, limit))
  ipcMain.handle('graph:blastRadius', (_e, projectRoot: string, id: string, opts?: { maxDepth?: number; cap?: number }) => kgraph.blast(projectRoot, ud(), id, opts))
  ipcMain.handle('graph:getNode', (_e, projectRoot: string, id: string) => kgraph.getNode(projectRoot, ud(), id))
  ipcMain.handle('graph:build', (e, projectRoot: string, repo: string, opts?: { sampleCap?: number; force?: boolean }, reqId?: string) => track(reqId, async (signal) => {
    return kgraph.buildKnowledgeGraph(
      {
        gitRaw: async (r, args) => { const x = await git.raw(r, args); return { output: x.output, ok: x.ok } },
        parseMany: (items, onProgress) => vizDeps.parseMany(
          items.map((it) => ({ ...it, key: it.path })),
          onProgress ? (d) => onProgress(d, items.length) : undefined
        )
      },
      {
        projectRoot, userData: ud(), repo,
        sampleCap: opts?.sampleCap, force: opts?.force, signal,
        onProgress: (p) => { if (!e.sender.isDestroyed()) e.sender.send('graph:progress', { reqId, ...p }) }
      }
    )
  }))
  ipcMain.handle('graph:checkStale', (_e, projectRoot: string, repo: string) => kgraph.checkKnowledgeStale(projectRoot, ud(), repo))
  ipcMain.handle('graph:data', (_e, projectRoot: string) => kgraph.loadGraphData(projectRoot, ud()))
  ipcMain.handle('graph:missingPaths', (_e, repo: string, paths: string[]) => kgraph.missingPathsInRepo(repo, paths || []))

  // ── 0.6.4 体检报告 ──
  const health = new HealthEngine({
    userData: ud(),
    git: {
      status: (repo) => git.status(repo),
      stagedPatch: (repo, max) => git.stagedPatch(repo, max),
      workingPatch: (repo, file, staged, max) => git.workingPatch(repo, file, staged, max),
      raw: (repo, args) => git.raw(repo, args)
    },
    parseMany: (items, onProgress) => vizDeps.parseMany(
      items.map((it) => ({ ...it, key: it.path })),
      onProgress
    ),
    detectTools: async () => detectExternalTools(),
    getAi: () => store.settings.ai,
    projectRootOf: (repo) => {
      const projects = store.workspace.projects ?? []
      const hit = projects.find((pr) => repo === pr.root || repo.startsWith(pr.root.replace(/[\\/]+$/, '') + '/') || repo.startsWith(pr.root.replace(/[\\/]+$/, '') + '\\'))
      return hit?.root
    }
  })
  ipcMain.handle('health:run', (_e, opts: HealthRunOptions) => track(opts.reqId, (signal) => health.run(opts, signal)))
  ipcMain.handle('health:list', (_e, repo: string) => health.store.list(repo))
  ipcMain.handle('health:get', (_e, repo: string, id: string) => health.store.get(repo, id))
  ipcMain.handle('health:latest', (_e, repo: string) => health.store.latest(repo))
  ipcMain.handle('health:export', async (_e, repo: string, id: string, format: 'markdown' | 'json') => {
    const r = await health.store.get(repo, id)
    if (!r) throw new Error('报告不存在')
    const body = format === 'json' ? JSON.stringify(r, null, 2) : reportToMarkdown(r)
    const ext = format === 'json' ? 'json' : 'md'
    const name = `gitloom-health-${id}.${ext}`
    let target: string | undefined
    if (process.env.GITLOOM_SAVE_DIR) {
      mkdirSync(process.env.GITLOOM_SAVE_DIR, { recursive: true })
      target = path.join(process.env.GITLOOM_SAVE_DIR, name)
    } else {
      const dlg = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
      if (dlg.canceled || !dlg.filePath) return null
      target = dlg.filePath
    }
    await fsp.writeFile(target, body, 'utf8')
    return target
  })
  ipcMain.handle('health:setFindingStatus', (_e, repo: string, reportId: string, findingId: string, status: FindingStatus) =>
    health.store.setFindingStatus(repo, reportId, findingId, status))
  ipcMain.handle('health:cancel', (_e, reqId: string) => { health.cancel(reqId); inflight.get(reqId)?.abort(); inflight.delete(reqId) })
  ipcMain.handle('health:mergeReview', async (_e, repo: string, reportId: string, text: string) => {
    const r = await health.store.get(repo, reportId)
    if (!r) throw new Error('报告不存在')
    const merged = mergeReviewIntoReport(r, text || '')
    await health.store.save(merged)
    return merged
  })
  ipcMain.handle('wiki:query', (_e, projectRoot: string, question: string) => wiki.queryWiki(projectRoot, ud(), question, store.settings.ai))

}

/** Automated screenshot tour for docs / CI (GITLOOM_AUTOSHOT=<dir>). */
async function autoShot(): Promise<void> {
  const dir = process.env.GITLOOM_AUTOSHOT!
  mkdirSync(dir, { recursive: true })
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // step syntax: name=view[:theme][:select][:tab][@repoIndex]
  const steps = (process.env.GITLOOM_AUTOSHOT_STEPS ?? 'changes=changes,graph=graph,history=history,branches=branches,worktrees=worktrees,hooks=hooks,stash=stash,settings=settings').split(',')
  const size = /^(\d+)x(\d+)$/.exec(process.env.GITLOOM_AUTOSHOT_SIZE ?? '')
  if (size) win!.setSize(Number(size[1]), Number(size[2]))
  await wait(Number(process.env.GITLOOM_AUTOSHOT_DELAY ?? 5000))
  for (const step of steps) {
    const [name0, spec0] = step.split('=')
    const [name, waitMs] = name0.split('~')
    const [spec, repoSel] = spec0.split('@')
    const [view, theme, select, tab, density] = spec.split(':')
    if (repoSel !== undefined) {
      const target = /^\d+$/.test(repoSel) ? store.workspace.repos[Number(repoSel)] : repoSel
      await win!.webContents.executeJavaScript(`window.__gitloomSetActive && window.__gitloomSetActive(${JSON.stringify(target)})`)
      await wait(1500)
    }
    win!.webContents.send('debug:navigate', { view, theme: theme || undefined, select: select || undefined, tab: tab || undefined, density: density || undefined })
    // park the pointer over the window chrome so hover states don't leak into screenshots
    win!.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 4 })
    await wait(Number(waitMs ?? process.env.GITLOOM_AUTOSHOT_WAIT ?? 4000))
    const img = await win!.webContents.capturePage()
    await fsp.writeFile(path.join(dir, `${name}.png`), img.toPNG())
  }
  app.quit()
}

/** GITLOOM_PERF=1: print startup milestones (ms since process start) to stdout — used by scripts/perf-big.mjs. */
const PERF = !!process.env.GITLOOM_PERF
const perf = (ev: string, extra = ''): void => { if (PERF) console.log(`[perf] ${Math.round(performance.now())} ${ev}${extra ? ' ' + extra : ''}`) }
ipcMain.on('perf:mark', (_e, ev: string, extra?: string) => perf(ev, extra))

app.whenReady().then(() => {
  perf('app-ready')
  store = new Store()
  applySettings(store.settings)
  Menu.setApplicationMenu(null)
  // 0.6.6: prefer bundled resources/tools, then userData/tools, then PATH
  configureToolRoots({
    resourcesTools: path.join(process.resourcesPath || '', 'tools'),
    userDataTools: path.join(app.getPath('userData'), 'tools')
  })
  initTasks()
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// Order matters: clear onLog + win first, then stop tasks & dispose — dispose must not re-trigger send.
app.on('before-quit', () => { detachWindowIpc(); win = null; tasks?.stop(); projects.dispose() })

// Tokens are encrypted with the OS keychain (safeStorage). Without it the token lives in memory only — never on disk.
const memSecrets = new Map<string, string>()
let tasks: TaskService
function initTasks() {
  tasks = new TaskService({
    dir: process.env.GITLOOM_DATA_DIR || app.getPath('userData'),
    chat: () => resolveCandidates(store.settings.ai, 'explain').length ? async (messages) => (await chatWithFallback(store.settings.ai, 'explain', messages, { temperature: 0.1, maxTokens: 4000, timeoutMs: 180000 })).text : null,
    enc: (s) => { if (safeStorage.isEncryptionAvailable()) return 'ss:' + safeStorage.encryptString(s).toString('base64'); const k = `mem:${Date.now()}`; memSecrets.set(k, s); return k },
    dec: (s) => { if (s.startsWith('mem:')) return memSecrets.get(s) ?? ''; try { return safeStorage.decryptString(Buffer.from(s.replace(/^ss:/, ''), 'base64')) } catch { return '' } },
    notify: (title, body) => { try { if (Notification.isSupported()) new Notification({ title, body }).show() } catch { /* ignore */ } },
    emit: (st) => { for (const w of BrowserWindow.getAllWindows()) { try { if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('tasks:changed', st) } catch { /* */ } } }
  })
  void tasks.load().then(() => tasks.start())
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
