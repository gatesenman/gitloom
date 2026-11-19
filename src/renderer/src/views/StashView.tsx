import React, { useEffect, useState } from 'react'
import type { StashInfo } from '@shared/types'
import { errMsg, git } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { DiffPane } from '../components/DiffPane'
import { Empty, Resizer, StatusBadge, relTime, useDialog, useToast, usePersistentState } from '../components/ui'

export default function StashView() {
  const { active, run, tick, status } = useApp()
  const repo = active!
  const dialog = useDialog()
  const toast = useToast()
  const [list, setList] = useState<StashInfo[]>([])
  const [sel, setSel] = useState<number | null>(null)
  const [files, setFiles] = useState<{ path: string; status: string }[]>([])
  const [file, setFile] = useState<string | null>(null)
  const [w, setW] = usePersistentState('gitloom.stash.w', 420)

  useEffect(() => { git.stashes(repo).then((l) => { setList(l); if (sel !== null && sel >= l.length) setSel(null) }).catch((e) => toast('err', errMsg(e))) // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, status?.stashCount, tick % 5 === 0 ? tick : 0])
  useEffect(() => {
    if (sel === null) { setFiles([]); setFile(null); return }
    git.stashFiles(repo, sel).then((f) => { setFiles(f); setFile(f[0]?.path ?? null) }).catch(() => setFiles([]))
  }, [repo, sel, list])

  const create = async () => {
    const r = await dialog({ title: '储藏当前改动', fields: [
      { name: 'msg', label: '说明（可选）', placeholder: 'WIP: 登录页' },
      { name: 'untracked', label: '包含未跟踪文件', type: 'checkbox', value: true },
      { name: 'keepIndex', label: '保留暂存区（--keep-index）', type: 'checkbox' },
      { name: 'staged', label: '仅储藏已暂存的改动（--staged）', type: 'checkbox' }
    ], okText: '储藏' })
    if (r) await run('储藏', () => git.stashPush(repo, String(r.msg || ''), { includeUntracked: !!r.untracked, keepIndex: !!r.keepIndex, staged: !!r.staged }), '已储藏')
  }

  const s = sel !== null ? list[sel] : null
  return (
    <div className="split">
      <div className="pane-left" style={{ width: w }}>
        <div className="pane-toolbar">
          <b>储藏</b><span className="muted">{list.length} 个</span><div className="flex1" />
          <button className="btn btn-sm btn-primary" disabled={!status || (status.staged.length + status.unstaged.length === 0)} onClick={create}><Icon name="stash" size={13} />储藏改动</button>
        </div>
        <div className="list">
          {!list.length && <Empty icon="stash" title="没有储藏">“写到一半要先去修个紧急 bug”时，把未提交的改动储藏起来，修完再取回。</Empty>}
          {list.map((x) => (
            <div key={x.ref} className={`list-item ${sel === x.index ? 'sel' : ''}`} onClick={() => setSel(x.index)}>
              <div className="li-title">{x.message}</div>
              <div className="li-sub"><code>{x.ref}</code> · {relTime(x.date)}</div>
            </div>
          ))}
        </div>
        {s && (
          <div className="stash-actions">
            <button className="btn btn-primary" onClick={() => run('弹出储藏', () => git.stashApply(repo, s.index, true), '已应用并删除储藏')}>弹出（pop）</button>
            <button className="btn" onClick={() => run('应用储藏', () => git.stashApply(repo, s.index, false), '已应用储藏')}>应用（apply）</button>
            <button className="btn" onClick={async () => { const r = await dialog({ title: '从储藏创建分支', fields: [{ name: 'name', label: '分支名' }] }); if (r?.name) await run('创建分支', async () => { const x = await window.api.gitRaw(repo, `git stash branch ${r.name} ${s.ref}`) as { ok: boolean; output: string }; if (!x.ok) throw new Error(x.output) }, '已创建分支并应用储藏') }}>转为分支</button>
            <div className="flex1" />
            <button className="btn btn-ghost-danger" onClick={async () => { if (await dialog({ title: '删除储藏', message: `删除 ${s.ref}（${s.message}）？`, danger: true, okText: '删除' })) { await run('删除储藏', () => git.stashDrop(repo, s.index), '已删除'); setSel(null) } }}><Icon name="trash" size={13} /></button>
          </div>
        )}
        {s && (
          <div className="file-lists small">
            <div className="file-section-head"><span>储藏中的文件</span><em>{files.length}</em></div>
            {files.map((f) => (
              <div key={f.path} className={`file-row ${file === f.path ? 'sel' : ''}`} onClick={() => setFile(f.path)}>
                <StatusBadge code={f.status} /><span className="file-name">{f.path.split('/').pop()}</span><span className="file-dir">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <Resizer onResize={(d) => setW((x) => Math.max(260, Math.min(640, x + d)))} />
      <div className="pane-right">
        {s ? <DiffPane repo={repo} file={file} source={{ kind: 'stash', index: s.index }} /> : <Empty icon="stash" title="选择一个储藏查看内容" />}
      </div>
    </div>
  )
}
