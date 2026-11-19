/**
 * External tool detection + install (0.6.6 builtin-first).
 * Priority: bundled app resources → userData/tools → system PATH/npm.
 * source: 'builtin' | 'app' | 'system'
 */
import { spawn, spawnSync } from 'child_process'
import {
  existsSync, readdirSync, statSync, accessSync, constants as fsConstants,
  mkdirSync, writeFileSync, chmodSync, rmSync
} from 'fs'
import { join, delimiter } from 'path'
import { homedir } from 'os'

export type ToolSource = 'builtin' | 'app' | 'system'
export type ToolDetect = {
  id: string
  found: boolean
  version?: string
  path?: string
  note?: string
  source?: ToolSource
}
export type InstallResult = { ok: boolean; log: string; command?: string }

const win = process.platform === 'win32'

/** Injected from main after app ready; overridable in tests. */
let roots: { resourcesTools?: string; userDataTools?: string } = {}

export function configureToolRoots(r: { resourcesTools?: string; userDataTools?: string }): void {
  roots = { ...r }
  clearToolCache()
}

export function getToolRoots(): { resourcesTools?: string; userDataTools?: string } {
  return { ...roots }
}

export function resourcesToolsDir(): string | undefined {
  return roots.resourcesTools
}

export function userDataToolsDir(): string | undefined {
  return roots.userDataTools
}

/** Extra dirs often missing from Electron's PATH (npm global bins, Node installs). */
export function npmGlobalBins(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = []
  const home = env.HOME || env.USERPROFILE || homedir()
  if (win) {
    const appData = env.APPDATA || (home ? join(home, 'AppData', 'Roaming') : '')
    if (appData) dirs.push(join(appData, 'npm'))
    const local = env.LOCALAPPDATA || (home ? join(home, 'AppData', 'Local') : '')
    if (local) {
      dirs.push(join(local, 'Programs', 'nodejs'))
      const nvm = join(local, 'nvm')
      if (existsSync(nvm)) {
        try {
          for (const d of readdirSync(nvm)) {
            const p = join(nvm, d)
            if (/^v?\d/.test(d) && existsSync(join(p, 'node.exe'))) dirs.push(p)
          }
        } catch { /* ignore */ }
      }
    }
    for (const base of [env['ProgramFiles'], env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']) {
      if (!base) continue
      const n = join(base, 'nodejs')
      if (existsSync(n)) dirs.push(n)
    }
  } else {
    dirs.push(join(home, '.npm-global', 'bin'), join(home, '.local', 'bin'), '/usr/local/bin')
    const nvmDir = env.NVM_DIR || join(home, '.nvm')
    const versions = join(nvmDir, 'versions', 'node')
    if (existsSync(versions)) {
      try {
        for (const d of readdirSync(versions)) {
          const bin = join(versions, d, 'bin')
          if (existsSync(bin)) dirs.push(bin)
        }
      } catch { /* ignore */ }
    }
  }
  try {
    const npmCmd = win ? 'npm.cmd' : 'npm'
    const r = spawnSync(npmCmd, ['config', 'get', 'prefix'], {
      encoding: 'utf8',
      timeout: 2500,
      env,
      shell: win
    })
    const prefix = (r.stdout || '').trim()
    if (prefix && !prefix.includes('Error') && existsSync(prefix)) {
      dirs.push(win ? prefix : join(prefix, 'bin'))
    }
  } catch { /* ignore */ }
  return [...new Set(dirs.filter(Boolean))]
}

export function augmentedPath(env: NodeJS.ProcessEnv = process.env): string {
  const cur = env.PATH || env.Path || ''
  const extra = npmGlobalBins(env)
  const parts = [...extra, ...cur.split(delimiter).filter(Boolean)]
  return [...new Set(parts)].join(delimiter)
}

/** Candidate executable names for a logical tool on this platform. */
export function toolCandidates(id: string): string[] {
  if (id === 'ocr') return win ? ['ocr.cmd', 'ocr.exe', 'opencodereview.exe', 'ocr'] : ['ocr', 'opencodereview']
  if (id === 'semgrep') return win ? ['semgrep.exe', 'semgrep.cmd', 'semgrep'] : ['semgrep']
  if (id === 'osv-scanner') return win ? ['osv-scanner.exe', 'osv-scanner'] : ['osv-scanner']
  if (id === 'node') return win ? ['node.exe', 'node'] : ['node']
  if (id === 'npx') return win ? ['npx.cmd', 'npx.exe', 'npx'] : ['npx']
  if (id === 'python') return win ? ['python.exe', 'python3.exe', 'python', 'py.exe'] : ['python3', 'python']
  if (id === 'npm') return win ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm']
  return win ? [`${id}.cmd`, `${id}.exe`, id] : [id]
}

function isExecutable(p: string): boolean {
  try {
    if (!existsSync(p)) return false
    const st = statSync(p)
    if (!st.isFile() && !st.isFIFO()) return false
    if (win) return true
    accessSync(p, fsConstants.X_OK)
    return true
  } catch { return false }
}

/** Bundled paths shipped inside the installer (extraResources/tools). */
export function bundledCandidates(id: string, resourcesTools = roots.resourcesTools): string[] {
  if (!resourcesTools) return []
  if (id === 'ocr') {
    return [
      join(resourcesTools, 'ocr', win ? 'ocr.cmd' : 'ocr'),
      join(resourcesTools, 'ocr', win ? 'opencodereview.exe' : 'opencodereview'),
      join(resourcesTools, win ? 'ocr.exe' : 'ocr')
    ]
  }
  if (id === 'osv-scanner') {
    return [
      join(resourcesTools, win ? 'osv-scanner.exe' : 'osv-scanner'),
      join(resourcesTools, 'osv-scanner', win ? 'osv-scanner.exe' : 'osv-scanner')
    ]
  }
  if (id === 'semgrep') {
    // Semgrep is not shipped in the installer (Python bulk); only userData/app path.
    return []
  }
  return []
}

/** App-managed installs under userData/tools/<id>. */
export function userDataCandidates(id: string, userDataTools = roots.userDataTools): string[] {
  if (!userDataTools) return []
  const base = join(userDataTools, id)
  const out: string[] = []
  if (id === 'semgrep') {
    // venv layouts
    out.push(
      join(base, 'venv', win ? 'Scripts' : 'bin', win ? 'semgrep.exe' : 'semgrep'),
      join(base, 'venv', win ? 'Scripts' : 'bin', win ? 'semgrep.cmd' : 'semgrep'),
      join(base, win ? 'Scripts' : 'bin', win ? 'semgrep.exe' : 'semgrep'),
      join(base, win ? 'semgrep.exe' : 'semgrep')
    )
  } else if (id === 'ocr') {
    out.push(
      join(base, win ? 'ocr.cmd' : 'ocr'),
      join(base, win ? 'opencodereview.exe' : 'opencodereview'),
      join(base, 'bin', win ? 'opencodereview.exe' : 'opencodereview')
    )
  } else if (id === 'osv-scanner') {
    out.push(join(base, win ? 'osv-scanner.exe' : 'osv-scanner'))
  }
  return out
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (isExecutable(p)) return p
  }
  return null
}

/** Resolve with priority; returns path + source. Pure helper for tests. */
export function resolveToolWithSource(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  opts?: {
    resourcesTools?: string
    userDataTools?: string
    pathOverride?: string
    skipSystem?: boolean
  }
): { path: string; source: ToolSource } | null {
  const resDir = opts?.resourcesTools ?? roots.resourcesTools
  const udDir = opts?.userDataTools ?? roots.userDataTools

  const bundled = firstExisting(bundledCandidates(id, resDir))
  if (bundled) return { path: bundled, source: 'builtin' }

  const appLocal = firstExisting(userDataCandidates(id, udDir))
  if (appLocal) return { path: appLocal, source: 'app' }

  if (opts?.skipSystem) return null

  const pathStr = opts?.pathOverride ?? augmentedPath(env)
  const dirs = pathStr.split(delimiter).filter(Boolean)
  for (const name of toolCandidates(id)) {
    if (name.includes('/') || name.includes('\\')) {
      if (isExecutable(name)) return { path: name, source: 'system' }
      continue
    }
    for (const d of dirs) {
      const full = join(d, name)
      if (isExecutable(full)) return { path: full, source: 'system' }
    }
  }
  try {
    const which = win ? 'where' : 'which'
    for (const name of toolCandidates(id)) {
      const r = spawnSync(which, [name], {
        encoding: 'utf8',
        timeout: 3000,
        env: { ...env, PATH: pathStr, Path: pathStr },
        shell: win
      })
      const line = (r.stdout || '').trim().split(/\r?\n/)[0]
      if (r.status === 0 && line && isExecutable(line)) return { path: line, source: 'system' }
    }
  } catch { /* ignore */ }
  return null
}

/** Resolve absolute path (or bare name if only PATH lookup works) for a tool. */
export function resolveToolPath(id: string, env: NodeJS.ProcessEnv = process.env, pathOverride?: string): string | null {
  return resolveToolWithSource(id, env, { pathOverride })?.path ?? null
}

function probeVersion(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((res) => {
    let out = ''
    let done = false
    const fin = (v: string | null) => { if (!done) { done = true; res(v) } }
    try {
      const useShell = win && /\.cmd$/i.test(cmd)
      const pathStr = augmentedPath(env)
      const c = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
        env: { ...env, PATH: pathStr, Path: pathStr },
        windowsHide: true
      })
      c.stdout?.on('data', (d) => { out += d })
      c.stderr?.on('data', (d) => { out += d })
      c.on('error', () => fin(null))
      c.on('close', (code) => fin(code === 0 ? out.trim().split(/\r?\n/)[0].slice(0, 120) : null))
      setTimeout(() => { try { c.kill() } catch { /* */ } fin(null) }, 5000)
    } catch { fin(null) }
  })
}

const resolvedCache = new Map<string, string | null>()
const sourceCache = new Map<string, ToolSource | undefined>()

export function cachedToolPath(id: string): string | null {
  if (resolvedCache.has(id)) return resolvedCache.get(id) ?? null
  const hit = resolveToolWithSource(id)
  resolvedCache.set(id, hit?.path ?? null)
  sourceCache.set(id, hit?.source)
  return hit?.path ?? null
}

export function clearToolCache(): void {
  resolvedCache.clear()
  sourceCache.clear()
}

const DETECT_LIST: { id: string; versionArgs: string[] }[] = [
  { id: 'ocr', versionArgs: ['--version'] },
  { id: 'semgrep', versionArgs: ['--version'] },
  { id: 'osv-scanner', versionArgs: ['--version'] },
  { id: 'node', versionArgs: ['--version'] },
  { id: 'npx', versionArgs: ['--version'] },
  { id: 'python', versionArgs: ['--version'] }
]

function sourceNote(id: string, source: ToolSource): string | undefined {
  if (source === 'builtin') {
    if (id === 'ocr' || id === 'osv-scanner') return '已随安装包内置'
    return '内置'
  }
  if (source === 'app') return '应用内安装'
  return undefined
}

export async function detectTools(env: NodeJS.ProcessEnv = process.env): Promise<ToolDetect[]> {
  clearToolCache()
  const pathStr = augmentedPath(env)
  const out: ToolDetect[] = []
  for (const { id, versionArgs } of DETECT_LIST) {
    const hit = resolveToolWithSource(id, env, { pathOverride: pathStr })
    resolvedCache.set(id, hit?.path ?? null)
    sourceCache.set(id, hit?.source)
    if (!hit) {
      if (id === 'ocr') {
        const npx = resolveToolPath('npx', env, pathStr)
        if (npx) {
          const v = await probeVersion(npx, ['--no-install', '@alibaba-group/open-code-review', '--version'], env)
          if (v) {
            out.push({ id, found: true, version: v, path: npx, note: 'via npx --no-install', source: 'system' })
            continue
          }
        }
      }
      out.push({ id, found: false })
      continue
    }
    const v = await probeVersion(hit.path, versionArgs, env)
    const note = sourceNote(id, hit.source)
    out.push({
      id,
      found: v !== null || hit.source === 'builtin' || hit.source === 'app',
      version: v ?? undefined,
      path: hit.path,
      note,
      source: hit.source
    })
  }
  return out
}

/** Install recipes for external/system fallback. */
export function installCommand(id: string): { cmd: string; args: string[]; shell?: boolean; label: string } | null {
  if (id === 'ocr') {
    return { cmd: win ? 'npm.cmd' : 'npm', args: ['install', '-g', '@alibaba-group/open-code-review'], shell: win, label: 'npm install -g @alibaba-group/open-code-review' }
  }
  if (id === 'semgrep') {
    if (win) {
      return { cmd: 'python', args: ['-m', 'pip', 'install', 'semgrep'], shell: true, label: 'python -m pip install semgrep' }
    }
    return { cmd: 'pip3', args: ['install', 'semgrep'], shell: false, label: 'pip3 install semgrep' }
  }
  if (id === 'osv-scanner') {
    if (win) {
      return { cmd: 'winget', args: ['install', '-e', '--id', 'Google.OsvScanner', '--accept-package-agreements', '--accept-source-agreements'], shell: true, label: 'winget install Google.OsvScanner' }
    }
    if (process.platform === 'darwin') {
      return { cmd: 'brew', args: ['install', 'osv-scanner'], label: 'brew install osv-scanner' }
    }
    return null
  }
  return null
}

export function manualInstallHint(id: string): string {
  if (id === 'ocr') return 'npm install -g @alibaba-group/open-code-review'
  if (id === 'semgrep') return win ? 'python -m pip install semgrep' : 'pip3 install semgrep  # 或: pipx install semgrep'
  if (id === 'osv-scanner') {
    return win
      ? 'winget install Google.OsvScanner  # 或 scoop install osv-scanner；npm 项目也可直接 npm audit'
      : '参见 https://google.github.io/osv-scanner/ 安装；npm 项目也可 npm audit'
  }
  if (id === 'node' || id === 'npx') return 'https://nodejs.org 下载安装 LTS'
  if (id === 'python') return 'https://python.org 下载安装（勾选 Add to PATH）'
  return ''
}

/** Whether this tool prefers app-managed install into userData. */
export function prefersAppInstall(id: string): boolean {
  return id === 'semgrep'
}

function runSpawn(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<{ code: number | null; log: string }> {
  return new Promise((resolve) => {
    let log = ''
    const pathStr = augmentedPath(env)
    try {
      const useShell = win && (/\.cmd$/i.test(cmd) || cmd === 'python' || cmd === 'py' || cmd === 'winget')
      const c = spawn(cmd, args, {
        cwd: cwd || homedir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
        env: { ...env, PATH: pathStr, Path: pathStr },
        windowsHide: true
      })
      c.stdout?.on('data', (d) => { log += d.toString() })
      c.stderr?.on('data', (d) => { log += d.toString() })
      const timer = setTimeout(() => {
        try { c.kill() } catch { /* */ }
        resolve({ code: null, log: log + '\n超时\n' })
      }, 300000)
      c.on('error', (err) => {
        clearTimeout(timer)
        resolve({ code: 1, log: log + `\n启动失败：${err.message}\n` })
      })
      c.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, log })
      })
    } catch (e) {
      resolve({ code: 1, log: `无法启动：${(e as Error).message}\n` })
    }
  })
}

/** Install semgrep into userData/tools/semgrep (venv). Offline-friendly after success. */
export async function installSemgrepAppLocal(env: NodeJS.ProcessEnv = process.env): Promise<InstallResult> {
  const ud = roots.userDataTools
  if (!ud) {
    return { ok: false, log: '应用数据目录未就绪，无法安装到应用内。', command: manualInstallHint('semgrep') }
  }
  const py = resolveToolPath('python', env)
  if (!py) {
    return {
      ok: false,
      log: '未检测到 Python，无法在应用内安装 Semgrep。\n请先安装 Python 3 并勾选 Add to PATH，然后点「安装到应用内」。\n也可手动：' + manualInstallHint('semgrep'),
      command: manualInstallHint('semgrep')
    }
  }
  const dest = join(ud, 'semgrep')
  const venv = join(dest, 'venv')
  let log = `$ 应用内安装 Semgrep → ${dest}\n`
  try {
    mkdirSync(dest, { recursive: true })
  } catch (e) {
    return { ok: false, log: log + `无法创建目录：${(e as Error).message}`, command: manualInstallHint('semgrep') }
  }
  // Recreate venv for a clean install
  try { rmSync(venv, { recursive: true, force: true }) } catch { /* */ }
  log += `$ ${py} -m venv ${venv}\n`
  const venvRes = await runSpawn(py, ['-m', 'venv', venv], env)
  log += venvRes.log
  if (venvRes.code !== 0) {
    // Fallback: pip --target
    log += '\nvenv 失败，尝试 pip --target …\n'
    const target = join(dest, 'site')
    mkdirSync(target, { recursive: true })
    const pipRes = await runSpawn(py, ['-m', 'pip', 'install', '--target', target, 'semgrep'], env)
    log += pipRes.log
    if (pipRes.code !== 0) {
      return { ok: false, log: log + '\n应用内安装失败。可改用外部：\n' + manualInstallHint('semgrep'), command: manualInstallHint('semgrep') }
    }
    // Write launcher
    const launcher = win ? join(dest, 'semgrep.cmd') : join(dest, 'semgrep')
    if (win) {
      writeFileSync(launcher, `@echo off\r\n"${py}" "${join(target, 'semgrep')}" %*\r\n`)
    } else {
      writeFileSync(launcher, `#!/bin/sh\nexec "${py}" "${join(target, 'semgrep')}" "$@"\n`)
      try { chmodSync(launcher, 0o755) } catch { /* */ }
    }
    clearToolCache()
    const hit = resolveToolWithSource('semgrep', env)
    if (hit) return { ok: true, log: log + '\n安装完成（pip --target）。', command: 'app-install semgrep' }
    return { ok: false, log: log + '\n安装后仍未检测到 semgrep。', command: manualInstallHint('semgrep') }
  }
  const pip = join(venv, win ? 'Scripts' : 'bin', win ? 'pip.exe' : 'pip')
  const pyVenv = join(venv, win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python')
  const pipCmd = isExecutable(pip) ? pip : pyVenv
  const pipArgs = isExecutable(pip) ? ['install', 'semgrep'] : ['-m', 'pip', 'install', 'semgrep']
  log += `$ pip install semgrep (venv)\n`
  const inst = await runSpawn(pipCmd, pipArgs, env, dest)
  log += inst.log
  clearToolCache()
  if (inst.code !== 0) {
    return { ok: false, log: log + '\n应用内安装失败。可改用外部：\n' + manualInstallHint('semgrep'), command: manualInstallHint('semgrep') }
  }
  const hit = resolveToolWithSource('semgrep', env)
  if (hit) return { ok: true, log: log + '\n安装完成（应用内 venv）。之后可离线使用。', command: 'app-install semgrep' }
  return { ok: false, log: log + '\n安装后未找到 semgrep 可执行文件。', command: manualInstallHint('semgrep') }
}

export async function installTool(id: string, env: NodeJS.ProcessEnv = process.env): Promise<InstallResult> {
  // Prefer app-managed for semgrep
  if (id === 'semgrep') {
    const existing = resolveToolWithSource('semgrep', env)
    if (existing?.source === 'builtin' || existing?.source === 'app') {
      return { ok: true, log: `Semgrep 已可用（${existing.source === 'app' ? '应用内' : '内置'}）：${existing.path}`, command: existing.path }
    }
    const appRes = await installSemgrepAppLocal(env)
    if (appRes.ok) return appRes
    // Fall through to external recipe if python missing message already clear — still try system install as power-user fallback
    const recipe = installCommand('semgrep')
    if (!recipe || !resolveToolPath('python', env)) return appRes
    // Continue with system pip as optional fallback
  }

  // ocr / osv already bundled → report success
  if (id === 'ocr' || id === 'osv-scanner') {
    const existing = resolveToolWithSource(id, env)
    if (existing?.source === 'builtin') {
      return { ok: true, log: `${id} 已随安装包内置：${existing.path}`, command: existing.path }
    }
    if (existing?.source === 'app') {
      return { ok: true, log: `${id} 已在应用内：${existing.path}`, command: existing.path }
    }
  }

  const recipe = installCommand(id)
  const hint = manualInstallHint(id)
  if (!recipe) {
    return { ok: false, log: `暂不支持一键安装「${id}」。请手动执行：\n${hint}`, command: hint }
  }
  if (recipe.cmd === 'npm.cmd' || recipe.cmd === 'npm') {
    if (!resolveToolPath('npm', env) && !resolveToolPath('node', env)) {
      return { ok: false, log: '未检测到 npm/node，无法一键安装。请先安装 Node.js：https://nodejs.org\n然后手动执行：\n' + hint, command: hint }
    }
  }
  if (id === 'semgrep' && win) {
    if (!resolveToolPath('python', env)) {
      return { ok: false, log: '未检测到 Python，无法安装 semgrep。请先安装 Python 并勾选 Add to PATH。\n或手动：' + hint, command: hint }
    }
  }

  return new Promise((resolve) => {
    let log = `$ ${recipe.label}\n`
    const pathStr = augmentedPath(env)
    try {
      const c = spawn(recipe.cmd, recipe.args, {
        cwd: homedir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: !!recipe.shell,
        env: { ...env, PATH: pathStr, Path: pathStr },
        windowsHide: true
      })
      c.stdout?.on('data', (d) => { log += d.toString() })
      c.stderr?.on('data', (d) => { log += d.toString() })
      c.on('error', (err) => {
        resolve({
          ok: false,
          log: log + `\n启动失败：${err.message}\n请手动执行（可复制）：\n${hint}`,
          command: hint
        })
      })
      const timer = setTimeout(() => {
        try { c.kill() } catch { /* */ }
        resolve({ ok: false, log: log + '\n安装超时。请手动执行：\n' + hint, command: hint })
      }, 300000)
      c.on('close', (code) => {
        clearTimeout(timer)
        clearToolCache()
        if (code === 0) {
          resolve({ ok: true, log: log + '\n安装完成。', command: recipe.label })
        } else {
          resolve({
            ok: false,
            log: log + `\n退出码 ${code}。若需管理员权限或网络失败，请在终端手动执行（可复制）：\n${hint}`,
            command: hint
          })
        }
      })
    } catch (e) {
      resolve({ ok: false, log: `无法启动安装：${(e as Error).message}\n请手动：\n${hint}`, command: hint })
    }
  })
}

/** Exported for runOcr — prefer cached absolute path. */
export function ocrExecutable(): string {
  return cachedToolPath('ocr') || (win ? 'ocr.cmd' : 'ocr')
}
