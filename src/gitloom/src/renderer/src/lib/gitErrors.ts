// Plain-Chinese explanations for the git errors people hit every day, with a suggested one-click fix.
// Used by run() toasts (state.tsx), the overview bulk log (Dashboard) and tests/gitErrors.test.ts.

export type GitFix =
  | 'pushSetUpstream'   // git push -u origin <branch>
  | 'pullRebase'        // git pull --rebase
  | 'pull'              // git pull (merge)
  | 'stash'             // stash local changes then retry
  | 'openChanges'       // go to 变更 to resolve conflicts / commit
  | 'newBranch'         // create a branch here (detached HEAD)
  | 'openRemotes'       // check remote URL / credentials
  | 'retry'

export interface GitErrorInfo {
  kind: 'auth' | 'network' | 'nonFastForward' | 'diverged' | 'noUpstream' | 'detached' | 'conflict' | 'dirty' | 'lock' | 'notFound' | 'other'
  title: string
  hint: string
  fix?: GitFix
  fixLabel?: string
}

const FIX_LABEL: Record<GitFix, string> = {
  pushSetUpstream: '推送并设置上游', pullRebase: '变基拉取', pull: '拉取合并', stash: '储藏后重试',
  openChanges: '去处理', newBranch: '在此建分支', openRemotes: '检查远程', retry: '重试'
}

const R = (kind: GitErrorInfo['kind'], title: string, hint: string, fix?: GitFix): GitErrorInfo => ({ kind, title, hint, fix, fixLabel: fix ? FIX_LABEL[fix] : undefined })

export function explainGitError(raw: string): GitErrorInfo | null {
  const s = raw || ''
  if (/Authentication failed|could not read Username|Permission denied \(publickey|invalid username or password|HTTP Basic: Access denied|403 Forbidden|The requested URL returned error: 40[13]|terminal prompts disabled|access denied|Invalid credentials/i.test(s))
    return R('auth', '身份验证失败', '远程拒绝了你的凭据：HTTPS 请检查用户名和个人访问令牌（不是登录密码），SSH 请确认公钥已添加到平台。', 'openRemotes')
  if (/Could not resolve host|Failed to connect|Connection (refused|timed out|reset)|unable to access .*(timed out|Couldn't connect)|Network is unreachable|Operation timed out|early EOF|RPC failed|Could not read from remote repository/i.test(s))
    return R('network', '连接不到远程仓库', '网络不通或远程地址有误。检查网络 / 代理 / VPN，或确认远程 URL 是否正确。', 'retry')
  if (/has no upstream branch|no upstream configured|There is no tracking information for the current branch/i.test(s))
    return R('noUpstream', '当前分支还没有上游分支', '这个分支还没推送过或没有关联远程分支。推送时加 -u 即可自动关联。', 'pushSetUpstream')
  if (/You are not currently on a branch|HEAD detached|detached HEAD/i.test(s))
    return R('detached', '处于“分离 HEAD”状态', '你检出的是某个提交而不是分支，新的提交不属于任何分支。建议先在这里建一个分支。', 'newBranch')
  if (/Not possible to fast-forward|Diverging branches can't be fast-forwarded|have diverged|fatal: Need to specify how to reconcile divergent branches/i.test(s))
    return R('diverged', '本地和远程分叉了', '双方都有对方没有的提交，无法快进。可以“变基拉取”把你的提交接到远程之后（历史更直），或“拉取合并”生成一个合并提交。', 'pullRebase')
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected|failed to push some refs/i.test(s))
    return R('nonFastForward', '推送被拒绝：远程有你没有的新提交', '先把远程的新提交拉下来（推荐变基拉取），再推送。不要随意强制推送。', 'pullRebase')
  if (/CONFLICT|Merge conflict|fix conflicts|unmerged files|needs merge|You have unmerged paths|Resolve all conflicts/i.test(s))
    return R('conflict', '有合并冲突需要处理', '同一处代码被两边都改了。在「变更」里逐个文件选择保留哪一边，解决后提交或继续操作。', 'openChanges')
  if (/Your local changes to the following files would be overwritten|Please commit your changes or stash them|cannot pull with rebase: You have unstaged changes|untracked working tree files would be overwritten|contains modified or untracked files/i.test(s))
    return R('dirty', '本地有未提交的改动挡住了', '这次操作会覆盖你尚未提交的文件。先提交，或“储藏后重试”（改动会安全保存在储藏里）。', 'stash')
  if (/index\.lock|Unable to create .*\.lock|Another git process seems to be running/i.test(s))
    return R('lock', 'Git 正被其他程序占用', '另一个 Git 进程（IDE、终端或崩溃残留）锁住了仓库。等它结束后重试；确认没有 Git 在运行时可删除 .git/index.lock。', 'retry')
  if (/repository .* not found|does not appear to be a git repository|Repository not found/i.test(s))
    return R('notFound', '远程仓库不存在或无权访问', '检查远程 URL 是否正确，以及你的账号是否有这个仓库的权限。', 'openRemotes')
  return null
}

/** One-line summary for compact logs (bulk results). */
export function shortGitError(raw: string): string {
  const e = explainGitError(raw)
  if (e) return `${e.title} — ${e.hint}`
  const line = (raw || '').split('\n').map((l) => l.trim()).find((l) => /^(fatal|error):/i.test(l)) ?? (raw || '').trim().split('\n')[0] ?? ''
  return line.replace(/^(fatal|error):\s*/i, '').slice(0, 200)
}

/** Plain-Chinese one-liner for a successful pull (instead of git's last output line). */
export function pullSummary(out: string, behind = 0): string {
  if (/Already up to date|已经是最新/i.test(out)) return '已是最新'
  const m = out.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/)
  const head = behind > 0 ? `已快进 ${behind} 个提交` : '已更新'
  return m ? `${head} · ${m[1]} 个文件（+${m[2] ?? 0} −${m[3] ?? 0}）` : head
}
