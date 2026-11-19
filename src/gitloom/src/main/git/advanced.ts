// Advanced git lifecycle helpers used by rebase / bisect / blame / LFS / pickaxe / clean / config / signing.
import { promises as fsp, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { GitService } from './service'
import type {
  BisectState, BlameLine, CleanEntry, ConfigEntry, FileHistoryEntry, LfsStatus, PickaxeHit,
  RebasePlan, RebaseTodo, RebaseTodoAction, SigningStatus, SubmoduleDetail
} from '../../shared/types'

const TODO_RE = /^(pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d|break|b)(?:\s+([0-9a-f]{4,40}))?(?:\s+(.*))?$/i
const ACT: Record<string, RebaseTodoAction> = {
  pick: 'pick', p: 'pick', reword: 'reword', r: 'reword', edit: 'edit', e: 'edit',
  squash: 'squash', s: 'squash', fixup: 'fixup', f: 'fixup', drop: 'drop', d: 'drop', break: 'break', b: 'break'
}

export function parseTodo(text: string): RebaseTodo[] {
  const out: RebaseTodo[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = TODO_RE.exec(line)
    if (!m) continue
    const action = ACT[m[1].toLowerCase()]
    out.push({ action, sha: m[2] ?? '', subject: m[3] ?? '' })
  }
  return out
}

export function serializeTodo(todos: RebaseTodo[]): string {
  return todos.map((t) => {
    if (t.action === 'break') return 'break'
    if (t.action === 'drop') return `# drop ${t.sha} ${t.subject}`.trim()
    return `${t.action} ${t.sha} ${t.subject}`.trim()
  }).join('\n') + '\n'
}

/** Build a rebase plan (list of commits from upstream..HEAD) without starting the rebase. */
export async function buildRebasePlan(git: GitService, repo: string, onto: string): Promise<RebasePlan> {
  const log = await git.log(repo, { range: `${onto}..HEAD`, limit: 500 })
  // log is newest-first; rebase todo is oldest-first
  const todos: RebaseTodo[] = [...log].reverse().map((c) => ({ action: 'pick' as const, sha: c.short, subject: c.subject }))
  return { onto, upstream: onto, todos }
}

/** Start an interactive rebase by injecting our plan via GIT_SEQUENCE_EDITOR. */
export async function startInteractiveRebase(git: GitService, repo: string, plan: RebasePlan): Promise<void> {
  const dir = path.join(os.tmpdir(), `gitloom-rebase-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const planFile = path.join(dir, 'git-rebase-todo')
  writeFileSync(planFile, serializeTodo(plan.todos.filter((t) => t.action !== 'drop')))
  // editor script: copy our plan over the todo file git passes as $1
  const editor = path.join(dir, process.platform === 'win32' ? 'editor.cmd' : 'editor.sh')
  if (process.platform === 'win32') {
    writeFileSync(editor, `@echo off\r\ncopy /Y "${planFile}" "%~1" >nul\r\n`)
  } else {
    writeFileSync(editor, `#!/bin/sh\ncp -f '${planFile.replace(/'/g, `'\\''`)}' "$1"\n`, { mode: 0o755 })
  }
  const r = await callGit(git, repo, ['rebase', '-i', '--autosquash', plan.onto], {
        env: { GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: 'true' }
      })
  if (!r.ok) {
    // conflicts or stop are expected; only throw on hard failure
    const msg = (r.stdout + '\n' + r.stderr).trim()
    if (!/conflict|Stopped|You can amend|Successfully rebased|editing is in progress|interactive rebase in progress/i.test(msg)
      && r.code !== 1) throw new Error(msg || '交互式变基失败')
    // code 1 with conflicts is fine — UI will show OperationBanner
    if (/Cannot rebase|fatal:/i.test(msg) && !/conflict/i.test(msg)) throw new Error(msg)
  }
}

async function callGit(git: GitService, repo: string, args: string[], opts: { env?: Record<string, string> } = {}) {
  return git.git(repo, args, { allowFail: true, env: opts.env, timeoutMs: 10 * 60 * 1000 })
}

export async function readRebaseTodo(git: GitService, repo: string): Promise<RebaseTodo[]> {
  const gd = await git.gitDir(repo)
  const candidates = ['rebase-merge/git-rebase-todo', 'rebase-apply/git-rebase-todo']
  for (const c of candidates) {
    const p = path.join(gd, c)
    if (existsSync(p)) return parseTodo(await fsp.readFile(p, 'utf8'))
  }
  return []
}

export async function writeRebaseTodo(git: GitService, repo: string, todos: RebaseTodo[]): Promise<void> {
  const gd = await git.gitDir(repo)
  for (const c of ['rebase-merge/git-rebase-todo', 'rebase-apply/git-rebase-todo']) {
    const p = path.join(gd, c)
    if (existsSync(p)) { await fsp.writeFile(p, serializeTodo(todos.filter((t) => t.action !== 'drop'))); return }
  }
  throw new Error('当前没有进行中的交互式变基')
}

export async function bisectStatus(git: GitService, repo: string): Promise<BisectState> {
  const gd = await git.gitDir(repo)
  const active = existsSync(path.join(gd, 'BISECT_LOG')) || existsSync(path.join(gd, 'BISECT_START'))
  if (!active) return { active: false, log: [] }
  let bad: string | undefined
  let good: string[] = []
  let current: string | undefined
  let remaining: number | undefined
  let steps: number | undefined
  try { bad = (await fsp.readFile(path.join(gd, 'refs/bisect/bad'), 'utf8')).trim() } catch { /* */ }
  try {
    const names = await fsp.readdir(path.join(gd, 'refs/bisect'))
    good = []
    for (const n of names) {
      if (n.startsWith('good-')) good.push((await fsp.readFile(path.join(gd, 'refs/bisect', n), 'utf8')).trim())
    }
  } catch { /* */ }
  try {
    const head = await callGit(git, repo, ['rev-parse', 'HEAD'])
    current = head.stdout.trim()
  } catch { /* */ }
  // parse BISECT_LOG for remaining estimate from last "Bisecting:" line
  const log: BisectState['log'] = []
  try {
    const text = await fsp.readFile(path.join(gd, 'BISECT_LOG'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = /^# (bad|good|skip):\s\[([0-9a-f]+)\]/.exec(line)
      if (m) log.push({ sha: m[2], verdict: m[1] as 'good' | 'bad' | 'skip', at: 0 })
      const b = /Bisecting:\s+(\d+)\s+revisions left to test after this \(roughly (\d+) steps\)/.exec(line)
      if (b) { remaining = Number(b[1]); steps = Number(b[2]) }
    }
  } catch { /* */ }
  return { active: true, bad, good, current, remaining, steps, log }
}

export async function bisectStart(git: GitService, repo: string, bad?: string, good?: string): Promise<BisectState> {
  await callGit(git, repo, ['bisect', 'start'])
  if (bad) await callGit(git, repo, ['bisect', 'bad', bad])
  if (good) await callGit(git, repo, ['bisect', 'good', good])
  return bisectStatus(git, repo)
}

export async function bisectMark(git: GitService, repo: string, verdict: 'good' | 'bad' | 'skip', sha?: string): Promise<{ output: string; state: BisectState }> {
  const args = ['bisect', verdict, ...(sha ? [sha] : [])]
  const r = await callGit(git, repo, args)
  return { output: (r.stdout + '\n' + r.stderr).trim(), state: await bisectStatus(git, repo) }
}

export async function bisectReset(git: GitService, repo: string): Promise<void> {
  await callGit(git, repo, ['bisect', 'reset'])
}

export async function blame(git: GitService, repo: string, file: string, rev?: string): Promise<BlameLine[]> {
  const args = ['blame', '--line-porcelain', '-w', ...(rev ? [rev] : []), '--', file]
  const r = await callGit(git, repo, args)
  if (!r.ok) throw new Error(r.stderr || 'blame 失败')
  const lines: BlameLine[] = []
  let cur: Partial<BlameLine> & { sha?: string } = {}
  for (const raw of r.stdout.split(/\r?\n/)) {
    if (/^[0-9a-f]{40}\s/.test(raw)) {
      const parts = raw.split(/\s+/)
      cur = { sha: parts[0], originalLine: Number(parts[1]) }
    } else if (raw.startsWith('author ')) cur.author = raw.slice(7)
    else if (raw.startsWith('author-time ')) cur.date = Number(raw.slice(12))
    else if (raw.startsWith('filename ')) cur.filename = raw.slice(9)
    else if (raw.startsWith('\t')) {
      lines.push({ sha: cur.sha!, author: cur.author ?? '', date: cur.date ?? 0, line: raw.slice(1), originalLine: cur.originalLine ?? 0, filename: cur.filename })
      cur = { sha: cur.sha, author: cur.author, date: cur.date, filename: cur.filename }
    }
  }
  return lines
}

export async function fileHistory(git: GitService, repo: string, file: string, max = 100): Promise<FileHistoryEntry[]> {
  const r = await callGit(git, repo, ['log', '--follow', `--max-count=${max}`, '--format=%H%x00%h%x00%an%x00%at%x00%s', '--name-status', '--', file])
  if (!r.ok) return []
  const out: FileHistoryEntry[] = []
  const chunks = r.stdout.split(/\n(?=[0-9a-f]{40}\x00)/)
  for (const c of chunks) {
    if (!c.trim()) continue
    const [meta, ...rest] = c.split('\n')
    const [hash, short, author, date, subject] = meta.split('\x00')
    const statusLine = rest.find((l) => /^[AMDCR]/.test(l))
    out.push({ hash, short, author, date: Number(date), subject, status: statusLine?.split('\t')[0] })
  }
  return out
}

export async function pickaxe(git: GitService, repo: string, query: string, opts: { regex?: boolean; max?: number; path?: string } = {}): Promise<PickaxeHit[]> {
  const args = ['log', `-S${query}`, ...(opts.regex ? ['-G' + query] : []), '--all', `--max-count=${opts.max ?? 50}`, '--format=%H%x00%h%x00%an%x00%at%x00%s', '--name-only']
  // Prefer -S (pickaxe); if regex requested use -G instead
  const finalArgs = opts.regex
    ? ['log', '-G' + query, '--all', `--max-count=${opts.max ?? 50}`, '--format=%H%x00%h%x00%an%x00%at%x00%s', '--name-only']
    : args
  if (opts.path) finalArgs.push('--', opts.path)
  const r = await callGit(git, repo, finalArgs)
  if (!r.ok) return []
  const out: PickaxeHit[] = []
  let cur: PickaxeHit | null = null
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.includes('\x00')) {
      if (cur) out.push(cur)
      const [hash, short, author, date, subject] = line.split('\x00')
      cur = { hash, short, author, date: Number(date), subject, files: [] }
    } else if (cur && line.trim()) cur.files.push(line.trim())
  }
  if (cur) out.push(cur)
  return out
}

export async function compareRefs(git: GitService, repo: string, a: string, b: string): Promise<{
  ahead: number; behind: number; commits: { hash: string; short: string; subject: string; author: string; date: number }[]
  files: { path: string; status: string; additions: number; deletions: number }[]
}> {
  const [ab, commitsR, diffR] = await Promise.all([
    callGit(git, repo, ['rev-list', '--left-right', '--count', `${a}...${b}`]),
    callGit(git, repo, ['log', '--format=%H%x00%h%x00%an%x00%at%x00%s', `${a}..${b}`, '--max-count=200']),
    callGit(git, repo, ['diff', '--numstat', '-M', `${a}...${b}`])
  ])
  const parts = ab.stdout.trim().split(/\s+/); const left = Number(parts[0] || 0); const right = Number(parts[1] || 0)
  const commits = commitsR.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, short, author, date, subject] = l.split('\x00')
    return { hash, short, author, date: Number(date), subject }
  })
  const files = diffR.stdout.split('\n').filter(Boolean).map((l) => {
    const [add, del, path] = l.split('\t')
    return { path: path ?? '', status: 'M', additions: add === '-' ? 0 : Number(add), deletions: del === '-' ? 0 : Number(del) }
  })
  return { ahead: right, behind: left, commits, files }
}

export async function cleanPreview(git: GitService, repo: string, opts: { ignored?: boolean; dirs?: boolean } = {}): Promise<CleanEntry[]> {
  const args = ['clean', '-n', '-d']
  if (opts.ignored) args.push('-x')
  const r = await callGit(git, repo, args)
  const out: CleanEntry[] = []
  for (const line of r.stdout.split('\n')) {
    const m = /^Would remove (.+)$/.exec(line.trim())
    if (!m) continue
    const p = m[1]
    const full = path.join(repo, p)
    const isDir = p.endsWith('/') || (existsSync(full) && (await fsp.stat(full)).isDirectory())
    const nestedRepo = isDir && (existsSync(path.join(full, '.git')) || existsSync(path.join(repo, p.replace(/\/$/, ''), '.git')))
    out.push({ path: p.replace(/\/$/, ''), kind: opts.ignored && !existsSync(path.join(repo, '.git')) ? 'ignored' : 'untracked', isDir, nestedRepo })
  }
  // mark ignored separately when -x was used: approximate via checking .gitignore match is hard; leave as untracked
  return out
}

export async function cleanApply(git: GitService, repo: string, paths: string[], opts: { ignored?: boolean } = {}): Promise<void> {
  // only remove listed paths (safer than -f everything)
  for (const p of paths) {
    const full = path.join(repo, p)
    if (!full.startsWith(path.resolve(repo))) throw new Error('路径越界')
    if (existsSync(path.join(full, '.git'))) throw new Error(`跳过嵌套仓库：${p}`)
  }
  const args = ['clean', '-f', '-d', ...(opts.ignored ? ['-x'] : []), '--', ...paths]
  const r = await callGit(git, repo, args)
  if (!r.ok) throw new Error(r.stderr || '清理失败')
}

export async function listConfig(git: GitService, repo: string, scope?: 'local' | 'global' | 'system'): Promise<ConfigEntry[]> {
  const scopes: Array<'local' | 'global' | 'system'> = scope ? [scope] : ['local', 'global', 'system']
  const out: ConfigEntry[] = []
  for (const sc of scopes) {
    const r = await callGit(git, repo, ['config', `--${sc}`, '--list', '--show-origin'])
    if (!r.ok) continue
    for (const line of r.stdout.split('\n')) {
      // file:/path\tkey=value  OR  file:C:\...\tkey=value
      const m = /^file:(.+?)\t([^=]+)=(.*)$/.exec(line)
      if (!m) continue
      out.push({ key: m[2], value: m[3], scope: sc })
    }
  }
  return out
}

export async function unsetConfig(git: GitService, repo: string, key: string, global = false): Promise<void> {
  await callGit(git, repo, ['config', ...(global ? ['--global'] : []), '--unset', key])
}

export async function signingStatus(git: GitService, repo: string): Promise<SigningStatus> {
  const [name, email, gpgsign, key, format] = await Promise.all([
    git.config(repo, 'user.name'), git.config(repo, 'user.email'),
    git.config(repo, 'commit.gpgsign'), git.config(repo, 'user.signingkey'),
    git.config(repo, 'gpg.format')
  ])
  let gpgAvailable = false, sshAvailable = false
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const { spawnSync } = require('child_process')
    gpgAvailable = spawnSync(which, ['gpg'], { encoding: 'utf8' }).status === 0
    sshAvailable = spawnSync(which, [process.platform === 'win32' ? 'ssh-keygen' : 'ssh-keygen'], { encoding: 'utf8' }).status === 0
  } catch { /* */ }
  const fmt = (format || 'openpgp') as SigningStatus['format']
  let hint: string | undefined
  if (gpgsign === 'true' && !key) hint = '已开启 commit.gpgsign，但未设置 user.signingkey。请在设置中配置 GPG/SSH 签名密钥。'
  else if (!gpgsign && !key) hint = '未启用提交签名。可在「工具 → 签名」中一键开启（GPG 或 SSH）。'
  return { gpgSign: gpgsign === 'true', signingKey: key, format: fmt, userName: name, userEmail: email, gpgAvailable, sshAvailable, hint }
}

export async function lfsStatus(git: GitService, repo: string): Promise<LfsStatus> {
  const ver = await callGit(git, repo, ['lfs', 'version'])
  const installed = ver.ok
  let attrs = ''
  try { attrs = await fsp.readFile(path.join(repo, '.gitattributes'), 'utf8') } catch { /* */ }
  const trackedPatterns = attrs.split('\n').filter((l) => /filter=lfs/.test(l)).map((l) => l.split(/\s+/)[0]).filter(Boolean)
  const used = trackedPatterns.length > 0
  const files: LfsStatus['files'] = []
  if (installed && used) {
    const ls = await callGit(git, repo, ['lfs', 'ls-files', '-s'])
    for (const line of ls.stdout.split('\n')) {
      //  oid  * path (size)
      const m = /^([0-9a-f]+)\s+[\*\-]\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(line.trim())
      if (!m) continue
      const sizeStr = m[3] ?? '0'
      const size = /GB$/i.test(sizeStr) ? parseFloat(sizeStr) * 1e9 : /MB$/i.test(sizeStr) ? parseFloat(sizeStr) * 1e6 : /KB$/i.test(sizeStr) ? parseFloat(sizeStr) * 1e3 : parseFloat(sizeStr) || 0
      files.push({ path: m[2], size, oid: m[1], tracked: true, pointer: true })
    }
  }
  return { installed, version: installed ? ver.stdout.trim().split('\n')[0] : undefined, used, files, trackedPatterns }
}

export async function lfsPull(git: GitService, repo: string): Promise<string> {
  const r = await callGit(git, repo, ['lfs', 'pull'])
  if (!r.ok) throw new Error(r.stderr || 'git lfs pull 失败')
  return (r.stdout + r.stderr).trim()
}

export async function lfsPush(git: GitService, repo: string, remote = 'origin'): Promise<string> {
  const r = await callGit(git, repo, ['lfs', 'push', '--all', remote])
  if (!r.ok) throw new Error(r.stderr || 'git lfs push 失败')
  return (r.stdout + r.stderr).trim()
}

export async function lfsTrack(git: GitService, repo: string, pattern: string): Promise<void> {
  const r = await callGit(git, repo, ['lfs', 'track', pattern])
  if (!r.ok) throw new Error(r.stderr || 'git lfs track 失败')
}

export async function submoduleDetails(git: GitService, repo: string): Promise<SubmoduleDetail[]> {
  const list = await git.submodules(repo)
  // also parse .gitmodules for uninitialized
  let mods: { name: string; path: string; url?: string }[] = []
  try {
    const text = await fsp.readFile(path.join(repo, '.gitmodules'), 'utf8')
    let cur: { name: string; path: string; url?: string } | null = null
    for (const line of text.split(/\r?\n/)) {
      const s = /^\[submodule "(.+)"\]/.exec(line)
      if (s) { if (cur) mods.push(cur); cur = { name: s[1], path: '' }; continue }
      if (!cur) continue
      const kv = /^\s*(path|url)\s*=\s*(.+)$/.exec(line)
      if (kv && kv[1] === 'path') cur.path = kv[2].trim()
      else if (kv && kv[1] === 'url') cur.url = kv[2].trim()
    }
    if (cur) mods.push(cur)
  } catch { /* no gitmodules */ }
  const byPath = new Map(list.map((s) => [s.path, s]))
  const out: SubmoduleDetail[] = []
  const seen = new Set<string>()
  for (const m of mods) {
    seen.add(m.path)
    const s = byPath.get(m.path)
    const state: SubmoduleDetail['state'] =
      !s || s.state === '-' ? 'uninitialized' :
      s.state === '+' ? 'modified' :
      s.state === 'U' ? 'conflict' :
      s.state === '?' ? 'untracked' : 'ok'
    out.push({ name: m.name, path: m.path, url: m.url, sha: s?.sha ?? '', state, describe: s?.describe ?? '' })
  }
  for (const s of list) {
    if (seen.has(s.path)) continue
    out.push({
      name: s.path, path: s.path, sha: s.sha, describe: s.describe,
      state: s.state === '-' ? 'uninitialized' : s.state === '+' ? 'modified' : s.state === 'U' ? 'conflict' : 'ok'
    })
  }
  return out
}

export async function submoduleRun(git: GitService, repo: string, action: 'init' | 'update' | 'sync' | 'deinit', paths?: string[]): Promise<string> {
  const args =
    action === 'init' ? ['submodule', 'init', ...(paths ?? [])] :
    action === 'update' ? ['submodule', 'update', '--init', '--recursive', ...(paths ?? [])] :
    action === 'sync' ? ['submodule', 'sync', '--recursive', ...(paths ?? [])] :
    ['submodule', 'deinit', '-f', ...(paths?.length ? paths : ['--all'])]
  const r = await callGit(git, repo, args)
  if (!r.ok && action !== 'deinit') throw new Error((r.stdout + '\n' + r.stderr).trim() || `submodule ${action} 失败`)
  return (r.stdout + r.stderr).trim()
}
