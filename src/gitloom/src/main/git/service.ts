// GitService: high-level git operations on top of the system git CLI.
// Electron-free so it can be unit-tested with plain node (vitest).
import { promises as fsp, existsSync, statSync, readFileSync } from 'fs'
import * as path from 'path'
import { GitRunner, type ExecOptions } from './exec'
import {
  BRANCH_FORMAT, FS, LOG_FORMAT, TAG_FORMAT, buildHunkPatch, langFromPath, parseBranches, parseDiff,
  parseLog, parseRemotes, parseStashes, parseStatusV2, parseLsRemoteTags, parseTags, parseWorktrees
} from './parse'
import { COMMON_HOOKS, HOOK_TEMPLATES, STANDARD_HOOKS } from './hookTemplates'
import type {
  BranchInfo, CommitDetail, CommitInfo, DiffContents, FileDiff, HookInfo, RemoteInfo, RepoStatus,
  RepoSummary, StashInfo, TagInfo, WorktreeInfo
} from '../../shared/types'

function readGitfile(p: string): string { try { return readFileSync(p, 'utf8') } catch { return '' } }

const MAX_DIFF_BYTES = 4 * 1024 * 1024
const BASE = ['-c', 'core.quotepath=false', '-c', 'color.ui=false']

export type DiffSource =
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  | { kind: 'commit'; sha: string; parent?: string }
  | { kind: 'stash'; index: number }

export interface CommitOptions { amend?: boolean; signoff?: boolean; noVerify?: boolean; sign?: boolean; allowEmpty?: boolean }

export class GitService {
  hookEnv: Record<string, string> = {}
  constructor(public runner = new GitRunner()) {}

  git(cwd: string, args: string[], opts?: ExecOptions) { return this.runner.run(cwd, [...BASE, ...args], opts) }
  private out(cwd: string, args: string[], opts?: ExecOptions) { return this.runner.out(cwd, [...BASE, ...args], opts) }

  // ---------------------------------------------------------------- repos
  async version(): Promise<string> { return (await this.runner.out(process.cwd(), ['--version'])).trim() }

  async isRepo(dir: string): Promise<boolean> {
    if (!existsSync(dir)) return false
    const r = await this.git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true })
    return r.ok && r.stdout.trim() === 'true'
  }

  async root(dir: string): Promise<string> { return (await this.out(dir, ['rev-parse', '--show-toplevel'])).trim() }

  async gitDir(repo: string): Promise<string> {
    const d = (await this.out(repo, ['rev-parse', '--git-dir'])).trim()
    return path.resolve(repo, d)
  }

  async commonDir(repo: string): Promise<string> {
    const d = (await this.out(repo, ['rev-parse', '--git-common-dir'])).trim()
    return path.resolve(repo, d)
  }

  /** Scan a folder for git repositories (folder itself, then children up to `depth`). */
  async discover(dir: string, depth = 3): Promise<string[]> {
    const found: string[] = []
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.venv', '__pycache__'])
    const walk = async (d: string, level: number): Promise<void> => {
      if (existsSync(path.join(d, '.git'))) { found.push(d); return }
      if (level >= depth) return
      let entries: import('fs').Dirent[] = []
      try { entries = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (!e.isDirectory() || skip.has(e.name) || e.name.startsWith('.')) continue
        await walk(path.join(d, e.name), level + 1)
      }
    }
    if (await this.isRepo(dir)) { found.push(await this.root(dir)); return found }
    await walk(dir, 0)
    return found
  }

  async init(dir: string, defaultBranch = 'main'): Promise<void> {
    await fsp.mkdir(dir, { recursive: true })
    await this.git(dir, ['init', '-b', defaultBranch])
  }

  async clone(url: string, dir: string, opts: { depth?: number; branch?: string } = {}): Promise<void> {
    const args = ['clone', '--progress']
    if (opts.depth) args.push('--depth', String(opts.depth))
    if (opts.branch) args.push('-b', opts.branch)
    args.push(url, dir)
    await this.git(path.dirname(dir), args, { timeoutMs: 30 * 60 * 1000 })
  }

  async summary(repo: string): Promise<RepoSummary> {
    const name = path.basename(repo)
    const now = Date.now()
    try {
      if (!existsSync(repo)) throw new Error('目录不存在（可能已被移动或删除）')
      const bare = !existsSync(path.join(repo, '.git')) && existsSync(path.join(repo, 'HEAD')) && existsSync(path.join(repo, 'objects'))
      if (bare) {
        const [head, last] = await Promise.all([
          this.git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true }),
          this.lastCommit(repo)
        ])
        return { path: repo, name, branch: head.ok ? head.stdout.trim() : null, changes: 0, ahead: 0, behind: 0, isWorktree: false, bare: true, lastCommit: last, conflicts: 0, staged: 0, updatedAt: now }
      }
      const [st, last] = await Promise.all([this.status(repo), this.lastCommit(repo)])
      const gitPath = path.join(repo, '.git')
      const isWorktree = existsSync(gitPath) && statSync(gitPath).isFile() && /worktrees/.test(readGitfile(gitPath))
      // Exclude paths that are themselves nested git repos / bare repos from the parent's change count
      const isNestedRepoPath = (f: { path: string; untracked?: boolean; submodule?: boolean }) => {
        if (f.submodule) return true
        const full = path.join(repo, f.path)
        return existsSync(path.join(full, '.git')) || (existsSync(path.join(full, 'HEAD')) && existsSync(path.join(full, 'objects')))
      }
      const realUnstaged = st.unstaged.filter((f) => !isNestedRepoPath(f))
      const realStaged = st.staged.filter((f) => !isNestedRepoPath(f))
      return {
        path: repo, name, branch: st.detached ? `(${st.headSha?.slice(0, 7) ?? 'detached'})` : st.branch,
        changes: realStaged.length + realUnstaged.length + st.conflicted.length, ahead: st.ahead, behind: st.behind, isWorktree,
        detached: st.detached, conflicts: st.conflicted.length, staged: realStaged.length,
        dirtySubmodules: st.unstaged.filter((f) => f.submodule).length, upstream: st.upstream, operation: st.operation,
        lastCommit: last, updatedAt: now
      }
    } catch (e) {
      return { path: repo, name, branch: null, changes: 0, ahead: 0, behind: 0, isWorktree: false, error: String((e as Error).message), updatedAt: now }
    }
  }

  async lastCommit(repo: string): Promise<RepoSummary['lastCommit']> {
    const r = await this.git(repo, ['log', '-1', '--format=%h%x00%s%x00%ct%x00%an'], { allowFail: true })
    if (!r.ok || !r.stdout.trim()) return null
    const [sha, subject, date, author] = r.stdout.trim().split('\0')
    return { sha, subject, date: Number(date), author }
  }

  /** Summaries for many repos with a concurrency limit (keeps the machine responsive with 200+ repos). */
  async summaries(repos: string[], concurrency = 6): Promise<RepoSummary[]> {
    const out: RepoSummary[] = new Array(repos.length)
    let i = 0
    const worker = async () => { while (i < repos.length) { const k = i++; out[k] = await this.summary(repos[k]) } }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, repos.length)) }, worker))
    return out
  }

  /** How does the enclosing repository see a nested repo path? (ignored / untracked / gitlink / tracked) */
  async parentTracking(parent: string, child: string): Promise<'ignored' | 'untracked' | 'gitlink' | 'tracked'> {
    const rel = path.relative(parent, child).split(path.sep).join('/')
    const ign = await this.git(parent, ['check-ignore', '-q', '--', rel], { allowFail: true })
    if (ign.ok) return 'ignored'
    const ls = await this.git(parent, ['ls-files', '-s', '--', rel], { allowFail: true })
    const lines = ls.stdout.split('\n').filter(Boolean)
    if (lines.some((l) => l.startsWith('160000') && l.endsWith(`\t${rel}`))) return 'gitlink'
    return lines.length ? 'tracked' : 'untracked'
  }

  async operation(repo: string): Promise<string | null> {
    const gd = await this.gitDir(repo)
    if (existsSync(path.join(gd, 'rebase-merge')) || existsSync(path.join(gd, 'rebase-apply'))) return 'REBASING'
    if (existsSync(path.join(gd, 'MERGE_HEAD'))) return 'MERGING'
    if (existsSync(path.join(gd, 'CHERRY_PICK_HEAD'))) return 'CHERRY-PICKING'
    if (existsSync(path.join(gd, 'REVERT_HEAD'))) return 'REVERTING'
    if (existsSync(path.join(gd, 'BISECT_LOG'))) return 'BISECTING'
    return null
  }

  async status(repo: string): Promise<RepoStatus> {
    const out = await this.out(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
    const st = parseStatusV2(out)
    const [operation, stash] = await Promise.all([
      this.operation(repo),
      this.git(repo, ['rev-list', '--walk-reflogs', '--count', 'refs/stash'], { allowFail: true })
    ])
    return { ...st, operation, stashCount: stash.ok ? Number(stash.stdout.trim()) || 0 : 0 }
  }

  // ---------------------------------------------------------------- staging
  async stage(repo: string, paths: string[]): Promise<void> {
    if (!paths.length) return
    await this.git(repo, ['add', '-A', '--', ...paths])
  }

  async stageAll(repo: string): Promise<void> { await this.git(repo, ['add', '-A']) }

  async unstage(repo: string, paths: string[]): Promise<void> {
    if (!paths.length) return
    const hasHead = (await this.git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })).ok
    if (hasHead) await this.git(repo, ['reset', '-q', 'HEAD', '--', ...paths])
    else await this.git(repo, ['rm', '--cached', '-r', '-q', '--', ...paths])
  }

  async unstageAll(repo: string): Promise<void> {
    const hasHead = (await this.git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })).ok
    if (hasHead) await this.git(repo, ['reset', '-q'])
    else await this.git(repo, ['rm', '--cached', '-r', '-q', '.'])
  }

  /** Discard working tree changes. Untracked files are deleted. */
  async discard(repo: string, paths: string[]): Promise<void> {
    if (!paths.length) return
    const st = await this.status(repo)
    const untracked = new Set(st.unstaged.filter((f) => f.untracked).map((f) => f.path))
    const ut = paths.filter((p) => untracked.has(p))
    const tracked = paths.filter((p) => !untracked.has(p))
    if (ut.length) await this.git(repo, ['clean', '-f', '-q', '--', ...ut])
    if (tracked.length) await this.git(repo, ['checkout', '-q', '--', ...tracked])
  }

  async fileDiff(repo: string, file: string, staged: boolean, context = 3): Promise<FileDiff | null> {
    const args = ['diff', '--no-ext-diff', `-U${context}`, '--no-color']
    if (staged) args.push('--cached')
    args.push('--', file)
    const out = await this.out(repo, args, { maxBuffer: MAX_DIFF_BYTES })
    return parseDiff(out)[0] ?? null
  }

  /** Stage / unstage / discard one hunk, or only some lines of it. */
  async applyHunk(repo: string, file: string, hunkIndex: number, action: 'stage' | 'unstage' | 'discard', lines?: number[]): Promise<void> {
    const staged = action === 'unstage'
    const fd = await this.fileDiff(repo, file, staged)
    if (!fd) throw new Error('没有可应用的差异')
    const reverse = action !== 'stage'
    const patch = buildHunkPatch(fd, hunkIndex, lines ? new Set(lines) : undefined, reverse)
    if (!patch) throw new Error('未选择任何变更行')
    const args = ['apply', '--whitespace=nowarn', '--unidiff-zero']
    if (action !== 'discard') args.push('--cached')
    if (reverse) args.push('--reverse')
    args.push('-')
    await this.git(repo, args, { input: patch })
  }

  // ---------------------------------------------------------------- diff contents (for Monaco)
  private async showBlob(repo: string, spec: string): Promise<string | null> {
    const r = await this.git(repo, ['show', spec], { allowFail: true, maxBuffer: MAX_DIFF_BYTES })
    return r.ok ? r.stdout : null
  }

  async diffContents(repo: string, file: string, src: DiffSource, origPath?: string): Promise<DiffContents> {
    const language = langFromPath(file)
    let original = ''
    let modified = ''
    const op = origPath || file
    if (src.kind === 'unstaged') {
      original = (await this.showBlob(repo, `:${op}`)) ?? (await this.showBlob(repo, `HEAD:${op}`)) ?? ''
      const abs = path.join(repo, file)
      try {
        const st = await fsp.stat(abs)
        if (st.size > MAX_DIFF_BYTES) return { original: '', modified: '', binary: false, language, tooLarge: true }
        modified = st.isFile() ? await fsp.readFile(abs, 'utf8') : ''
      } catch { modified = '' }
    } else if (src.kind === 'staged') {
      original = (await this.showBlob(repo, `HEAD:${op}`)) ?? ''
      modified = (await this.showBlob(repo, `:${file}`)) ?? ''
    } else if (src.kind === 'commit') {
      const parent = src.parent ?? (await this.parents(repo, src.sha))[0]
      original = parent ? (await this.showBlob(repo, `${parent}:${op}`)) ?? '' : ''
      modified = (await this.showBlob(repo, `${src.sha}:${file}`)) ?? ''
    } else {
      const ref = `stash@{${src.index}}`
      original = (await this.showBlob(repo, `${ref}^1:${op}`)) ?? ''
      modified = (await this.showBlob(repo, `${ref}:${file}`)) ?? (await this.showBlob(repo, `${ref}^3:${file}`)) ?? ''
    }
    const binary = original.includes('\0') || modified.includes('\0')
    if (binary) return { original: '', modified: '', binary, language }
    return { original, modified, binary, language }
  }

  // ---------------------------------------------------------------- commit
  async commit(repo: string, message: string, opts: CommitOptions = {}): Promise<string> {
    const args = ['commit', '-F', '-']
    if (opts.amend) args.push('--amend')
    if (opts.signoff) args.push('--signoff')
    if (opts.noVerify) args.push('--no-verify')
    if (opts.allowEmpty) args.push('--allow-empty')
    if (opts.sign === true) args.push('-S')
    if (opts.sign === false) args.push('--no-gpg-sign')
    await this.git(repo, args, { input: message, env: this.hookEnv, timeoutMs: 5 * 60 * 1000 })
    return (await this.out(repo, ['rev-parse', 'HEAD'])).trim()
  }

  async lastCommitMessage(repo: string): Promise<string> {
    const r = await this.git(repo, ['log', '-1', '--format=%B'], { allowFail: true })
    return r.ok ? r.stdout.trim() : ''
  }

  async stagedPatch(repo: string, maxBytes = 60000): Promise<string> {
    const stat = await this.out(repo, ['diff', '--cached', '--stat'])
    const diff = await this.out(repo, ['diff', '--cached', '--no-color', '-U2'], { maxBuffer: MAX_DIFF_BYTES })
    const body = diff.length > maxBytes ? diff.slice(0, maxBytes) + '\n…（差异过长已截断）' : diff
    return `${stat}\n${body}`
  }

  async workingPatch(repo: string, file?: string, staged = false, maxBytes = 60000): Promise<string> {
    const args = ['diff', '--no-color', '-U3']
    if (staged) args.push('--cached')
    if (file) args.push('--', file)
    const diff = await this.out(repo, args, { maxBuffer: MAX_DIFF_BYTES })
    return diff.length > maxBytes ? diff.slice(0, maxBytes) + '\n…（差异过长已截断）' : diff
  }

  // ---------------------------------------------------------------- log / graph
  async log(repo: string, opts: { limit?: number; all?: boolean; ref?: string; range?: string; file?: string; grep?: string; author?: string; skip?: number } = {}): Promise<CommitInfo[]> {
    const args = ['log', `--format=${LOG_FORMAT}`, '--date-order', `-n${opts.limit ?? 500}`]
    if (opts.skip) args.push(`--skip=${opts.skip}`)
    if (opts.grep) args.push(`--grep=${opts.grep}`, '-i')
    if (opts.author) args.push(`--author=${opts.author}`)
    if (opts.range) args.push(opts.range)
    else if (opts.all) args.push('--branches', '--remotes', '--tags', 'HEAD')
    else if (opts.ref) args.push(opts.ref)
    if (opts.file) args.push('--follow', '--', opts.file)
    const r = await this.git(repo, args, { allowFail: true })
    if (!r.ok) {
      if (/does not have any commits|bad default revision|unknown revision/i.test(r.stderr)) return []
      throw new Error(r.stderr.trim())
    }
    return parseLog(r.stdout)
  }

  async parents(repo: string, sha: string): Promise<string[]> {
    const out = await this.out(repo, ['rev-list', '--parents', '-n1', sha])
    return out.trim().split(' ').slice(1)
  }

  async commitDetail(repo: string, sha: string): Promise<CommitDetail> {
    const fmt = ['%H', '%h', '%P', '%an', '%ae', '%at', '%D', '%s', '%G?', '%b'].join('%x1f')
    const raw = await this.out(repo, ['show', '-s', `--format=${fmt}`, sha])
    const [hash, short, parents, author, email, date, refs, subject, sig, body] = raw.split(FS)
    const ps = parents ? parents.trim().split(' ').filter(Boolean) : []
    const base = ps[0]
    const nsArgs = base ? ['diff', '--name-status', '-M', base, hash] : ['diff-tree', '--root', '-r', '--name-status', '-M', '--no-commit-id', hash]
    const numArgs = base ? ['diff', '--numstat', '-M', base, hash] : ['diff-tree', '--root', '-r', '--numstat', '-M', '--no-commit-id', hash]
    const [ns, num] = await Promise.all([this.out(repo, nsArgs), this.out(repo, numArgs)])
    const stats = new Map<string, [number, number]>()
    for (const l of num.split('\n').filter(Boolean)) {
      const [a, d, ...p] = l.split('\t')
      let fp = p[p.length - 1]
      const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(fp)
      if (brace) fp = `${brace[1]}${brace[3]}${brace[4]}`.replace('//', '/')
      else if (fp.includes(' => ')) fp = fp.split(' => ')[1]
      stats.set(fp, [a === '-' ? 0 : +a, d === '-' ? 0 : +d])
    }
    const files = ns.split('\n').filter(Boolean).map((l) => {
      const parts = l.split('\t')
      const status = parts[0][0]
      const p = parts[parts.length - 1]
      const s = stats.get(p) ?? [0, 0]
      return { path: p, status, origPath: parts.length > 2 ? parts[1] : undefined, additions: s[0], deletions: s[1] }
    })
    return {
      hash, short, parents: ps, author, email, date: Number(date), subject,
      refs: refs ? refs.split(', ').filter(Boolean) : [], signature: sig?.trim() || undefined, body: (body ?? '').trim(), files
    }
  }

  async commitPatch(repo: string, sha: string, maxBytes = 60000): Promise<string> {
    const d = await this.out(repo, ['show', '--stat', '-p', '--format=%s%n%n%b', sha], { maxBuffer: MAX_DIFF_BYTES })
    return d.length > maxBytes ? d.slice(0, maxBytes) + '\n…（已截断）' : d
  }

  async reflog(repo: string, limit = 100): Promise<{ sha: string; selector: string; subject: string; date: number }[]> {
    const r = await this.git(repo, ['reflog', `-n${limit}`, '--format=%H%x1f%gd%x1f%gs%x1f%ct'], { allowFail: true })
    if (!r.ok) return []
    return r.stdout.split('\n').filter(Boolean).map((l) => {
      const [sha, selector, subject, date] = l.split(FS)
      return { sha, selector, subject, date: Number(date) }
    })
  }

  // ---------------------------------------------------------------- branches / tags / remotes
  async branches(repo: string): Promise<BranchInfo[]> {
    return parseBranches(await this.out(repo, ['for-each-ref', `--format=${BRANCH_FORMAT}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes']))
  }

  async createBranch(repo: string, name: string, start?: string, checkout = true): Promise<void> {
    if (checkout) await this.git(repo, ['checkout', '-b', name, ...(start ? [start] : [])])
    else await this.git(repo, ['branch', name, ...(start ? [start] : [])])
  }

  async checkout(repo: string, ref: string): Promise<void> {
    if (ref.includes('/')) {
      // remote branch → create local tracking branch if missing
      const remotes = (await this.remotes(repo)).map((r) => r.name)
      const [rem, ...rest] = ref.split('/')
      if (remotes.includes(rem)) {
        const local = rest.join('/')
        const exists = (await this.git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${local}`], { allowFail: true })).ok
        if (!exists) { await this.git(repo, ['checkout', '-q', '--track', ref], { env: this.hookEnv }); return }
        await this.git(repo, ['checkout', '-q', local], { env: this.hookEnv }); return
      }
    }
    await this.git(repo, ['checkout', '-q', ref], { env: this.hookEnv })
  }

  async deleteBranch(repo: string, name: string, force = false): Promise<void> {
    await this.git(repo, ['branch', force ? '-D' : '-d', name])
  }

  async deleteRemoteBranch(repo: string, remote: string, name: string): Promise<void> {
    await this.git(repo, ['push', remote, '--delete', name], { timeoutMs: 10 * 60 * 1000 })
  }

  async renameBranch(repo: string, oldName: string, newName: string): Promise<void> {
    await this.git(repo, ['branch', '-m', oldName, newName])
  }

  async setUpstream(repo: string, branch: string, upstream: string): Promise<void> {
    await this.git(repo, ['branch', `--set-upstream-to=${upstream}`, branch])
  }

  async merge(repo: string, ref: string, opts: { noFf?: boolean; squash?: boolean; ffOnly?: boolean } = {}): Promise<string> {
    const args = ['merge', '--no-edit']
    if (opts.noFf) args.push('--no-ff')
    if (opts.squash) args.push('--squash')
    if (opts.ffOnly) args.push('--ff-only')
    args.push(ref)
    const r = await this.git(repo, args, { allowFail: true, env: this.hookEnv })
    if (!r.ok) throw new Error((r.stdout + '\n' + r.stderr).trim())
    return r.stdout
  }

  async rebase(repo: string, onto: string): Promise<string> {
    const r = await this.git(repo, ['rebase', onto], { allowFail: true })
    if (!r.ok) throw new Error((r.stdout + '\n' + r.stderr).trim())
    return r.stdout
  }

  async cherryPick(repo: string, sha: string): Promise<void> {
    const r = await this.git(repo, ['cherry-pick', sha], { allowFail: true, env: this.hookEnv })
    if (!r.ok) throw new Error((r.stdout + '\n' + r.stderr).trim())
  }

  async revert(repo: string, sha: string): Promise<void> {
    const parents = await this.parents(repo, sha)
    const args = ['revert', '--no-edit']
    if (parents.length > 1) args.push('-m', '1')
    args.push(sha)
    const r = await this.git(repo, args, { allowFail: true, env: this.hookEnv })
    if (!r.ok) throw new Error((r.stdout + '\n' + r.stderr).trim())
  }

  async reset(repo: string, sha: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    await this.git(repo, ['reset', `--${mode}`, sha])
  }

  async continueOp(repo: string): Promise<void> {
    const op = await this.operation(repo)
    const map: Record<string, string[]> = {
      MERGING: ['commit', '--no-edit'], REBASING: ['rebase', '--continue'],
      'CHERRY-PICKING': ['cherry-pick', '--continue'], REVERTING: ['revert', '--continue']
    }
    if (!op || !map[op]) throw new Error('当前没有进行中的操作')
    await this.git(repo, map[op], { env: this.hookEnv })
  }

  async abortOp(repo: string): Promise<void> {
    const op = await this.operation(repo)
    const map: Record<string, string[]> = {
      MERGING: ['merge', '--abort'], REBASING: ['rebase', '--abort'], 'CHERRY-PICKING': ['cherry-pick', '--abort'],
      REVERTING: ['revert', '--abort'], BISECTING: ['bisect', 'reset']
    }
    if (!op || !map[op]) throw new Error('当前没有进行中的操作')
    await this.git(repo, map[op])
  }

  async resolveWith(repo: string, file: string, side: 'ours' | 'theirs'): Promise<void> {
    await this.git(repo, ['checkout', `--${side}`, '--', file])
    await this.git(repo, ['add', '--', file])
  }

  async conflictVersions(repo: string, file: string): Promise<{ base: string; ours: string; theirs: string; merged: string }> {
    const [base, ours, theirs] = await Promise.all([1, 2, 3].map((n) => this.showBlob(repo, `:${n}:${file}`)))
    let merged = ''
    try { merged = await fsp.readFile(path.join(repo, file), 'utf8') } catch { /* deleted */ }
    return { base: base ?? '', ours: ours ?? '', theirs: theirs ?? '', merged }
  }

  async tags(repo: string): Promise<TagInfo[]> {
    return parseTags(await this.out(repo, ['for-each-ref', `--format=${TAG_FORMAT}`, '--sort=-creatordate', 'refs/tags']))
  }

  async createTag(repo: string, name: string, sha?: string, message?: string): Promise<void> {
    const args = ['tag']
    if (message) args.push('-a', name, '-m', message)
    else args.push(name)
    if (sha) args.push(sha)
    await this.git(repo, args)
  }

  async deleteTag(repo: string, name: string): Promise<void> { await this.git(repo, ['tag', '-d', name]) }

  /** 远程标签列表（ls-remote --tags）；无远程时返回 [] */
  async remoteTags(repo: string, remote = 'origin'): Promise<{ name: string; sha: string }[]> {
    const remotes = await this.remotes(repo)
    const r = remotes.find((x) => x.name === remote) ?? remotes[0]
    if (!r) return []
    const res = await this.git(repo, ['ls-remote', '--tags', r.name], { allowFail: true, timeoutMs: 60_000 })
    if (!res.ok) return []
    return parseLsRemoteTags(res.stdout || res.stderr || '')
  }

  /** 推送单个标签到远程 */
  async pushTag(repo: string, name: string, remote?: string): Promise<string> {
    const remotes = await this.remotes(repo)
    const r = remote ?? remotes[0]?.name
    if (!r) throw new Error('没有配置远程仓库')
    return this.push(repo, { remote: r, branch: `refs/tags/${name}` })
  }

  /** 删除远程标签（push :refs/tags/name） */
  async deleteRemoteTag(repo: string, name: string, remote?: string): Promise<string> {
    const remotes = await this.remotes(repo)
    const r = remote ?? remotes[0]?.name
    if (!r) throw new Error('没有配置远程仓库')
    const res = await this.git(repo, ['push', r, `:refs/tags/${name}`], { allowFail: true, timeoutMs: 10 * 60 * 1000, env: this.hookEnv })
    if (!res.ok) throw new Error((res.stdout + '\n' + res.stderr).trim())
    return res.stdout + res.stderr
  }


  async remotes(repo: string): Promise<RemoteInfo[]> { return parseRemotes(await this.out(repo, ['remote', '-v'])) }
  async addRemote(repo: string, name: string, url: string): Promise<void> { await this.git(repo, ['remote', 'add', name, url]) }
  async removeRemote(repo: string, name: string): Promise<void> { await this.git(repo, ['remote', 'remove', name]) }

  // ---------------------------------------------------------------- sync
  async fetch(repo: string, remote?: string, prune = true): Promise<string> {
    const args = ['fetch', ...(prune ? ['--prune'] : []), ...(remote ? [remote] : ['--all']), '--tags']
    const r = await this.git(repo, args, { timeoutMs: 10 * 60 * 1000 })
    return r.stderr
  }

  async pull(repo: string, opts: { rebase?: boolean; ffOnly?: boolean } = {}): Promise<string> {
    const r = await this.git(repo, ['pull', opts.ffOnly ? '--ff-only' : opts.rebase ? '--rebase' : '--no-rebase'], { allowFail: true, timeoutMs: 10 * 60 * 1000, env: this.hookEnv })
    if (!r.ok) throw new Error((r.stdout + '\n' + r.stderr).trim())
    return r.stdout + r.stderr
  }

  async push(repo: string, opts: { force?: boolean; setUpstream?: boolean; remote?: string; branch?: string; tags?: boolean } = {}): Promise<string> {
    const args = ['push']
    if (opts.force) args.push('--force-with-lease')
    if (opts.tags) args.push('--tags')
    if (opts.setUpstream) {
      const st = await this.status(repo)
      const remote = opts.remote ?? (await this.remotes(repo))[0]?.name
      if (!remote) throw new Error('没有配置远程仓库')
      args.push('-u', remote, opts.branch ?? st.branch ?? 'HEAD')
    } else if (opts.remote) {
      args.push(opts.remote)
      if (opts.branch) args.push(opts.branch)
    }
    const r = await this.git(repo, args, { allowFail: true, timeoutMs: 10 * 60 * 1000, env: this.hookEnv })
    if (!r.ok) throw new Error((r.stdout + '\n' + r.stderr).trim())
    return r.stdout + r.stderr
  }

  // ---------------------------------------------------------------- worktrees
  async worktrees(repo: string): Promise<WorktreeInfo[]> {
    const top = await this.root(repo)
    return parseWorktrees(await this.out(repo, ['worktree', 'list', '--porcelain']), top)
  }

  async addWorktree(repo: string, dir: string, opts: { branch?: string; newBranch?: string; base?: string; detach?: boolean }): Promise<void> {
    const args = ['worktree', 'add']
    if (opts.detach) args.push('--detach')
    if (opts.newBranch) args.push('-b', opts.newBranch)
    args.push(dir)
    if (opts.newBranch) { if (opts.base) args.push(opts.base) } else if (opts.branch) args.push(opts.branch)
    await this.git(repo, args, { env: this.hookEnv })
  }

  async removeWorktree(repo: string, dir: string, force = false): Promise<void> {
    await this.git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), dir])
  }

  async pruneWorktrees(repo: string): Promise<void> { await this.git(repo, ['worktree', 'prune']) }
  async lockWorktree(repo: string, dir: string, lock: boolean, reason?: string): Promise<void> {
    await this.git(repo, lock ? ['worktree', 'lock', ...(reason ? ['--reason', reason] : []), dir] : ['worktree', 'unlock', dir])
  }

  // ---------------------------------------------------------------- stash
  async stashes(repo: string): Promise<StashInfo[]> {
    const r = await this.git(repo, ['stash', 'list', '--format=%gd%x1f%H%x1f%ct%x1f%gs'], { allowFail: true })
    return r.ok ? parseStashes(r.stdout) : []
  }

  async stashPush(repo: string, message?: string, opts: { includeUntracked?: boolean; keepIndex?: boolean; staged?: boolean; paths?: string[] } = {}): Promise<void> {
    const args = ['stash', 'push']
    if (opts.includeUntracked) args.push('--include-untracked')
    if (opts.keepIndex) args.push('--keep-index')
    if (opts.staged) args.push('--staged')
    if (message) args.push('-m', message)
    if (opts.paths?.length) args.push('--', ...opts.paths)
    await this.git(repo, args)
  }

  async stashApply(repo: string, index: number, pop = false): Promise<void> {
    const r = await this.git(repo, ['stash', pop ? 'pop' : 'apply', '--index', `stash@{${index}}`], { allowFail: true })
    if (!r.ok) {
      // retry without --index (index could not be restored)
      const r2 = await this.git(repo, ['stash', pop ? 'pop' : 'apply', `stash@{${index}}`], { allowFail: true })
      if (!r2.ok) throw new Error((r2.stdout + '\n' + r2.stderr).trim())
    }
  }

  async stashDrop(repo: string, index: number): Promise<void> { await this.git(repo, ['stash', 'drop', `stash@{${index}}`]) }

  async stashFiles(repo: string, index: number): Promise<{ path: string; status: string }[]> {
    const ref = `stash@{${index}}`
    const out = await this.out(repo, ['diff', '--name-status', `${ref}^1`, ref])
    const files = out.split('\n').filter(Boolean).map((l) => { const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] } })
    const u = await this.git(repo, ['ls-tree', '-r', '--name-only', `${ref}^3`], { allowFail: true })
    if (u.ok) for (const p of u.stdout.split('\n').filter(Boolean)) files.push({ status: '?', path: p })
    return files
  }

  // ---------------------------------------------------------------- hooks
  async hooksDir(repo: string): Promise<string> {
    const custom = (await this.git(repo, ['config', '--get', 'core.hooksPath'], { allowFail: true })).stdout.trim()
    if (custom) return path.resolve(await this.root(repo), custom)
    return path.join(await this.commonDir(repo), 'hooks')
  }

  async hooks(repo: string): Promise<{ dir: string; hooksPath: string | null; hooks: HookInfo[] }> {
    const dir = await this.hooksDir(repo)
    const custom = (await this.git(repo, ['config', '--get', 'core.hooksPath'], { allowFail: true })).stdout.trim() || null
    let files: string[] = []
    try { files = await fsp.readdir(dir) } catch { /* no dir */ }
    const names = new Set<string>(COMMON_HOOKS)
    for (const f of files) {
      const base = f.replace(/\.(sample|disabled)$/, '')
      if (STANDARD_HOOKS.includes(base)) names.add(base)
    }
    const hooks: HookInfo[] = []
    for (const name of names) {
      const p = path.join(dir, name)
      const dis = p + '.disabled'
      const sample = p + '.sample'
      let info: HookInfo = { name, exists: false, enabled: false, sample: false, path: p, size: 0 }
      if (existsSync(p)) {
        const s = statSync(p)
        const executable = process.platform === 'win32' || (s.mode & 0o111) !== 0
        info = { name, exists: true, enabled: executable, sample: false, path: p, size: s.size }
      } else if (existsSync(dis)) {
        info = { name, exists: true, enabled: false, sample: false, path: dis, size: statSync(dis).size }
      } else if (existsSync(sample)) {
        info = { name, exists: false, enabled: false, sample: true, path: sample, size: statSync(sample).size }
      }
      hooks.push(info)
    }
    const order = (h: HookInfo) => (h.exists ? 0 : 1) * 100 + (COMMON_HOOKS.includes(h.name) ? COMMON_HOOKS.indexOf(h.name) : 50)
    hooks.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    return { dir, hooksPath: custom, hooks }
  }

  async readHook(repo: string, name: string): Promise<string> {
    const dir = await this.hooksDir(repo)
    for (const p of [name, name + '.disabled', name + '.sample']) {
      const f = path.join(dir, p)
      if (existsSync(f)) return fsp.readFile(f, 'utf8')
    }
    return '#!/bin/sh\n# ' + name + ' hook\n\nexit 0\n'
  }

  async writeHook(repo: string, name: string, content: string, enable = true): Promise<void> {
    if (!STANDARD_HOOKS.includes(name)) throw new Error(`未知钩子：${name}`)
    const dir = await this.hooksDir(repo)
    await fsp.mkdir(dir, { recursive: true })
    const target = path.join(dir, enable ? name : name + '.disabled')
    const other = path.join(dir, enable ? name + '.disabled' : name)
    await fsp.writeFile(target, content.replace(/\r\n/g, '\n'), { mode: 0o755 })
    await fsp.chmod(target, 0o755)
    if (existsSync(other)) await fsp.unlink(other)
  }

  async setHookEnabled(repo: string, name: string, enabled: boolean): Promise<void> {
    const dir = await this.hooksDir(repo)
    const on = path.join(dir, name)
    const off = on + '.disabled'
    if (enabled) {
      if (existsSync(off)) await fsp.rename(off, on)
      else if (!existsSync(on) && existsSync(on + '.sample')) await fsp.copyFile(on + '.sample', on)
      if (existsSync(on)) await fsp.chmod(on, 0o755)
    } else if (existsSync(on)) await fsp.rename(on, off)
  }

  async deleteHook(repo: string, name: string): Promise<void> {
    const dir = await this.hooksDir(repo)
    for (const p of [name, name + '.disabled']) { const f = path.join(dir, p); if (existsSync(f)) await fsp.unlink(f) }
  }

  async installHookTemplate(repo: string, id: string): Promise<string> {
    const t = HOOK_TEMPLATES.find((x) => x.id === id)
    if (!t) throw new Error('模板不存在')
    const dir = await this.hooksDir(repo)
    const existing = path.join(dir, t.hook)
    if (existsSync(existing)) await fsp.copyFile(existing, existing + `.bak-${Date.now()}`)
    await this.writeHook(repo, t.hook, t.content, true)
    return t.hook
  }

  // ---------------------------------------------------------------- misc
  async ignore(repo: string, pattern: string): Promise<void> {
    const f = path.join(repo, '.gitignore')
    let cur = ''
    try { cur = await fsp.readFile(f, 'utf8') } catch { /* new */ }
    if (cur.split(/\r?\n/).includes(pattern)) return
    await fsp.writeFile(f, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + pattern + '\n')
  }

  async config(repo: string, key: string): Promise<string> {
    return (await this.git(repo, ['config', '--get', key], { allowFail: true })).stdout.trim()
  }

  async setConfig(repo: string, key: string, value: string, global = false): Promise<void> {
    await this.git(repo, ['config', ...(global ? ['--global'] : []), key, value])
  }

  async repoInfo(repo: string): Promise<Record<string, string | boolean | number>> {
    const [name, email, gpgsign, signingkey, format, lfsAttr, lfs, submodules, shallow, sparse] = await Promise.all([
      this.config(repo, 'user.name'), this.config(repo, 'user.email'), this.config(repo, 'commit.gpgsign'),
      this.config(repo, 'user.signingkey'), this.config(repo, 'gpg.format'),
      fsp.readFile(path.join(repo, '.gitattributes'), 'utf8').catch(() => ''),
      this.git(repo, ['lfs', 'version'], { allowFail: true }).catch(() => ({ ok: false, stdout: '' })),
      this.git(repo, ['submodule', 'status'], { allowFail: true }),
      this.git(repo, ['rev-parse', '--is-shallow-repository'], { allowFail: true }),
      this.config(repo, 'core.sparseCheckout')
    ])
    return {
      userName: name, userEmail: email, gpgSign: gpgsign === 'true', signingKey: signingkey, signFormat: format || 'openpgp',
      lfsUsed: /filter=lfs/.test(lfsAttr), lfsInstalled: !!lfs.ok, submoduleCount: submodules.ok ? submodules.stdout.split('\n').filter(Boolean).length : 0,
      shallow: shallow.stdout.trim() === 'true', sparse: sparse === 'true'
    }
  }

  async submodules(repo: string): Promise<{ path: string; sha: string; state: string; describe: string }[]> {
    const r = await this.git(repo, ['submodule', 'status'], { allowFail: true })
    if (!r.ok) return []
    return r.stdout.split('\n').filter(Boolean).map((l) => {
      const m = /^([ +\-U])([0-9a-f]+) (\S+)(?: \((.*)\))?/.exec(l)
      return m ? { state: m[1].trim() || 'ok', sha: m[2], path: m[3], describe: m[4] ?? '' } : { state: '?', sha: '', path: l, describe: '' }
    })
  }

  /** Run an arbitrary git command (used by the AI natural-language→git feature after explicit user confirmation). */
  async raw(repo: string, args: string[]): Promise<{ ok: boolean; output: string }> {
    const r = await this.git(repo, args, { allowFail: true, env: this.hookEnv, timeoutMs: 10 * 60 * 1000 })
    return { ok: r.ok, output: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim() }
  }

  hookTemplates() { return HOOK_TEMPLATES }
  // ---------------------------------------------------------------- advanced (v0.4)
  async buildRebasePlan(repo: string, onto: string) { return (await import('./advanced')).buildRebasePlan(this, repo, onto) }
  async startInteractiveRebase(repo: string, plan: import('../../shared/types').RebasePlan) { return (await import('./advanced')).startInteractiveRebase(this, repo, plan) }
  async readRebaseTodo(repo: string) { return (await import('./advanced')).readRebaseTodo(this, repo) }
  async writeRebaseTodo(repo: string, todos: import('../../shared/types').RebaseTodo[]) { return (await import('./advanced')).writeRebaseTodo(this, repo, todos) }
  async bisectStatus(repo: string) { return (await import('./advanced')).bisectStatus(this, repo) }
  async bisectStart(repo: string, bad?: string, good?: string) { return (await import('./advanced')).bisectStart(this, repo, bad, good) }
  async bisectMark(repo: string, verdict: 'good' | 'bad' | 'skip', sha?: string) { return (await import('./advanced')).bisectMark(this, repo, verdict, sha) }
  async bisectReset(repo: string) { return (await import('./advanced')).bisectReset(this, repo) }
  async blame(repo: string, file: string, rev?: string) { return (await import('./advanced')).blame(this, repo, file, rev) }
  async fileHistory(repo: string, file: string, max = 100) { return (await import('./advanced')).fileHistory(this, repo, file, max) }
  async pickaxe(repo: string, query: string, opts?: { regex?: boolean; max?: number; path?: string }) { return (await import('./advanced')).pickaxe(this, repo, query, opts) }
  async compareRefs(repo: string, a: string, b: string) { return (await import('./advanced')).compareRefs(this, repo, a, b) }
  async cleanPreview(repo: string, opts?: { ignored?: boolean; dirs?: boolean }) { return (await import('./advanced')).cleanPreview(this, repo, opts) }
  async cleanApply(repo: string, paths: string[], opts?: { ignored?: boolean }) { return (await import('./advanced')).cleanApply(this, repo, paths, opts) }
  async listConfig(repo: string, scope?: 'local' | 'global' | 'system') { return (await import('./advanced')).listConfig(this, repo, scope) }
  async unsetConfig(repo: string, key: string, global = false) { return (await import('./advanced')).unsetConfig(this, repo, key, global) }
  async signingStatus(repo: string) { return (await import('./advanced')).signingStatus(this, repo) }
  async lfsStatus(repo: string) { return (await import('./advanced')).lfsStatus(this, repo) }
  async lfsPull(repo: string) { return (await import('./advanced')).lfsPull(this, repo) }
  async lfsPush(repo: string, remote = 'origin') { return (await import('./advanced')).lfsPush(this, repo, remote) }
  async lfsTrack(repo: string, pattern: string) { return (await import('./advanced')).lfsTrack(this, repo, pattern) }
  async submoduleDetails(repo: string) { return (await import('./advanced')).submoduleDetails(this, repo) }
  async submoduleRun(repo: string, action: 'init' | 'update' | 'sync' | 'deinit', paths?: string[]) { return (await import('./advanced')).submoduleRun(this, repo, action, paths) }

  // ---------------------------------------------------------------- .gitignore 可视化
  async listIgnoreSources(repo: string): Promise<import('./gitignore').IgnoreSource[]> {
    const { parseIgnoreContent } = await import('./gitignore')
    const out: import('./gitignore').IgnoreSource[] = []
    const add = async (rel: string, label: string, abs?: string) => {
      const full = abs ?? path.join(repo, rel)
      if (!existsSync(full)) return
      try {
        const text = await fsp.readFile(full, 'utf8')
        out.push({ path: abs ? full : rel.replace(/\\/g, '/'), label, lines: parseIgnoreContent(text) })
      } catch { /* */ }
    }
    await add('.gitignore', '仓库根 · .gitignore')
    try {
      const entries = await fsp.readdir(repo, { withFileTypes: true })
      for (const e of entries.slice(0, 40)) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
        const rel = `${e.name}/.gitignore`
        if (existsSync(path.join(repo, rel))) await add(rel, `子目录 · ${rel}`)
      }
    } catch { /* */ }
    try {
      const gitDir = (await this.out(repo, ['rev-parse', '--git-dir'])).trim()
      const excl = path.isAbsolute(gitDir) ? path.join(gitDir, 'info', 'exclude') : path.join(repo, gitDir, 'info', 'exclude')
      await add('info/exclude', '本仓库 · .git/info/exclude', excl)
    } catch { /* */ }
    try {
      const g = (await this.config(repo, 'core.excludesFile')).trim()
      if (g) {
        const home = process.env.HOME || process.env.USERPROFILE || ''
        const full = g.startsWith('~/') ? path.join(home, g.slice(2)) : g
        await add(g, '全局 · core.excludesFile', full)
      }
    } catch { /* */ }
    return out
  }

  async readIgnoreFile(repo: string, rel = '.gitignore'): Promise<string> {
    const full = path.join(repo, rel)
    try { return await fsp.readFile(full, 'utf8') } catch { return '' }
  }

  async writeIgnoreFile(repo: string, content: string, rel = '.gitignore'): Promise<void> {
    const safe = rel.replace(/\\/g, '/').replace(/^\/+/, '')
    if (safe.includes('..') || path.isAbsolute(rel)) throw new Error('非法路径')
    if (!(safe === '.gitignore' || safe.endsWith('/.gitignore'))) throw new Error('只能编辑 .gitignore')
    const full = path.join(repo, safe)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    const body = content.endsWith('\n') ? content : content + '\n'
    await fsp.writeFile(full, body, 'utf8')
  }

  async checkIgnorePath(repo: string, filePath: string): Promise<{
    ignored: boolean; source?: string; line?: number; pattern?: string; path?: string; explain: string
  }> {
    const { parseCheckIgnoreVerbose, explainIgnore } = await import('./gitignore')
    const target = filePath.replace(/\\/g, '/')
    const r = await this.git(repo, ['check-ignore', '-v', '--', target], { allowFail: true })
    if (!r.ok && !(r.stdout || '').trim()) {
      const empty = { ignored: false as const }
      return { ...empty, explain: explainIgnore(empty) }
    }
    const parsed = parseCheckIgnoreVerbose(r.stdout || '')
    if (!parsed.ignored && r.ok) {
      const fallback = { ignored: true, pattern: '(未知规则)' }
      return { ...fallback, explain: explainIgnore(fallback) }
    }
    return { ...parsed, explain: explainIgnore(parsed) }
  }

  /** 最近触及某文件的作者（看懂改动聚类用） */
  async fileAuthors(repo: string, files: string[], opts?: { range?: string; max?: number }): Promise<{ path: string; author: string; subject: string }[]> {
    const out: { path: string; author: string; subject: string }[] = []
    const max = Math.min(opts?.max ?? 80, 120)
    for (const f of files.slice(0, max)) {
      const args = ['log', '-1', '--pretty=format:%an%x09%s', ...(opts?.range ? [opts.range] : []), '--', f]
      const r = await this.git(repo, args, { allowFail: true })
      if (!r.ok || !r.stdout.trim()) continue
      const line = r.stdout.trim().split(/\r?\n/)[0]
      const tab = line.indexOf('\t')
      const author = (tab >= 0 ? line.slice(0, tab) : line).trim()
      const subject = tab >= 0 ? line.slice(tab + 1).trim() : ''
      if (!author) continue
      out.push({ path: f.replace(/\\/g, '/'), author, subject })
    }
    return out
  }

}

