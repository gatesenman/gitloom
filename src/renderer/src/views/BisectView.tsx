import React, { useCallback, useEffect, useState } from 'react'
import type { BisectState } from '@shared/types'
import { useApp } from '../state'
import { git, errMsg } from '../api'
import { Icon } from '../components/Icon'
import { Empty, Spinner, useDialog, useToast } from '../components/ui'

export default function BisectView() {
  const { active, run, refresh, status } = useApp()
  const toast = useToast()
  const dialog = useDialog()
  const [state, setState] = useState<BisectState>({ active: false, log: [] })
  const [bad, setBad] = useState('HEAD')
  const [good, setGood] = useState('')
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState('')

  const reload = useCallback(async () => {
    if (!active) return
    try { setState(await git.bisectStatus(active)) } catch (e) { toast('err', errMsg(e)) }
  }, [active, toast])

  useEffect(() => { void reload() }, [reload, status?.operation])

  const start = async () => {
    if (!active) return
    setBusy(true)
    try {
      setState(await git.bisectStart(active, bad.trim() || undefined, good.trim() || undefined))
      await refresh()
      toast('ok', '二分查找已开始')
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }

  const mark = async (v: 'good' | 'bad' | 'skip') => {
    if (!active) return
    await run(`标记 ${v}`, async () => {
      const r = await git.bisectMark(active, v)
      setOutput(r.output); setState(r.state); await refresh()
      if (/is the first bad commit/i.test(r.output)) toast('ok', '已定位到第一个坏提交！')
    })
  }

  const reset = async () => {
    if (!active) return
    if (!(await dialog({ title: '重置二分', message: '将退出二分查找并回到开始时的提交。', okText: '重置' }))) return
    await run('重置二分', async () => { await git.bisectReset(active); setState({ active: false, log: [] }); setOutput(''); await refresh() })
  }

  if (!active) return <Empty icon="search" title="未选择仓库" />

  return (
    <div className="tools-view">
      <div className="tools-head">
        <div>
          <h2><Icon name="bisect" size={18} /> 二分查错</h2>
          <p className="muted">通过标记好/坏提交，快速定位引入问题的那一次提交</p>
        </div>
        <div className="row gap">
          {state.active ? <>
            <button className="btn btn-ok" onClick={() => mark('good')}><Icon name="ok" size={14} />好的</button>
            <button className="btn btn-danger" onClick={() => mark('bad')}><Icon name="error" size={14} />坏的</button>
            <button className="btn" onClick={() => mark('skip')}><Icon name="minus" size={14} />跳过</button>
            <button className="btn" onClick={reset}>重置</button>
          </> : <>
            <label className="field-inline">坏 <input value={bad} onChange={(e) => setBad(e.target.value)} placeholder="HEAD / SHA" /></label>
            <label className="field-inline">好 <input value={good} onChange={(e) => setGood(e.target.value)} placeholder="已知好的 SHA / 标签" /></label>
            <button className="btn btn-primary" onClick={start} disabled={busy}>{busy ? <Spinner size={12} /> : <Icon name="play" size={14} />}开始</button>
          </>}
        </div>
      </div>
      {!state.active && <Empty icon="search" title="尚未开始二分">指定一个坏提交（通常是 HEAD）和一个已知好的提交，然后开始。</Empty>}
      {state.active && (
        <div className="bisect-panel">
          <div className="stat-chips">
            <span className="stat-chip">当前 <b className="mono">{state.current?.slice(0, 10) ?? '—'}</b></span>
            {state.remaining != null && <span className="stat-chip">剩余约 <b>{state.remaining}</b> 个提交</span>}
            {state.steps != null && <span className="stat-chip">大约 <b>{state.steps}</b> 步</span>}
            <span className="stat-chip">坏 <b className="mono">{state.bad?.slice(0, 10) ?? '—'}</b></span>
            <span className="stat-chip">好 <b>{state.good?.length ?? 0}</b></span>
          </div>
          {output && <pre className="bisect-out">{output}</pre>}
          <div className="bisect-log">
            <h3>标记记录</h3>
            {!state.log.length && <p className="muted">还没有标记</p>}
            {state.log.map((e, i) => (
              <div key={i} className={`bisect-log-row v-${e.verdict}`}>
                <span className={`bdg ${e.verdict === 'good' ? 'ok' : e.verdict === 'bad' ? 'err' : ''}`}>{e.verdict}</span>
                <span className="mono">{e.sha.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
