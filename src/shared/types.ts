// Shared types between main / preload / renderer.

export type FileStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | 'T' | '!'

export interface FileChange {
  path: string
  origPath?: string
  /** status in index (staged) */
  index: FileStatusCode | ' '
  /** status in worktree (unstaged) */
  worktree: FileStatusCode | ' '
  conflicted: boolean
  untracked: boolean
  submodule?: boolean
}

export interface RepoStatus {
  branch: string | null
  detached: boolean
  headSha: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  conflicted: FileChange[]
  /** MERGING | REBASING | CHERRY-PICKING | REVERTING | BISECTING | null */
  operation: string | null
  stashCount: number
}

export interface RepoSummary {
  path: string
  name: string
  branch: string | null
  changes: number
  ahead: number
  behind: number
  isWorktree: boolean
  error?: string
  /** extended fields (multi-repo workspace) */
  detached?: boolean
  conflicts?: number
  staged?: number
  dirtySubmodules?: number
  upstream?: string | null
  operation?: string | null
  bare?: boolean
  lastCommit?: { sha: string; subject: string; date: number; author: string } | null
  updatedAt?: number
}

// ---------------------------------------------------------------- multi-repo projects
export type RepoKind = 'normal' | 'nested' | 'submodule' | 'worktree' | 'bare'

/** Raw scan hit (filesystem facts only) — finalized into DiscoveredRepo by classifyRepos(). */
export interface RawRepo {
  path: string
  /** how .git looks: directory, gitfile → worktree / absorbed submodule / other, or a bare repository dir */
  git: 'dir' | 'worktree' | 'modules' | 'gitfile' | 'bare'
  /** for gitfile repos: resolved git dir; for worktrees: the main repository root */
  gitDir?: string
  mainRepo?: string
  /** submodules declared in this repo's .gitmodules */
  gitmodules?: { name: string; path: string; url?: string }[]
  /** linked worktrees registered in this repo (.git/worktrees/x/gitdir) */
  worktrees?: string[]
}

export interface DiscoveredRepo {
  path: string
  /** path relative to the project root ('' = the root itself; may start with '..' for outside worktrees) */
  rel: string
  kind: RepoKind
  /** enclosing repository (nested repo / submodule) */
  parent?: string
  /** main repository of a linked worktree */
  mainRepo?: string
  /** false for declared-but-uninitialized submodules */
  initialized: boolean
  /** linked worktree that lives outside the project folder */
  outside?: boolean
  /** how the enclosing repo sees this path */
  parentTracking?: 'ignored' | 'untracked' | 'gitlink' | 'submodule' | 'tracked'
  submodule?: { name: string; url?: string }
}

export interface Project {
  id: string
  name: string
  root: string
  repos: DiscoveredRepo[]
  /** repo paths hidden from the tree */
  hidden: string[]
  scannedAt?: number
  /** created from a legacy flat repo list (no automatic scanning) */
  manual?: boolean
}

export interface ScanOptions { maxDepth: number; ignore: string[]; followSymlinks?: boolean }
export interface ScanProgress { scanId: string; dirs: number; found: number; current: string; done: boolean; cancelled?: boolean; error?: string; repos?: DiscoveredRepo[]; root: string; sub?: string; watchDirs?: number }
export interface WatchEvent { root: string; kind: 'structure' | 'status'; path: string }

export interface CommitInfo {
  hash: string
  short: string
  parents: string[]
  author: string
  email: string
  date: number // unix seconds
  refs: string[]
  subject: string
  body?: string
  signature?: string // %G? code
}

export interface BranchInfo {
  name: string
  fullRef: string
  remote: boolean
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  sha: string
  subject: string
  date: number
}

export interface TagInfo {
  name: string
  sha: string
  subject: string
  date: number
  annotated: boolean
}

export interface RemoteInfo {
  name: string
  fetchUrl: string
  pushUrl: string
}

export interface WorktreeInfo {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
  locked: boolean
  lockReason?: string
  prunable: boolean
  isMain: boolean
  isCurrent: boolean
}

export interface StashInfo {
  index: number
  ref: string
  message: string
  sha: string
  date: number
}

export interface HookInfo {
  name: string
  exists: boolean
  enabled: boolean
  sample: boolean
  path: string
  size: number
}

export interface HookTemplate {
  id: string
  name: string
  hook: string
  description: string
  content: string
}

export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'meta'
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  /** raw "diff --git" header lines up to (excluding) the first @@ */
  headerLines: string[]
  oldPath: string
  newPath: string
  binary: boolean
  hunks: DiffHunk[]
}

export interface DiffContents {
  original: string
  modified: string
  binary: boolean
  language: string
  tooLarge?: boolean
}

export interface CommitDetail extends CommitInfo {
  files: { path: string; status: string; origPath?: string; additions: number; deletions: number }[]
}

export interface CommandLogEntry {
  id: number
  cwd: string
  args: string[]
  code: number
  ms: number
  at: number
  stderr?: string
}

/** One saved AI provider connection (key encrypted at rest with safeStorage). */
export interface AIProfile {
  id: string
  name: string
  /** id from AI_PRESETS (src/shared/aiProviders.ts) */
  preset: string
  protocol: 'openai' | 'anthropic' | 'azure'
  /** openai/anthropic: API base; azure: resource endpoint (https://xxx.openai.azure.com) */
  baseUrl: string
  apiKey: string
  /** default model of this profile (azure: ignored, the deployment decides) */
  model: string
  azureDeployment?: string
  azureApiVersion?: string
  /** extra request headers (e.g. OpenRouter attribution) */
  headers?: Record<string, string>
  /** last model list fetched from the provider */
  models?: string[]
}

/** AI tasks that can each use their own profile/model. */
export type AITask = 'commit' | 'review' | 'explain' | 'chat'

export interface AISettings {
  /** legacy single endpoint — mirrors the active OpenAI-compatible profile (used for LLMWIKI_* hook env) */
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  language: 'zh' | 'en'
  commitStyle: 'conventional' | 'simple' | 'gitmoji'
  profiles?: AIProfile[]
  activeProfile?: string
  /** per-task override; empty = active profile & its default model */
  tasks?: Partial<Record<AITask, { profile?: string; model?: string }>>
  /** profile ids tried in order when the primary fails (network / 5xx / rate limit / model missing) */
  fallback?: string[]
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  ai: AISettings
  diffMode: 'split' | 'inline'
  /** collapse long unchanged regions in diffs (default true) */
  diffFoldUnchanged?: boolean
  graphLimit: number
  autoFetchMinutes: number
  gitPath: string
  scanDepth: number
  /** pass AI settings to hooks via env (LLMWIKI_*) when GitLoom runs git commit */
  aiEnvForHooks: boolean
  fontSize: number
  /** folders skipped while scanning (basename or simple * glob) */
  scanIgnore?: string[]
  density?: 'comfortable' | 'compact'
  /** max concurrent git processes for bulk operations / summaries */
  concurrency?: number
  watch?: boolean
  /** forge tokens (GitHub / GitLab) — encrypted at rest like the AI key */
  forge?: ForgeSettings
  /** remember last AI chat sessions (metadata only; messages live in renderer) */
  aiChatPersist?: boolean
}

export interface WorkspaceState {
  /** legacy flat list (v0.1) — migrated into a manual project */
  repos: string[]
  active: string | null
  projects?: Project[]
  activeProject?: string | null
  pinned?: string[]
  recent?: string[]
}

export type AIAction =
  | 'commitMessage'
  | 'explainDiff'
  | 'reviewStaged'
  | 'branchName'
  | 'nlToGit'
  | 'prDescription'
  | 'conflictHelp'
  | 'designReview'

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

// ---------------------------------------------------------------- advanced git (v0.4)
export type RebaseTodoAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop' | 'break'

export interface RebaseTodo {
  action: RebaseTodoAction
  sha: string
  subject: string
}

export interface RebasePlan {
  onto: string
  upstream: string
  todos: RebaseTodo[]
  /** when true, rebase is currently in progress */
  inProgress?: boolean
  /** path of the written plan (for continue) */
  planFile?: string
}

export interface BisectState {
  active: boolean
  bad?: string
  good?: string[]
  current?: string
  remaining?: number
  steps?: number
  log: { sha: string; verdict: 'good' | 'bad' | 'skip'; at: number }[]
}

export interface BlameLine {
  sha: string
  author: string
  date: number
  line: string
  originalLine: number
  filename?: string
}

export interface FileHistoryEntry {
  hash: string
  short: string
  author: string
  date: number
  subject: string
  status?: string
}

export interface PickaxeHit {
  hash: string
  short: string
  author: string
  date: number
  subject: string
  /** files that matched */
  files: string[]
}

export interface CleanEntry {
  path: string
  kind: 'untracked' | 'ignored'
  isDir: boolean
  /** nested git repo (will be skipped unless force) */
  nestedRepo?: boolean
}

export interface ConfigEntry {
  key: string
  value: string
  scope: 'local' | 'global' | 'system'
}

export interface LfsFile {
  path: string
  size: number
  oid?: string
  tracked: boolean
  pointer: boolean
}

export interface LfsStatus {
  installed: boolean
  version?: string
  used: boolean
  files: LfsFile[]
  trackedPatterns: string[]
}

export interface SubmoduleDetail {
  name: string
  path: string
  url?: string
  sha: string
  state: 'ok' | 'uninitialized' | 'modified' | 'untracked' | 'conflict'
  describe: string
  branch?: string
  dirty?: boolean
}

export interface SigningStatus {
  gpgSign: boolean
  signingKey: string
  format: 'openpgp' | 'ssh' | 'x509' | string
  userName: string
  userEmail: string
  gpgAvailable: boolean
  sshAvailable: boolean
  hint?: string
}

// ---------------------------------------------------------------- forge (GitHub / GitLab)
export type ForgeKind = 'github' | 'gitlab'

export interface ForgeSettings {
  githubToken: string
  gitlabToken: string
  gitlabBaseUrl: string
}

export interface ForgePR {
  id: number
  number: number
  title: string
  state: string
  url: string
  author: string
  head: string
  base: string
  draft?: boolean
  updatedAt: string
  ci?: 'success' | 'pending' | 'failure' | 'neutral' | unknown
}

export interface ForgeIssue {
  id: number
  number: number
  title: string
  state: string
  url: string
  author: string
  labels: string[]
  updatedAt: string
}

export interface ForgeRemote {
  kind: ForgeKind
  owner: string
  repo: string
  host: string
  url: string
}

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIChatSession {
  id: string
  title: string
  repo?: string
  messages: AIChatMessage[]
  updatedAt: number
}
