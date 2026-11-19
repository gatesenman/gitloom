import React, { useCallback, useEffect, useState } from 'react'
import type { RebasePlan, RebaseTodoAction } from '@shared/types'
import { useApp } from '../state'
import { git, errMsg } from '../api'
import { Icon } from '../components/Icon'
import { Empty, Spinner, useDialog, useToast } from '../components/ui'

const ACTIONS: { id: RebaseTodoAction; label: string; hint: string }[] = [
  { id: 'pick', label: 'pick', hint: '保留' },
  { id: 'reword', label: 'reword', hint: '改信息' },
  { id: 'edit', label: 'edit', hint: '停下来改' },
  { id: 'squash', label: 'squash', hint: '压缩并编辑' },
  { id: 'fixup', label: 'fixup', hint: '压缩静默' },
  { id: 'drop', label: 'drop', hint: '丢弃' }
]

export default function RebaseView() {
  const { active, run, status, refresh } = useApp()
  const toast = useToast()
  const dialog = useDialog()
  const [onto, setOnto] = useState('main')
  const [plan, setPlan] = useState<RebasePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<number | null>(null)
  const inProgress = status?.operation === 'REBASING'

  const loadInProgress = useCallback(async () => {
    if (!active || !inProgress) return
    try {
      const todos = await git.readRebaseTodo(active)
      setPlan({ onto: '', upstream: '', todos, inProgress: true })
    } catch { /* */ }
  }, [active, inProgress])

  useEffect(() => { void loadInProgress() }, [loadInProgress])

  const build = async () => {
    if (!active) return
    setBusy(true)
    try {
      const p = await git.buildRebasePlan(active, onto.trim())
      if (!p.todos.length) { toast('info', '没有需要对齐的提交'); setPlan(null); return }
      setPlan(p)
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }

  const setAction = (i: number, action: RebaseTodoAction) => {
    if (!plan) return
    setPlan({ ...plan, todos: plan.todos.map((t, k) => k === i ? { ...t, action } : t) })
  }

  const onDrop = (to: number) => {
    if (drag === null || !plan || drag === to) { setDrag(null); return }
    const todos = [...plan.todos]
    const [item] = todos.splice(drag, 1)
    todos.splice(to, 0, item)
    setPlan({ ...plan, todos })
    setDrag(null)
  }

  const start = async () => {
    if (!active || !plan) return
    if (!(await dialog({ title: '开始交互式变基', message: `将 ${plan.todos.filter((t) => t.action !== 'drop').length} 个提交变基到 ${plan.onto}。如有冲突会暂停。`, okText: '开始' }))) return
    await run('交互式变基', async () => {
      await git.startInteractiveRebase(active, plan)
      await refresh(); await loadInProgress()
    }, '变基已启动')
  }

  const saveTodo = async () => {
    if (!active || !plan) return
    await run('保存计划', async () => { await git.writeRebaseTodo(active, plan.todos) }, '已更新变基计划')
  }

  const cont = async () => {
    if (!active) return
    await run('继续变基', async () => { await git.continueOp(active); await refresh(); await loadInProgress() })
  }

  const abort = async () => {
    if (!active) return
    if (!(await dialog({ title: '中止变基', message: '工作区将恢复到变基开始前的状态。', okText: '中止', danger: true }))) return
    await run('中止变基', async () => { await git.abortOp(active); setPlan(null); await refresh() })
  }

  if (!active) return <Empty icon="branch" title="未选择仓库" />

  return (
    <div className="tools-view rebase-view">
      <div className="tools-head">
        <div>
          <h2><Icon name="rebase" size={18} /> 整理提交</h2>
          <p className="muted">拖拽重排 · 修改动作 · 有冲突时在「变更」中解决后继续</p>
        </div>
        <div className="row gap">
          {inProgress ? <>
            <button className="btn btn-primary" onClick={cont}><Icon name="play" size={14} />继续</button>
            <button className="btn" onClick={saveTodo} disabled={!plan}>保存计划</button>
            <button className="btn btn-danger" onClick={abort}><Icon name="x" size={14} />中止</button>
          </> : <>
            <label className="field-inline">变基到 <input value={onto} onChange={(e) => setOnto(e.target.value)} placeholder="main / origin/main / SHA" /></label>
            <button className="btn" onClick={build} disabled={busy}>{busy ? <Spinner size={12} /> : <Icon name="list" size={14} />}生成计划</button>
            <button className="btn btn-primary" onClick={start} disabled={!plan?.todos.length}><Icon name="play" size={14} />开始变基</button>
          </>}
        </div>
      </div>
      {!plan?.todos.length && <Empty icon="commit" title={inProgress ? '正在读取变基计划…' : '先生成计划'}>选择目标分支后点击「生成计划」，再拖拽调整提交顺序与动作。</Empty>}
      {!!plan?.todos.length && (
        <div className="rebase-list" role="list">
          {plan.todos.map((t, i) => (
            <div key={`${t.sha}-${i}`} className={`rebase-row ${t.action} ${drag === i ? 'dragging' : ''}`} draggable
              onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(i)} role="listitem">
              <span className="grip" title="拖拽排序"><Icon name="grip" size={14} /></span>
              <span className="sha mono">{t.sha.slice(0, 7)}</span>
              <select value={t.action} onChange={(e) => setAction(i, e.target.value as RebaseTodoAction)} aria-label="变基动作">
                {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label} — {a.hint}</option>)}
              </select>
              <span className="subj flex1">{t.subject}</span>
              <button className="icon-btn xs" title="丢弃" onClick={() => setAction(i, 'drop')}><Icon name="trash" size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
