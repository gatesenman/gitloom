// Workspace · 仓库与扫描: list all discovered repos (incl. outside / hidden), pin/unpin, hide/unhide, rescan.
import React, { useMemo, useState } from 'react'
import type { DiscoveredRepo } from '@shared/types'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Empty, useToast } from '../components/ui'
import { KIND_LABEL, RepoKindIcon } from '../components/RepoBits'
import { fuzzyScore, reposUnder } from '../lib/tree'

const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

type Filter = 'all' | 'visible' | 'hidden' | 'outside' | 'pinned'

export default function WorkspaceReposView() {
  const ctx = useApp()
  const { project, projectRepos, scope, pinned, togglePin, hideRepo, unhideRepo, rescan, setActive, setView, settings, scan } = ctx
  const toast = useToast()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const root = project?.root ?? ''
  const hidden = useMemo(() => new Set(project?.hidden ?? []), [project?.hidden])
  const pinnedSet = useMemo(() => new Set(pinned), [pinned])

  const scoped = useMemo(() => {
    if (!project) return [] as DiscoveredRepo[]
    // Include everything under scope (or whole project), including outside worktrees hanging off the tree.
    const under = reposUnder(projectRepos, scope ?? root, root)
    // Also surface any projectRepos that are outside and not already included (reposUnder may miss orphans).
    const seen = new Set(under.map((r) => r.path))
    const extras = projectRepos.filter((r) => !seen.has(r.path) && (r.outside || r.rel.startsWith('..') || hidden.has(r.path)))
    return [...under, ...extras]
  }, [project, projectRepos, scope, root, hidden])

  const counts = useMemo(() => {
    let visible = 0, hid = 0, outside = 0, pin = 0
    for (const r of scoped) {
      if (hidden.has(r.path)) hid++
      else visible++
      if (r.outside || r.rel.startsWith('..')) outside++
      if (pinnedSet.has(r.path)) pin++
    }
    return { all: scoped.length, visible, hidden: hid, outside, pinned: pin }
  }, [scoped, hidden, pinnedSet])

  const shown = useMemo(() => {
    let list = scoped
    if (filter === 'visible') list = list.filter((r) => !hidden.has(r.path))
    else if (filter === 'hidden') list = list.filter((r) => hidden.has(r.path))
    else if (filter === 'outside') list = list.filter((r) => r.outside || r.rel.startsWith('..'))
    else if (filter === 'pinned') list = list.filter((r) => pinnedSet.has(r.path))
    if (q.trim()) list = list.filter((r) => fuzzyScore(q, `${base(r.path)} ${r.rel} ${r.path} ${KIND_LABEL[r.kind] ?? ''}`) >= 0)
    return [...list].sort((a, b) => {
      const ap = pinnedSet.has(a.path) ? 0 : 1
      const bp = pinnedSet.has(b.path) ? 0 : 1
      if (ap !== bp) return ap - bp
      return (a.rel || a.path).localeCompare(b.rel || b.path, 'zh')
    })
  }, [scoped, filter, q, hidden, pinnedSet])

  if (!project) {
    return <Empty icon="scan" title="还没有项目">在左侧添加一个项目文件夹，GitLoom 会递归发现其中所有仓库。</Empty>
  }

  const open = (r: DiscoveredRepo) => {
    if (!r.initialized) return
    setActive(r.path)
    setView(r.kind === 'bare' ? 'history' : 'changes')
  }

  const scanning = !!scan && !scan.done

  return (
    <div className="dash" data-testid="workspace-repos">
      <div className="dash-head">
        <div className="dash-title">
          <Icon name="scan" size={18} />
          <h2>仓库与扫描</h2>
          <span className="muted small">{counts.all} 个已发现</span>
          <div className="flex1" />
          <div className="side-search dash-search">
            <Icon name="search" size={13} />
            <input placeholder="筛选名称 / 路径 / 类型…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="筛选仓库列表" />
          </div>
          <button className="btn btn-sm" disabled={scanning} onClick={() => rescan(scope ?? undefined)} title="重新扫描当前范围（项目或已限定文件夹）">
            <Icon name="scan" size={14} />{scanning ? '扫描中…' : '重新扫描'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setView('settings')} title="调整扫描深度与忽略列表">
            <Icon name="settings" size={14} />扫描深度 {settings?.scanDepth ?? 6}
          </button>
        </div>
        <div className="stat-chips" role="tablist" aria-label="仓库筛选">
          {([
            ['all', '全部', counts.all],
            ['visible', '可见', counts.visible],
            ['hidden', '已隐藏', counts.hidden],
            ['outside', '项目外', counts.outside],
            ['pinned', '已固定', counts.pinned]
          ] as const).map(([id, label, n]) => (
            <button key={id} type="button" className={`stat-chip sc-${id === 'all' ? 'all' : id === 'hidden' ? 'conf' : id === 'outside' ? 'behind' : id === 'pinned' ? 'ahead' : 'clean'} ${filter === id ? 'on' : ''}`}
              onClick={() => setFilter(id)} disabled={id !== 'all' && !n}>
              <b>{n}</b><span>{label}</span>
            </button>
          ))}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          管理本项目已发现的仓库：固定到侧栏、从树中隐藏、重新扫描。不含远程网络操作；扫描深度可在
          <button type="button" className="link" onClick={() => setView('settings')}>设置</button>调整。
        </p>
      </div>

      {!shown.length ? (
        <Empty icon={filter === 'all' && !q ? 'scan' : 'check'} title={filter === 'all' && !q ? '这里还没有仓库' : '没有符合条件的仓库'}
          actions={filter !== 'all' || q
            ? <button className="btn btn-sm" onClick={() => { setFilter('all'); setQ('') }}>清除筛选</button>
            : <button className="btn btn-sm btn-primary" onClick={() => rescan(scope ?? undefined)}><Icon name="scan" size={14} />扫描此文件夹</button>}>
          {filter === 'all' && !q ? '可以重新扫描，或调整设置中的扫描深度与忽略列表。' : '试试其它筛选条件。'}
        </Empty>
      ) : (
        <div className="dash-table">
          <div className="dt-head wr-head">
            <span className="c-name">仓库</span>
            <span className="c-kind">类型</span>
            <span className="c-path">相对路径</span>
            <span className="c-flags">标记</span>
            <span className="c-act">操作</span>
          </div>
          <div className="dt-body wr-body">
            {shown.map((r) => {
              const isHidden = hidden.has(r.path)
              const isPinned = pinnedSet.has(r.path)
              const outside = !!(r.outside || r.rel.startsWith('..'))
              return (
                <div key={r.path} className={`dt-row wr-row ${isHidden ? 'uninit' : ''}`}
                  onDoubleClick={() => open(r)} title={r.path}>
                  <span className="c-name">
                    <RepoKindIcon repo={r} />
                    <span className="dn">
                      <b>{base(r.path)}</b>
                      <small>{outside ? `项目外 · ${r.path}` : r.path}</small>
                    </span>
                  </span>
                  <span className="c-kind">
                    <span className={`kind-tag k-${r.kind}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>
                    {!r.initialized && <span className="bdg bdg-muted">未初始化</span>}
                  </span>
                  <span className="c-path" title={r.rel || '（项目根）'}>{r.rel || '（项目根）'}</span>
                  <span className="c-flags">
                    {isPinned && <span className="bdg bdg-ab" title="已固定"><Icon name="pin" size={10} />固定</span>}
                    {isHidden && <span className="bdg bdg-muted" title="已从树中隐藏"><Icon name="hide" size={10} />隐藏</span>}
                    {outside && <span className="bdg bdg-det" title="位于项目文件夹外">项目外</span>}
                  </span>
                  <span className="c-act wr-actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="icon-btn" title={isPinned ? '取消固定' : '固定到顶部'} aria-label={isPinned ? '取消固定' : '固定'}
                      onClick={() => togglePin(r.path)}>
                      <Icon name={isPinned ? 'unpin' : 'pin'} size={14} />
                    </button>
                    {isHidden ? (
                      <button type="button" className="icon-btn" title="取消隐藏" aria-label="取消隐藏"
                        onClick={() => { unhideRepo(r.path); toast('ok', `已显示 ${r.rel || base(r.path)}`) }}>
                        <Icon name="eye" size={14} />
                      </button>
                    ) : (
                      <button type="button" className="icon-btn" title="在树中隐藏" aria-label="隐藏"
                        onClick={() => { hideRepo(r.path); toast('info', `已隐藏 ${r.rel || base(r.path)}`, { label: '撤销', onClick: () => unhideRepo(r.path) }) }}>
                        <Icon name="hide" size={14} />
                      </button>
                    )}
                    <button type="button" className="icon-btn" title="重新扫描此路径" aria-label="重扫"
                      disabled={scanning} onClick={() => rescan(r.path)}>
                      <Icon name="scan" size={14} />
                    </button>
                    {r.initialized && (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => open(r)}>打开</button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
