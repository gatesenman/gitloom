import type { AIProfile,
  AppSettings, BranchInfo, CommitDetail, CommitInfo, DiffContents, FileDiff, HookInfo, HookTemplate, RemoteInfo,
  RepoStatus, RepoSummary, StashInfo, TagInfo, WorktreeInfo, WorkspaceState, CommandLogEntry, AIAction
} from '@shared/types'

const call = <T,>(m: string, ...a: unknown[]) => window.api.git(m, ...a) as Promise<T>

export type DiffSource = { kind: 'unstaged' } | { kind: 'staged' } | { kind: 'commit'; sha: string; parent?: string } | { kind: 'stash'; index: number }

export const git = {
  version: () => call<string>('version'),
  isRepo: (p: string) => call<boolean>('isRepo', p),
  discover: (p: string, depth: number) => call<string[]>('discover', p, depth),
  init: (p: string) => call<void>('init', p),
  clone: (url: string, dir: string, opts?: { depth?: number }) => call<void>('clone', url, dir, opts ?? {}),
  summary: (r: string) => call<RepoSummary>('summary', r),
  status: (r: string) => call<RepoStatus>('status', r),
  stage: (r: string, p: string[]) => call<void>('stage', r, p),
  stageAll: (r: string) => call<void>('stageAll', r),
  unstage: (r: string, p: string[]) => call<void>('unstage', r, p),
  unstageAll: (r: string) => call<void>('unstageAll', r),
  discard: (r: string, p: string[]) => call<void>('discard', r, p),
  fileDiff: (r: string, f: string, staged: boolean) => call<FileDiff | null>('fileDiff', r, f, staged),
  applyHunk: (r: string, f: string, h: number, action: 'stage' | 'unstage' | 'discard', lines?: number[]) => call<void>('applyHunk', r, f, h, action, lines),
  diffContents: (r: string, f: string, src: DiffSource, orig?: string) => call<DiffContents>('diffContents', r, f, src, orig),
  commit: (r: string, msg: string, o: { amend?: boolean; signoff?: boolean; noVerify?: boolean }) => call<string>('commit', r, msg, o),
  lastCommitMessage: (r: string) => call<string>('lastCommitMessage', r),
  log: (r: string, o: { limit?: number; all?: boolean; grep?: string; file?: string; ref?: string; range?: string } = {}) => call<CommitInfo[]>('log', r, o),
  commitDetail: (r: string, sha: string) => call<CommitDetail>('commitDetail', r, sha),
  reflog: (r: string) => call<{ sha: string; selector: string; subject: string; date: number }[]>('reflog', r),
  branches: (r: string) => call<BranchInfo[]>('branches', r),
  createBranch: (r: string, name: string, start?: string, checkout = true) => call<void>('createBranch', r, name, start, checkout),
  checkout: (r: string, ref: string) => call<void>('checkout', r, ref),
  deleteBranch: (r: string, n: string, force = false) => call<void>('deleteBranch', r, n, force),
  deleteRemoteBranch: (r: string, remote: string, n: string) => call<void>('deleteRemoteBranch', r, remote, n),
  renameBranch: (r: string, a: string, b: string) => call<void>('renameBranch', r, a, b),
  merge: (r: string, ref: string, o: { noFf?: boolean; squash?: boolean } = {}) => call<string>('merge', r, ref, o),
  rebase: (r: string, onto: string) => call<string>('rebase', r, onto),
  cherryPick: (r: string, sha: string) => call<void>('cherryPick', r, sha),
  revert: (r: string, sha: string) => call<void>('revert', r, sha),
  reset: (r: string, sha: string, mode: 'soft' | 'mixed' | 'hard') => call<void>('reset', r, sha, mode),
  continueOp: (r: string) => call<void>('continueOp', r),
  abortOp: (r: string) => call<void>('abortOp', r),
  resolveWith: (r: string, f: string, side: 'ours' | 'theirs') => call<void>('resolveWith', r, f, side),
  conflictVersions: (r: string, f: string) => call<{ base: string; ours: string; theirs: string; merged: string }>('conflictVersions', r, f),
  tags: (r: string) => call<TagInfo[]>('tags', r),
  createTag: (r: string, n: string, sha?: string, msg?: string) => call<void>('createTag', r, n, sha, msg),
  deleteTag: (r: string, n: string) => call<void>('deleteTag', r, n),
  remoteTags: (r: string, remote?: string) => call<{ name: string; sha: string }[]>('remoteTags', r, remote),
  pushTag: (r: string, n: string, remote?: string) => call<string>('pushTag', r, n, remote),
  deleteRemoteTag: (r: string, n: string, remote?: string) => call<string>('deleteRemoteTag', r, n, remote),
  remotes: (r: string) => call<RemoteInfo[]>('remotes', r),
  addRemote: (r: string, n: string, url: string) => call<void>('addRemote', r, n, url),
  removeRemote: (r: string, n: string) => call<void>('removeRemote', r, n),
  fetch: (r: string, remote?: string) => call<string>('fetch', r, remote),
  pull: (r: string, rebase = false, ffOnly = false) => call<string>('pull', r, { rebase, ffOnly }),
  push: (r: string, o: { force?: boolean; setUpstream?: boolean; remote?: string; branch?: string; tags?: boolean } = {}) => call<string>('push', r, o),
  worktrees: (r: string) => call<WorktreeInfo[]>('worktrees', r),
  addWorktree: (r: string, dir: string, o: { branch?: string; newBranch?: string; base?: string; detach?: boolean }) => call<void>('addWorktree', r, dir, o),
  removeWorktree: (r: string, dir: string, force = false) => call<void>('removeWorktree', r, dir, force),
  pruneWorktrees: (r: string) => call<void>('pruneWorktrees', r),
  lockWorktree: (r: string, dir: string, lock: boolean, reason?: string) => call<void>('lockWorktree', r, dir, lock, reason),
  stashes: (r: string) => call<StashInfo[]>('stashes', r),
  stashPush: (r: string, msg: string, o: { includeUntracked?: boolean; keepIndex?: boolean; staged?: boolean }) => call<void>('stashPush', r, msg, o),
  stashApply: (r: string, i: number, pop = false) => call<void>('stashApply', r, i, pop),
  stashDrop: (r: string, i: number) => call<void>('stashDrop', r, i),
  stashFiles: (r: string, i: number) => call<{ path: string; status: string }[]>('stashFiles', r, i),
  hooks: (r: string) => call<{ dir: string; hooksPath: string | null; hooks: HookInfo[] }>('hooks', r),
  readHook: (r: string, n: string) => call<string>('readHook', r, n),
  writeHook: (r: string, n: string, c: string, enable = true) => call<void>('writeHook', r, n, c, enable),
  setHookEnabled: (r: string, n: string, e: boolean) => call<void>('setHookEnabled', r, n, e),
  deleteHook: (r: string, n: string) => call<void>('deleteHook', r, n),
  installHookTemplate: (r: string, id: string) => call<string>('installHookTemplate', r, id),
  hookTemplates: () => call<HookTemplate[]>('hookTemplates'),
  ignore: (r: string, pattern: string) => call<void>('ignore', r, pattern),
  listIgnoreSources: (r: string) => call<{ path: string; label: string; lines: { line: number; raw: string; pattern?: string; negated?: boolean; comment?: boolean; blank?: boolean }[] }[]>('listIgnoreSources', r),
  readIgnoreFile: (r: string, rel?: string) => call<string>('readIgnoreFile', r, rel),
  writeIgnoreFile: (r: string, content: string, rel?: string) => call<void>('writeIgnoreFile', r, content, rel),
  checkIgnorePath: (r: string, filePath: string) => call<{ ignored: boolean; source?: string; line?: number; pattern?: string; path?: string; explain: string }>('checkIgnorePath', r, filePath),
  fileAuthors: (r: string, files: string[], opts?: { range?: string; max?: number }) => call<{ path: string; author: string; subject: string }[]>('fileAuthors', r, files, opts),
  config: (r: string, k: string) => call<string>('config', r, k),
  setConfig: (r: string, k: string, v: string, global = false) => call<void>('setConfig', r, k, v, global),
  repoInfo: (r: string) => call<Record<string, string | boolean | number>>('repoInfo', r),
  submodules: (r: string) => call<{ path: string; sha: string; state: string; describe: string }[]>('submodules', r),
  buildRebasePlan: (r: string, onto: string) => call<import('@shared/types').RebasePlan>('buildRebasePlan', r, onto),
  startInteractiveRebase: (r: string, plan: import('@shared/types').RebasePlan) => call<void>('startInteractiveRebase', r, plan),
  readRebaseTodo: (r: string) => call<import('@shared/types').RebaseTodo[]>('readRebaseTodo', r),
  writeRebaseTodo: (r: string, todos: import('@shared/types').RebaseTodo[]) => call<void>('writeRebaseTodo', r, todos),
  bisectStatus: (r: string) => call<import('@shared/types').BisectState>('bisectStatus', r),
  bisectStart: (r: string, bad?: string, good?: string) => call<import('@shared/types').BisectState>('bisectStart', r, bad, good),
  bisectMark: (r: string, v: 'good' | 'bad' | 'skip', sha?: string) => call<{ output: string; state: import('@shared/types').BisectState }>('bisectMark', r, v, sha),
  bisectReset: (r: string) => call<void>('bisectReset', r),
  blame: (r: string, f: string, rev?: string) => call<import('@shared/types').BlameLine[]>('blame', r, f, rev),
  fileHistory: (r: string, f: string, max?: number) => call<import('@shared/types').FileHistoryEntry[]>('fileHistory', r, f, max),
  pickaxe: (r: string, q: string, o?: { regex?: boolean; max?: number; path?: string }) => call<import('@shared/types').PickaxeHit[]>('pickaxe', r, q, o),
  compareRefs: (r: string, a: string, b: string) => call<{ ahead: number; behind: number; commits: { hash: string; short: string; subject: string; author: string; date: number }[]; files: { path: string; status: string; additions: number; deletions: number }[] }>('compareRefs', r, a, b),
  cleanPreview: (r: string, o?: { ignored?: boolean }) => call<import('@shared/types').CleanEntry[]>('cleanPreview', r, o),
  cleanApply: (r: string, paths: string[], o?: { ignored?: boolean }) => call<void>('cleanApply', r, paths, o),
  listConfig: (r: string, scope?: 'local' | 'global' | 'system') => call<import('@shared/types').ConfigEntry[]>('listConfig', r, scope),
  unsetConfig: (r: string, k: string, g?: boolean) => call<void>('unsetConfig', r, k, g),
  signingStatus: (r: string) => call<import('@shared/types').SigningStatus>('signingStatus', r),
  lfsStatus: (r: string) => call<import('@shared/types').LfsStatus>('lfsStatus', r),
  lfsPull: (r: string) => call<string>('lfsPull', r),
  lfsPush: (r: string, remote?: string) => call<string>('lfsPush', r, remote),
  lfsTrack: (r: string, pattern: string) => call<void>('lfsTrack', r, pattern),
  submoduleDetails: (r: string) => call<import('@shared/types').SubmoduleDetail[]>('submoduleDetails', r),
  submoduleRun: (r: string, action: 'init' | 'update' | 'sync' | 'deinit', paths?: string[]) => call<string>('submoduleRun', r, action, paths)
}

let streamSeq = 0
const newReqId = (): string => `ai-${Date.now().toString(36)}-${++streamSeq}`
const abortErr = (): Error => { const e = new Error('已停止生成'); e.name = 'AbortError'; return e }
/**
 * Run one AI IPC call. With `onDelta`, subscribes to `ai:chunk` events for this request id while pending.
 * With `signal`, aborting sends `ai:cancel` (main aborts the HTTP stream), stops delivering chunks and rejects at once.
 */
async function withStream<T = string>(call: (reqId: string | undefined) => Promise<T>, onDelta?: (full: string) => void, signal?: AbortSignal): Promise<T> {
  if (!onDelta && !signal) return call(undefined)
  if (signal?.aborted) throw abortErr()
  const reqId = newReqId()
  let full = ''
  let dead = false
  const off = onDelta ? window.api.onAIChunk((e) => { if (!dead && e.reqId === reqId) { full += e.delta; onDelta(full) } }) : () => undefined
  let onAbort: (() => void) | undefined
  try {
    const p = call(reqId)
    if (!signal) return await p
    p.catch(() => undefined)                       // the cancelled IPC rejects later; we already settled
    return await Promise.race([p, new Promise<never>((_, rej) => {
      onAbort = () => { dead = true; void window.api.aiCancel(reqId); rej(abortErr()) }
      signal.addEventListener('abort', onAbort, { once: true })
    })])
  } finally { dead = true; off(); if (onAbort) signal?.removeEventListener('abort', onAbort) }
}

export const app = {
  settings: () => window.api.settings() as Promise<AppSettings>,
  setSettings: (s: AppSettings) => window.api.setSettings(s) as Promise<AppSettings>,
  workspace: () => window.api.workspace() as Promise<WorkspaceState>,
  setWorkspace: (w: WorkspaceState) => window.api.setWorkspace(w) as Promise<void>,
  pickFolder: (t?: string) => window.api.pickFolder(t) as Promise<string | null>,
  commandLog: () => window.api.commandLog() as Promise<CommandLogEntry[]>,
  ai: (a: AIAction, repo: string, payload?: Record<string, string | undefined>) => window.api.ai(a, repo, payload) as Promise<string>,
  /** streamed variant: onDelta receives text as it arrives (every protocol streams over SSE) */
  aiStream: (a: AIAction, repo: string, payload: Record<string, string | undefined> = {}, onDelta?: (full: string) => void, signal?: AbortSignal) =>
    withStream((reqId) => window.api.ai(a, repo, { ...payload, reqId }) as Promise<string>, onDelta, signal),
  aiModels: (profile?: AIProfile, signal?: AbortSignal) => withStream((reqId) => window.api.aiModels(profile, reqId), undefined, signal),
  aiTest: (profile?: AIProfile, signal?: AbortSignal) => withStream((reqId) => window.api.aiTest(profile, reqId), undefined, signal),
  gitRaw: (repo: string, cmd: string) => window.api.gitRaw(repo, cmd) as Promise<{ ok: boolean; output: string }>,
  aiChat: (messages: import('@shared/types').AIChatMessage[], repo?: string, onDelta?: (full: string) => void, signal?: AbortSignal) =>
    withStream((reqId) => window.api.aiChat(messages, repo, reqId) as Promise<string>, onDelta, signal),
  forgeDetect: (repo: string) => window.api.forgeDetect(repo) as Promise<import('@shared/types').ForgeRemote | null>,
  forgePRs: (repo: string) => window.api.forgePRs(repo) as Promise<import('@shared/types').ForgePR[]>,
  forgeIssues: (repo: string) => window.api.forgeIssues(repo) as Promise<import('@shared/types').ForgeIssue[]>,
  forgeCreatePR: (repo: string, input: { title: string; body?: string; head: string; base: string; draft?: boolean }) => window.api.forgeCreatePR(repo, input) as Promise<import('@shared/types').ForgePR>
}

export type VizProgressEvent = { reqId?: string; phase: string; done: number; total: number; text: string }
type Snip = { lines: { t: ' ' | '+' | '-' | '@'; text: string; b?: number; a?: number }[]; changed: boolean }
/** 变更可视化: analysis + AI run with progress events and cancel (same ai:cancel inflight map as the other AI calls). */
async function withProgress<T>(call: (reqId: string) => Promise<T>, onProgress?: (p: VizProgressEvent) => void, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw abortErr()
  const reqId = `viz-${Date.now().toString(36)}-${++streamSeq}`
  let dead = false
  const off = window.api.onVizProgress((e) => { if (!dead && e.reqId === reqId) onProgress?.(e) })
  let onAbort: (() => void) | undefined
  try {
    const p = call(reqId)
    if (!signal) return await p
    p.catch(() => undefined)
    return await Promise.race([p, new Promise<never>((_, rej) => {
      onAbort = () => { dead = true; void window.api.aiCancel(reqId); rej(abortErr()) }
      signal.addEventListener('abort', onAbort, { once: true })
    })])
  } finally { dead = true; off(); if (onAbort) signal?.removeEventListener('abort', onAbort) }
}
export const viz = {
  analyze: (req: import('@shared/viz').VizRequest, onProgress?: (p: VizProgressEvent) => void, signal?: AbortSignal) =>
    withProgress((reqId) => window.api.vizAnalyze(req, reqId) as Promise<import('@shared/viz').VizResult>, onProgress, signal),
  ai: (id: string, onProgress?: (p: VizProgressEvent) => void, signal?: AbortSignal) =>
    withProgress((reqId) => window.api.vizAI(id, reqId) as Promise<import('@shared/viz').VizAIResult & { cached?: boolean; attempts?: number }>, onProgress, signal),
  tour: (id: string, question: string, onProgress?: (p: VizProgressEvent) => void, signal?: AbortSignal) =>
    withProgress((reqId) => window.api.vizTour(id, question, reqId) as Promise<import('@shared/viz').Tour & { cached?: boolean; attempts?: number }>, onProgress, signal),
  aiInfo: (id?: string) => window.api.vizAIInfo(id),
  snippet: (id: string, o: { before?: { file: string; line: number; endLine?: number }; after?: { file: string; line: number; endLine?: number } }) => window.api.vizSnippet(id, o) as Promise<Snip>,
  contents: (id: string, before?: string, after?: string) => window.api.vizContents(id, before, after),
  patch: (id: string, file: string, oldFile?: string) => window.api.vizPatch(id, file, oldFile),
  save: (name: string, data: string, encoding?: 'utf8' | 'base64') => window.api.vizSave(name, data, encoding)
}

export function errMsg(e: unknown): string {
  const m = (e as Error)?.message ?? String(e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** 0.6.4 体检报告 */
let healthSeq = 0
export const health = {
  run: (opts: import('@shared/health').HealthRunOptions, signal?: AbortSignal) => {
    if (signal?.aborted) { const e = new Error('已取消'); e.name = 'AbortError'; return Promise.reject(e) }
    const reqId = opts.reqId || `health-${Date.now().toString(36)}-${++healthSeq}`
    const p = window.api.healthRun({ ...opts, reqId }) as Promise<import('@shared/health').HealthReport>
    if (!signal) return p
    p.catch(() => undefined)
    return Promise.race([p, new Promise<never>((_, rej) => {
      const onAbort = () => { void window.api.healthCancel(reqId); void window.api.aiCancel?.(reqId); const e = new Error('已取消'); e.name = 'AbortError'; rej(e) }
      signal.addEventListener('abort', onAbort, { once: true })
    })])
  },
  list: (repo: string) => window.api.healthList(repo) as Promise<import('@shared/health').HealthReportMeta[]>,
  get: (repo: string, id: string) => window.api.healthGet(repo, id) as Promise<import('@shared/health').HealthReport | null>,
  latest: (repo: string) => window.api.healthLatest(repo) as Promise<import('@shared/health').HealthReport | null>,
  export: (repo: string, id: string, format: 'markdown' | 'json') => window.api.healthExport(repo, id, format) as Promise<string | null>,
  setFindingStatus: (repo: string, reportId: string, findingId: string, status: import('@shared/health').FindingStatus) =>
    window.api.healthSetFindingStatus(repo, reportId, findingId, status) as Promise<import('@shared/health').HealthReport | null>,
  cancel: (reqId: string) => window.api.healthCancel(reqId) as Promise<void>
}
