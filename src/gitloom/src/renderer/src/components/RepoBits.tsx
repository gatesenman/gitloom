// Shared repo widgets: type icons, status badges, avatar, context-menu builders.
import React from 'react'
import type { DiscoveredRepo, RepoSummary } from '@shared/types'
import type { Agg } from '../lib/tree'
import { Icon } from './Icon'
import { hashColor, type MenuItem } from './ui'

export const KIND_LABEL: Record<string, string> = { normal: '仓库', nested: '嵌套仓库', submodule: '子模块', worktree: '工作树', bare: '裸仓库' }
const TRACK_LABEL: Record<string, string> = { ignored: '父仓库已忽略此路径', untracked: '父仓库中未跟踪', gitlink: '父仓库以 gitlink 记录（无 .gitmodules）', submodule: '父仓库的子模块', tracked: '父仓库跟踪了其中的文件' }

export function repoTitle(r: DiscoveredRepo, s?: RepoSummary): string {
  const bits = [r.path, KIND_LABEL[r.kind] + (r.initialized ? '' : '（未初始化）')]
  if (r.parentTracking) bits.push(TRACK_LABEL[r.parentTracking])
  if (r.mainRepo) bits.push(`主仓库：${r.mainRepo}`)
  if (r.submodule?.url) bits.push(`URL：${r.submodule.url}`)
  if (s && !s.error) {
    if (s.detached) bits.push('分离 HEAD（不在任何分支上）')
    else if (s.branch) bits.push(`分支：${s.branch}${s.upstream ? ` → ${s.upstream}` : '（无上游分支）'}`)
    const st = [s.ahead ? `领先 ${s.ahead}（待推送）` : '', s.behind ? `落后 ${s.behind}（待拉取）` : '', s.changes ? `${s.changes} 个改动文件` : '', s.conflicts ? `${s.conflicts} 个冲突` : ''].filter(Boolean)
    bits.push(st.length ? st.join(' · ') : '干净，已同步')
  }
  if (s?.error) bits.push(`错误：${s.error}`)
  return bits.join('\n')
}

export function RepoKindIcon({ repo, size = 14 }: { repo?: DiscoveredRepo; size?: number }) {
  if (!repo) return <Icon name="folder" size={size} className="ti ti-folder" />
  const name = !repo.initialized ? 'uninit' : `repo-${repo.kind}`
  return <Icon name={name} size={size} className={`ti ti-${repo.initialized ? repo.kind : 'uninit'}`} />
}

export function RepoAvatar({ name, worktree, dirty, size }: { name: string; worktree?: boolean; dirty?: boolean; size?: number }) {
  const c = hashColor(name)
  const initials = (name.match(/[A-Za-z0-9\u4e00-\u9fa5]/g) ?? ['?']).slice(0, 1).join('').toUpperCase() + (name.split(/[-_. /]/)[1]?.[0]?.toUpperCase() ?? '')
  return (
    <div className="repo-avatar" style={{ background: `linear-gradient(140deg, ${c}, color-mix(in srgb, ${c} 70%, #000))`, ...(size ? { width: size, height: size, fontSize: size * 0.4 } : {}) }}>
      {initials}
      {worktree && <span className="wt-mark"><Icon name="worktree" size={10} strokeWidth={2.2} /></span>}
      {dirty && <span className="dot" />}
    </div>
  )
}

/** Compact status badges; `agg` for folders (rolled up), `sum` for a repo. */
export function StatusBadges({ agg, sum, repo, rolled }: { agg?: Agg; sum?: RepoSummary; repo?: DiscoveredRepo; rolled?: boolean }) {
  if (repo && !repo.initialized) return <span className="bdg bdg-muted" title="子模块未初始化">未初始化</span>
  if (sum?.error) return <span className="bdg bdg-err" title={sum.error}><Icon name="warn" size={11} /></span>
  const a = agg
  const changed = sum ? sum.changes - (sum.conflicts ?? 0) : a?.changed ?? 0
  const conflicts = sum ? sum.conflicts ?? 0 : a?.conflicts ?? 0
  const ahead = sum ? sum.ahead : a?.ahead ?? 0
  const behind = sum ? sum.behind : a?.behind ?? 0
  const detached = sum ? (sum.detached && repo?.kind !== 'submodule' ? 1 : 0) : a?.detached ?? 0
  const dsub = sum ? sum.dirtySubmodules ?? 0 : a?.dirtySub ?? 0
  const errors = a && !sum ? a.errors : 0
  const op = sum?.operation
  return (
    <span className={`bdgs ${rolled ? 'rolled' : ''}`}>
      {conflicts > 0 && <span className="bdg bdg-conf" title={`${conflicts} 个冲突${op ? ` · ${op}` : ''}`}><Icon name="warn" size={10} />{conflicts}</span>}
      {conflicts === 0 && !!op && <span className="bdg bdg-conf" title={`进行中的操作：${op}`}><Icon name="warn" size={10} />{op === 'MERGING' ? '合并中' : op === 'REBASING' ? '变基中' : op === 'CHERRY_PICKING' ? '拣选中' : op === 'REVERTING' ? '还原中' : op === 'BISECTING' ? '二分中' : op}</span>}
      {changed > 0 && <span className="bdg bdg-mod" title={rolled ? `${a?.dirty ?? 0} 个仓库共 ${changed} 个改动文件` : `${changed} 个改动文件`}>{changed}</span>}
      {ahead > 0 && <span className="bdg bdg-ab" title={`领先 ${ahead}（待推送）`}><Icon name="up" size={10} />{ahead}</span>}
      {behind > 0 && <span className="bdg bdg-ab" title={`落后 ${behind}（待拉取）`}><Icon name="down" size={10} />{behind}</span>}
      {!rolled && sum && !sum.detached && sum.branch && sum.upstream === null && !sum.bare && !sum.isWorktree && <span className="bdg bdg-muted bdg-noup" title="没有上游分支：这个分支还没推送过，或没有关联远程分支">无上游</span>}
      {detached > 0 && <span className="bdg bdg-det" title={rolled ? `${detached} 个仓库处于分离 HEAD` : '分离 HEAD'}>HEAD{rolled && detached > 1 ? ` ${detached}` : ''}</span>}
      {dsub > 0 && <span className="bdg bdg-sub" title={`${dsub} 个子模块有改动`}><Icon name="repo-submodule" size={10} />{dsub}</span>}
      {errors > 0 && <span className="bdg bdg-err" title={`${errors} 个仓库不可用`}><Icon name="warn" size={10} />{errors}</span>}
    </span>
  )
}

export interface RepoActionCtx {
  run: <T>(label: string, fn: () => Promise<T>, okText?: string) => Promise<T | undefined>
  togglePin: (p: string) => void
  pinned: string[]
  hideRepo: (p: string) => void
  rescan: (sub?: string) => void
  toast: (k: 'ok' | 'err' | 'info', t: string, a?: { label: string; onClick: () => void }) => void
  unhideRepo: (p: string) => void
  refreshSummaries: (paths?: string[]) => Promise<void>
}

export const openItems = (p: string): MenuItem[] => [
  { label: '在终端中打开', icon: 'terminal', onClick: () => window.api.openTerminal(p) },
  { label: '在文件管理器中打开', icon: 'folder-open', onClick: () => window.api.openPath(p) },
  { label: '在编辑器中打开', icon: 'code', onClick: () => window.api.openInEditor(p) }
]

export function repoMenu(r: DiscoveredRepo, root: string, c: RepoActionCtx, gitApi: { fetch: (p: string) => Promise<unknown>; pull: (p: string) => Promise<unknown>; push: (p: string) => Promise<unknown>; raw: (p: string, cmd: string) => Promise<{ ok: boolean; output: string }> }): MenuItem[] {
  const copy = (t: string) => { void navigator.clipboard.writeText(t); c.toast('ok', `已复制：${t}`) }
  const done = (p: string) => () => void c.refreshSummaries([p])
  if (!r.initialized) {
    return [
      { label: r.rel || r.path, header: true },
      { label: '初始化子模块（submodule update --init）', icon: 'download', disabled: !r.parent, onClick: async () => { const rel = r.path.slice(r.parent!.length + 1).replace(/\\/g, '/'); const res = await c.run('初始化子模块', () => gitApi.raw(r.parent!, `git submodule update --init -- ${rel}`)); if (res?.ok) { c.toast('ok', '子模块已初始化'); c.rescan(r.parent) } else if (res) c.toast('err', res.output) } },
      { sep: true },
      { label: '复制路径', icon: 'copy', onClick: () => copy(r.path) }
    ]
  }
  const pinned = c.pinned.includes(r.path)
  return [
    ...openItems(r.path),
    { sep: true },
    { label: '抓取', icon: 'fetch', disabled: r.kind === 'bare' && false, onClick: () => c.run('抓取', () => gitApi.fetch(r.path), '抓取完成').then(done(r.path)) },
    { label: '拉取', icon: 'pull', disabled: r.kind === 'bare', onClick: () => c.run('拉取', () => gitApi.pull(r.path), '拉取完成').then(done(r.path)) },
    { label: '推送', icon: 'push', disabled: r.kind === 'bare', onClick: () => c.run('推送', () => gitApi.push(r.path), '推送完成').then(done(r.path)) },
    { sep: true },
    { label: pinned ? '取消固定' : '固定到顶部', icon: pinned ? 'unpin' : 'pin', onClick: () => c.togglePin(r.path) },
    { label: '复制路径', icon: 'copy', onClick: () => copy(r.path) },
    { label: '复制相对路径', icon: 'copy', disabled: !r.rel, onClick: () => copy(r.rel) },
    { label: '重新扫描此文件夹', icon: 'scan', onClick: () => c.rescan(r.path) },
    { sep: true },
    { label: '在树中隐藏', icon: 'hide', danger: true, onClick: () => { c.hideRepo(r.path); c.toast('info', `已隐藏 ${r.rel || r.path}`, { label: '撤销', onClick: () => c.unhideRepo(r.path) }) } }
  ]
}
