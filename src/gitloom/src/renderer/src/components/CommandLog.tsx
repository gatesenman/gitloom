import React, { useEffect, useState } from 'react'
import type { CommandLogEntry } from '@shared/types'
import { app } from '../api'
import { Icon } from './Icon'

export default function CommandLog({ onClose }: { onClose: () => void }) {
  const [log, setLog] = useState<CommandLogEntry[]>([])
  useEffect(() => {
    void app.commandLog().then((l) => setLog(l.slice().reverse()))
    return window.api.onGitLog((e) => setLog((l) => [e as CommandLogEntry, ...l].slice(0, 300)))
  }, [])
  return (
    <div className="cmdlog">
      <div className="cmdlog-head"><Icon name="log" size={13} /><b>Git 命令日志</b><span className="muted">GitLoom 执行的每一条 git 命令都会记录在这里</span><div className="flex1" /><button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}><Icon name="x" /></button></div>
      <div className="cmdlog-body">
        {log.filter((e) => !['status', 'rev-list', 'rev-parse'].includes(e.args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? '')).map((e) => (
          <div key={e.id} className={`cl-row ${e.code ? 'fail' : ''}`}>
            <span className="cl-time">{new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <code>git {e.args.filter((a, i, arr) => !(a === '-c' || arr[i - 1] === '-c')).join(' ')}</code>
            <span className="muted">{e.ms}ms</span>
            {e.code !== 0 && <span className="err">退出码 {e.code}{e.stderr ? `：${e.stderr.split('\n')[0]}` : ''}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
