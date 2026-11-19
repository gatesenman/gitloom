import React, { useCallback, useEffect, useState } from 'react'
import type { SubmoduleDetail } from '@shared/types'
import { useApp } from '../state'
import { git, errMsg } from '../api'
import { Icon } from '../components/Icon'
import { Empty, Spinner, useDialog, useToast } from '../components/ui'

export default function SubmodulesView() {
  const { active, run, setActive, addRepos, project } = useApp()
  const toast = useToast()
  const dialog = useDialog()
  const [list, setList] = useState<SubmoduleDetail[]>([])
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    if (!active) return
    setBusy(true)
    try { setList(await git.submoduleDetails(active)) }
    catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }, [active, toast])

  useEffect(() => { void load() }, [load])

  const paths = [...sel]
  const act = async (action: 'init' | 'update' | 'sync' | 'deinit') => {
    if (!active) return
    if (action === 'deinit' && !(await dialog({ title: '反初始化子模块', message: paths.length ? `反初始化 ${paths.length} 个子模块？` : '反初始化全部子模块？', danger: true, okText: '反初始化' }))) return
    await run(`submodule ${action}`, async () => {
      await git.submoduleRun(active, action, paths.length ? paths : undefined)
      await load()
    }, '完成')
  }

  if (!active) return <Empty icon="repo-submodule" title="未选择仓库" />

  return (
    <div className="tools-view">
      <div className="tools-head">
        <div>
          <h2><Icon name="repo-submodule" size={18} /> 子模块</h2>
          <p className="muted">{list.length} 个 · 支持嵌套更新（--recursive）</p>
        </div>
        <div className="row gap">
          <button className="btn" onClick={() => void act('init')} disabled={!paths.length && !list.some((s) => s.state === 'uninitialized')}>Init</button>
          <button className="btn btn-primary" onClick={() => void act('update')}><Icon name="download" size={14} />Update</button>
          <button className="btn" onClick={() => void act('sync')}>Sync</button>
          <button className="btn btn-danger" onClick={() => void act('deinit')}>Deinit</button>
          <button className="btn" onClick={() => void load()} disabled={busy}>{busy ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}</button>
        </div>
      </div>
      {!list.length && !busy && <Empty icon="repo-submodule" title="没有子模块">此仓库未声明 .gitmodules。</Empty>}
      <div className="submod-list">
        {list.map((s) => {
          const full = active.replace(/[\\/]+$/, '') + '/' + s.path
          return (
            <label key={s.path} className={`submod-row st-${s.state}`}>
              <input type="checkbox" checked={sel.has(s.path)} onChange={(e) => setSel((x) => { const n = new Set(x); if (e.target.checked) n.add(s.path); else n.delete(s.path); return n })} />
              <Icon name="repo-submodule" size={14} />
              <div className="flex1">
                <div><b>{s.name}</b> <span className="muted mono">{s.path}</span></div>
                <div className="muted">{s.url || '—'} · {s.describe || s.sha.slice(0, 10) || '未初始化'}</div>
              </div>
              <span className={`kind-tag st-${s.state}`}>{
                s.state === 'ok' ? '正常' : s.state === 'uninitialized' ? '未初始化' : s.state === 'modified' ? '有改动' : s.state === 'conflict' ? '冲突' : s.state
              }</span>
              {s.state !== 'uninitialized' && (
                <button className="btn btn-sm" onClick={async (e) => {
                  e.preventDefault()
                  if (project) await addRepos([full])
                  setActive(full)
                }}>打开</button>
              )}
            </label>
          )
        })}
      </div>
    </div>
  )
}
