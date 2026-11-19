// Pure parsers for git CLI output. No electron / fs dependencies so they are unit-testable.
import type {
  BranchInfo, CommitInfo, DiffHunk, DiffLine, FileChange, FileDiff, FileStatusCode,
  RepoStatus, StashInfo, TagInfo, WorktreeInfo, RemoteInfo
} from '../../shared/types'

export const FS = '\x1f'
export const RS = '\x1e'

/** Parse `git status --porcelain=v2 --branch -z` output. */
export function parseStatusV2(out: string): Omit<RepoStatus, 'operation' | 'stashCount'> {
  const st: Omit<RepoStatus, 'operation' | 'stashCount'> = {
    branch: null, detached: false, headSha: null, upstream: null, ahead: 0, behind: 0,
    staged: [], unstaged: [], conflicted: []
  }
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('# ')) {
      const [, key, ...rest] = p.split(' ')
      const val = rest.join(' ')
      if (key === 'branch.oid') st.headSha = val === '(initial)' ? null : val
      else if (key === 'branch.head') {
        if (val === '(detached)') st.detached = true
        else st.branch = val
      } else if (key === 'branch.upstream') st.upstream = val
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val)
        if (m) { st.ahead = +m[1]; st.behind = +m[2] }
      }
      continue
    }
    const kind = p[0]
    if (kind === '1' || kind === '2') {
      const f = p.split(' ')
      const xy = f[1]
      const sub = f[2]
      const n = kind === '1' ? 8 : 9
      const path = f.slice(n).join(' ')
      let origPath: string | undefined
      if (kind === '2') { origPath = parts[++i] }
      const change: FileChange = {
        path, origPath, index: xy[0] === '.' ? ' ' : (xy[0] as FileStatusCode),
        worktree: xy[1] === '.' ? ' ' : (xy[1] as FileStatusCode), conflicted: false, untracked: false,
        submodule: sub[0] === 'S'
      }
      if (change.index !== ' ') st.staged.push(change)
      if (change.worktree !== ' ') st.unstaged.push(change)
    } else if (kind === 'u') {
      const f = p.split(' ')
      const path = f.slice(10).join(' ')
      st.conflicted.push({ path, index: 'U', worktree: 'U', conflicted: true, untracked: false })
    } else if (kind === '?') {
      st.unstaged.push({ path: p.slice(2), index: ' ', worktree: '?', conflicted: false, untracked: true })
    }
  }
  return st
}

export const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%at', '%D', '%s', '%G?'].join('%x1f') + '%x1e'

export function parseLog(out: string): CommitInfo[] {
  return out.split(RS).map((r) => r.replace(/^\n+/, '')).filter(Boolean).map((r) => {
    const [hash, short, parents, author, email, date, refs, subject, sig] = r.split(FS)
    return {
      hash, short, parents: parents ? parents.split(' ').filter(Boolean) : [], author, email,
      date: Number(date), refs: refs ? refs.split(', ').map((s) => s.trim()).filter(Boolean) : [],
      subject: subject ?? '', signature: (sig ?? '').trim() || undefined
    }
  })
}

export const BRANCH_FORMAT = ['%(refname)', '%(refname:short)', '%(objectname)', '%(upstream:short)',
  '%(upstream:track)', '%(HEAD)', '%(committerdate:unix)', '%(contents:subject)'].join('%1f')

export function parseBranches(out: string): BranchInfo[] {
  return out.split('\n').filter(Boolean).map((l) => {
    const [fullRef, name, sha, upstream, track, head, date, subject] = l.split(FS)
    const ahead = /ahead (\d+)/.exec(track ?? '')
    const behind = /behind (\d+)/.exec(track ?? '')
    return {
      name, fullRef, sha, remote: fullRef.startsWith('refs/remotes/'), current: head === '*',
      upstream: upstream || null, ahead: ahead ? +ahead[1] : 0, behind: behind ? +behind[1] : 0,
      date: Number(date) || 0, subject: subject ?? ''
    }
  }).filter((b) => !(b.remote && b.name.endsWith('/HEAD')) && b.fullRef !== 'refs/remotes/origin/HEAD')
}

export const TAG_FORMAT = ['%(refname:short)', '%(objectname)', '%(*objectname)', '%(objecttype)',
  '%(creatordate:unix)', '%(contents:subject)'].join('%1f')

export function parseTags(out: string): TagInfo[] {
  return out.split('\n').filter(Boolean).map((l) => {
    const [name, obj, deref, type, date, subject] = l.split(FS)
    return { name, sha: deref || obj, annotated: type === 'tag', date: Number(date) || 0, subject: subject ?? '' }
  })
}

export function parseRemotes(out: string): RemoteInfo[] {
  const map = new Map<string, RemoteInfo>()
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(line)
    if (!m) continue
    const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' }
    if (m[3] === 'fetch') r.fetchUrl = m[2]; else r.pushUrl = m[2]
    map.set(m[1], r)
  }
  return [...map.values()]
}

/** Parse `git worktree list --porcelain`. */
export function parseWorktrees(out: string, currentPath?: string): WorktreeInfo[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const blocks = out.split(/\n\n+/).map((b) => b.trim()).filter(Boolean)
  return blocks.map((b, i) => {
    const wt: WorktreeInfo = {
      path: '', head: null, branch: null, bare: false, detached: false, locked: false,
      prunable: false, isMain: i === 0, isCurrent: false
    }
    for (const line of b.split('\n')) {
      const [k, ...rest] = line.split(' ')
      const v = rest.join(' ')
      if (k === 'worktree') wt.path = v
      else if (k === 'HEAD') wt.head = v
      else if (k === 'branch') wt.branch = v.replace(/^refs\/heads\//, '')
      else if (k === 'bare') wt.bare = true
      else if (k === 'detached') wt.detached = true
      else if (k === 'locked') { wt.locked = true; if (v) wt.lockReason = v }
      else if (k === 'prunable') wt.prunable = true
    }
    if (currentPath) wt.isCurrent = norm(wt.path) === norm(currentPath)
    return wt
  })
}

export function parseStashes(out: string): StashInfo[] {
  return out.split('\n').filter(Boolean).map((l, index) => {
    const [ref, sha, date, message] = l.split(FS)
    return { index, ref, sha, date: Number(date) || 0, message: message ?? '' }
  })
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/** Parse unified diff output (possibly multiple files). */
export function parseDiff(out: string): FileDiff[] {
  const files: FileDiff[] = []
  let cur: FileDiff | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  const lines = out.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      cur = { headerLines: [line], oldPath: m?.[1] ?? '', newPath: m?.[2] ?? '', binary: false, hunks: [] }
      files.push(cur)
      hunk = null
      continue
    }
    if (!cur) continue
    const hm = HUNK_RE.exec(line)
    if (hm) {
      hunk = {
        header: line, oldStart: +hm[1], oldLines: hm[2] === undefined ? 1 : +hm[2],
        newStart: +hm[3], newLines: hm[4] === undefined ? 1 : +hm[4], lines: []
      }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      cur.hunks.push(hunk)
      continue
    }
    if (!hunk) {
      cur.headerLines.push(line)
      if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) cur.binary = true
      if (line.startsWith('--- ') && line !== '--- /dev/null') cur.oldPath = line.slice(6)
      if (line.startsWith('+++ ') && line !== '+++ /dev/null') cur.newPath = line.slice(6)
      continue
    }
    let dl: DiffLine
    const c = line[0]
    if (c === '+') dl = { type: 'add', text: line.slice(1), newNo: newNo++ }
    else if (c === '-') dl = { type: 'del', text: line.slice(1), oldNo: oldNo++ }
    else if (c === '\\') dl = { type: 'meta', text: line }
    else dl = { type: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ }
    hunk.lines.push(dl)
  }
  return files
}

/**
 * Build a patch for a single hunk (optionally a subset of its lines) suitable for `git apply`.
 * @param selected indexes into hunk.lines that should be applied; undefined = whole hunk
 * @param reverse true when the patch will be applied with --reverse (unstage / discard staged).
 *   For forward application the "old" side must match the target, so unselected '-' lines become context
 *   and unselected '+' lines are dropped. For reverse it is the other way round.
 */
export function buildHunkPatch(file: FileDiff, hunkIndex: number, selected?: Set<number>, reverse = false): string | null {
  const hunk = file.hunks[hunkIndex]
  if (!hunk) return null
  const header = file.headerLines
  const out: string[] = []
  let oldCount = 0
  let newCount = 0
  let changed = 0
  let prevDropped = false
  hunk.lines.forEach((l, i) => {
    const isSel = !selected || selected.has(i)
    if (l.type === 'meta') {
      // "\ No newline at end of file" applies to the preceding line; keep only if that line was kept
      if (!prevDropped) out.push(l.text)
      return
    }
    prevDropped = false
    if (l.type === 'context') { out.push(' ' + l.text); oldCount++; newCount++; return }
    if (l.type === 'add') {
      if (isSel) { out.push('+' + l.text); newCount++; changed++ }
      else if (reverse) { out.push(' ' + l.text); oldCount++; newCount++ }
      else prevDropped = true
      return
    }
    // del
    if (isSel) { out.push('-' + l.text); oldCount++; changed++ }
    else if (!reverse) { out.push(' ' + l.text); oldCount++; newCount++ }
    else prevDropped = true
  })
  if (changed === 0) return null
  // Anchor on the side that matches the target (old side forward, new side reverse).
  const rel = (anchorStart: number, anchorCount: number, otherCount: number): number => {
    if (anchorCount === 0) return anchorStart + 1
    if (otherCount === 0) return Math.max(0, anchorStart - 1)
    return anchorStart
  }
  let hh: string
  if (!reverse) hh = `@@ -${hunk.oldStart},${oldCount} +${rel(hunk.oldStart, oldCount, newCount)},${newCount} @@`
  else hh = `@@ -${rel(hunk.newStart, newCount, oldCount)},${oldCount} +${hunk.newStart},${newCount} @@`
  return [...header, hh, ...out].join('\n') + '\n'
}

export function langFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? ''
  const base = p.split('/').pop()?.toLowerCase() ?? ''
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', md: 'markdown', markdown: 'markdown', py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
    sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
    xml: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', sql: 'sql', vue: 'html',
    lua: 'lua', dart: 'dart', r: 'r', scala: 'scala', graphql: 'graphql', proto: 'proto'
  }
  return map[ext] ?? 'plaintext'
}

/** Minimal shell-like argument splitter (supports quotes) for NL→git suggestions. */
export function splitArgs(cmd: string): string[] {
  const args: string[] = []
  let cur = ''
  let q: string | null = null
  let has = false
  for (const ch of cmd.trim()) {
    if (q) { if (ch === q) q = null; else cur += ch; continue }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue }
    if (/\s/.test(ch)) { if (cur || has) { args.push(cur); cur = ''; has = false } continue }
    cur += ch
  }
  if (cur || has) args.push(cur)
  return args
}

/** `git ls-remote --tags` → unique tag names; prefer peeled object SHA */
export function parseLsRemoteTags(out: string): { name: string; sha: string }[] {
  const peeled = new Map<string, string>()
  const raw = new Map<string, string>()
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{7,40})\s+refs\/tags\/(.+)$/i.exec(line.trim())
    if (!m) continue
    const sha = m[1]
    let name = m[2]
    const isPeeled = name.endsWith('^{}')
    if (isPeeled) name = name.slice(0, -3)
    if (isPeeled) peeled.set(name, sha)
    else if (!raw.has(name)) raw.set(name, sha)
  }
  const names = new Set([...peeled.keys(), ...raw.keys()])
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({
    name,
    sha: peeled.get(name) ?? raw.get(name)!
  }))
}

