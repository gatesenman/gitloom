import React, { useEffect, useState } from 'react'
import { useApp, type View } from '../state'
import { git } from '../api'
import { Icon } from './Icon'
import { usePersistentState } from './ui'
import { BRANCH_SECTIONS, STORIES, advancedOf, visibleAdvanced, storyOf, introKey } from '../lib/nav'

const subCache = new Map<string, number>()
/** Last known submodule count for a repo (undefined if not probed yet). */
export const knownSubmoduleCount = (repo: string | null) => (repo ? subCache.get(repo) : undefined)
/** Number of submodules declared by the active repo (null while unknown). */
export function useSubmoduleCount(repo: string | null): number | null {
  const [n, setN] = useState<number | null>(repo ? subCache.get(repo) ?? null : null)
  useEffect(() => {
    if (!repo) { setN(null); return }
    let live = true
    setN(subCache.get(repo) ?? null)
    git.submodules(repo).then((l) => l.length, () => 0).then((c) => { subCache.set(repo, c); if (live) setN(c) })
    return () => { live = false }
  }, [repo])
  return n
}

/**
 * 0.6.5-hotfix.1: flat secondary tabs (no 「更多 ▾」).
 * Renders BRANCH_SECTIONS extras (储藏/工作树) + ADVANCED entries as peer nav-items.
 */
export function AdvancedTabs() {
  const { view, setView, active, status } = useApp()
  const subs = useSubmoduleCount(active)
  const currentAdv = advancedOf(view === 'blame' ? 'tools' : view)
  const items = visibleAdvanced({ submoduleCount: subs })
  const branchExtras = BRANCH_SECTIONS.filter((s) => s.id !== 'branches')
  return (
    <>
      {branchExtras.map((s) => (
        <button key={s.id} role="tab" aria-selected={view === s.id} disabled={!active}
          className={`nav-item ${view === s.id ? 'active' : ''}`} onClick={() => setView(s.id)} title={s.tip} data-view={s.id}>
          <Icon name={s.icon} size={14} /><span>{s.label}</span>
          {s.id === 'stash' && !!status?.stashCount && <em className="nav-count">{status.stashCount}</em>}
        </button>
      ))}
      {items.map((a) => {
        const on = currentAdv?.id === a.id
        return (
          <button key={a.id} role="tab" aria-selected={on} disabled={!active}
            className={`nav-item ${on ? 'active' : ''}`} onClick={() => setView(a.id)} title={`${a.label}：${a.desc}`} data-view={a.id}>
            <Icon name={a.icon} size={14} /><span>{a.short}</span>
            {a.id === 'submodules' && !!subs && <em className="nav-count muted">{subs}</em>}
          </button>
        )
      })}
    </>
  )
}

/** @deprecated 0.6.5-hotfix.1 — kept as alias so old imports fail loudly nowhere; prefer AdvancedTabs. */
export const MoreMenu = AdvancedTabs

/** Dismissible intro at the top of each non-everyday view: what it is + a plain-Chinese user story, 「知道了」 to hide. */
export function ViewIntro({ id }: { id: View }) {
  const a = storyOf(id)
  const [dismissed, setDismissed] = usePersistentState<boolean>(introKey(id), false)
  useEffect(() => {
    const h = () => setDismissed(false)
    window.addEventListener('gitloom:intros-reset', h)
    return () => window.removeEventListener('gitloom:intros-reset', h)
  }, [setDismissed])
  if (!a || dismissed) return null
  return (
    <div className="view-intro" role="note" aria-label={`${a.label} 简介`}>
      <span className="vi-ic"><Icon name={a.icon} size={18} /></span>
      <div className="vi-txt">
        <b>{a.label}</b>
        <p><span className="vi-k">是什么</span>{a.desc}。</p>
        <p><span className="vi-k">什么时候用</span>“{a.story}”</p>
      </div>
      <button className="btn btn-sm" onClick={() => setDismissed(true)} title="不再显示这段说明（可在命令面板「重新显示功能简介」恢复）">知道了</button>
    </div>
  )
}

export function resetIntros() {
  for (const a of STORIES) localStorage.removeItem(introKey(a.id))
  window.dispatchEvent(new Event('gitloom:intros-reset'))
}

/** @deprecated 0.6.5-hotfix.1 — 储藏/工作树已平铺到顶栏；保留空壳以免外部引用炸。 */
export function BranchSubnav() {
  return null
}
