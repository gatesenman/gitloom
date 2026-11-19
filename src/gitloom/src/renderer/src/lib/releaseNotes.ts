/** 标签与发布：从近期提交生成白话中文发布说明草稿（纯函数，无网络） */

export type ReleaseCommit = {
  short: string
  subject: string
  author?: string
  date?: number
}

export type ReleaseNotesInput = {
  tagName: string
  /** 相对上一标签 / 起点的说明，可空 */
  sinceLabel?: string
  commits: ReleaseCommit[]
  /** 仓库短名，可选 */
  repoName?: string
}

/** 去掉 conventional 前缀，方便中文阅读 */
export function plainSubject(subject: string): string {
  const s = subject.trim()
  const m = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?:\s*/i.exec(s)
  if (!m) return s
  const kind = m[1].toLowerCase()
  const map: Record<string, string> = {
    feat: '新功能', fix: '修复', docs: '文档', style: '样式', refactor: '重构',
    perf: '性能', test: '测试', build: '构建', ci: '持续集成', chore: '杂项', revert: '回滚'
  }
  const rest = s.slice(m[0].length).trim()
  return `${map[kind] ?? kind}：${rest || s}`
}

/** 生成 Markdown 发布说明草稿（中文白话） */
export function buildReleaseNotesDraft(input: ReleaseNotesInput): string {
  const { tagName, sinceLabel, commits, repoName } = input
  const lines: string[] = [
    `# ${tagName} 发布说明（草稿）`,
    '',
    repoName ? `- 仓库：${repoName}` : '',
    `- 标签：\`${tagName}\``,
    sinceLabel ? `- 相对：${sinceLabel}` : '',
    `- 提交数：${commits.length}`,
    '',
    '## 本版改动',
    ''
  ].filter((x) => x !== '')

  if (!commits.length) {
    lines.push('（这段时间没有新的提交，可以手动补几句说明。）', '')
  } else {
    for (const c of commits) {
      lines.push(`- ${plainSubject(c.subject)}（\`${c.short}\`${c.author ? ` · ${c.author}` : ''}）`)
    }
    lines.push('')
  }
  lines.push('## 升级提示', '', '- （可选）写一下有没有破坏性改动、需要改配置的地方。', '', '---', '_由 GitLoom「标签与发布」根据近期提交自动生成，发布前请人工过一遍。_')
  return lines.join('\n')
}

/** 解析 `git ls-remote --tags` 输出；优先使用剥皮后的对象 SHA */
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

export type TagPresence = 'local' | 'remote' | 'both'

export function mergeTagPresence(
  local: { name: string; sha: string }[],
  remote: { name: string; sha: string }[]
): { name: string; localSha?: string; remoteSha?: string; presence: TagPresence }[] {
  const map = new Map<string, { name: string; localSha?: string; remoteSha?: string; presence: TagPresence }>()
  for (const t of local) map.set(t.name, { name: t.name, localSha: t.sha, presence: 'local' })
  for (const t of remote) {
    const cur = map.get(t.name)
    if (cur) {
      cur.remoteSha = t.sha
      cur.presence = 'both'
    } else {
      map.set(t.name, { name: t.name, remoteSha: t.sha, presence: 'remote' })
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}
