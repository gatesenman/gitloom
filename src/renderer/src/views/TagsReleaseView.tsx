/** 日常 Git · 标签与发布：本地/远程标签、创建、推送/删除、发布说明草稿 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { RemoteInfo, TagInfo } from '@shared/types'
import { errMsg, git } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Empty, Skeleton, Spinner, relTime, useDialog, useToast } from '../components/ui'
import { buildReleaseNotesDraft, mergeTagPresence } from '../lib/releaseNotes'

export default function TagsReleaseView() {
  const { active, run, tick, status, setView } = useApp()
  const repo = active!
  const dialog = useDialog()
  const toast = useToast()
  const [localTags, setLocalTags] = useState<TagInfo[] | null>(null)
  const [remoteTags, setRemoteTags] = useState<{ name: string; sha: string }[]>([])
  const [remotes, setRemotes] = useState<RemoteInfo[]>([])
  const [remoteName, setRemoteName] = useState('origin')
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'local' | 'remote' | 'both'>('all')
  const [notes, setNotes] = useState('')
  const [notesTag, setNotesTag] = useState('')
  const [busyRemote, setBusyRemote] = useState(false)

  const reload = useCallback(async () => {
    if (!repo) return
    try {
      const [t, r] = await Promise.all([git.tags(repo), git.remotes(repo)])
      setLocalTags(t)
      setRemotes(r)
      const rn = r.find((x) => x.name === remoteName)?.name ?? r[0]?.name ?? 'origin'
      setRemoteName(rn)
      setBusyRemote(true)
      try {
        const rt = await git.remoteTags(repo, rn)
        setRemoteTags(rt)
      } catch {
        setRemoteTags([])
      } finally {
        setBusyRemote(false)
      }
    } catch (e) {
      toast('err', errMsg(e))
    }
  }, [repo, remoteName, toast])

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, tick % 5 === 0 ? tick : 0, status?.headSha])

  const merged = useMemo(() => {
    const local = (localTags ?? []).map((t) => ({ name: t.name, sha: t.sha }))
    return mergeTagPresence(local, remoteTags)
  }, [localTags, remoteTags])

  const localMap = useMemo(() => new Map((localTags ?? []).map((t) => [t.name, t])), [localTags])

  const rows = useMemo(() => {
    return merged.filter((t) => {
      if (filter !== 'all' && t.presence !== filter) return false
      if (q && !t.name.toLowerCase().includes(q.toLowerCase())) return false
      return true
    })
  }, [merged, filter, q])

  const createTag = async () => {
    const r = await dialog({
      title: '创建标签',
      message: `当前 HEAD：${status?.headSha?.slice(0, 7) ?? '—'}（${status?.branch ?? 'DETACHED'}）`,
      fields: [
        { name: 'name', label: '标签名', placeholder: 'v1.0.0' },
        { name: 'msg', label: '附注说明（填写则为附注标签；留空为轻量标签）', placeholder: '可选：本版修了什么' },
        { name: 'push', label: '创建后推送到远程', type: 'checkbox', value: false }
      ],
      okText: '创建'
    })
    if (!r?.name) return
    const name = String(r.name).trim()
    const msg = String(r.msg || '').trim() || undefined
    await run('创建标签', () => git.createTag(repo, name, undefined, msg), msg ? `已创建附注标签 ${name}` : `已创建轻量标签 ${name}`)
    if (r.push) {
      await run('推送标签', () => git.pushTag(repo, name, remoteName), `已推送 ${name}`)
    }
    await reload()
  }

  const draftNotes = async (preferTag?: string) => {
    const tags = localTags ?? []
    const sorted = [...tags].sort((a, b) => b.date - a.date)
    const targetName = preferTag || notesTag || `v-draft-${new Date().toISOString().slice(0, 10)}`
    const newer = preferTag ? sorted.find((t) => t.name === preferTag) : sorted[0]
    const older = sorted.find((t) => !newer || (t.name !== newer.name && t.date < (newer?.date ?? Infinity)))
    const range = older && newer ? `${older.name}..${newer.name}` : older ? `${older.name}..HEAD` : undefined
    const commits = await git.log(repo, { limit: 40, range: range, all: !range })
    const text = buildReleaseNotesDraft({
      tagName: targetName,
      sinceLabel: older ? `自 ${older.name} 以来` : '近期提交',
      commits: commits.map((c) => ({ short: c.short || c.hash.slice(0, 7), subject: c.subject, author: c.author, date: c.date })),
      repoName: repo.split(/[\\/]/).pop()
    })
    setNotesTag(targetName)
    setNotes(text)
    toast('ok', '已生成发布说明草稿，可复制后微调')
  }

  const presenceLabel = (p: string) => p === 'both' ? '本地+远程' : p === 'local' ? '仅本地' : '仅远程'

  return (
    <div className="page" data-testid="tags-release-view">
      <div className="pane-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <b>标签与发布</b>
          <span className="muted" style={{ marginLeft: 8 }}>本地 / 远程标签 · 打标签 · 推送删除 · 发布说明草稿</span>
        </div>
        <div className="flex1" />
        <button className="btn btn-sm" onClick={() => setView('branches')} title="回到分支与标签页（含原标签页签）" data-testid="tags-goto-branches">
          <Icon name="branch" size={13} />分支与标签
        </button>
        <button className="btn btn-primary" onClick={() => void createTag()} data-testid="tags-create">
          <Icon name="tag" size={14} />新建标签
        </button>
      </div>

      <div className="pane-toolbar" style={{ borderTop: 'none' }}>
        <div className="seg" role="tablist" aria-label="标签筛选">
          {([
            ['all', '全部'],
            ['both', '两边都有'],
            ['local', '仅本地'],
            ['remote', '仅远程']
          ] as const).map(([id, label]) => (
            <button key={id} type="button" className={filter === id ? 'on' : ''} onClick={() => setFilter(id)} data-testid={`tags-filter-${id}`}>
              {label}{id === 'all' && localTags ? <em>{merged.length}</em> : null}
            </button>
          ))}
        </div>
        <div className="search"><Icon name="search" size={13} /><input placeholder="筛选标签名…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="tags-search" /></div>
        {remotes.length > 0 && (
          <select value={remoteName} onChange={(e) => setRemoteName(e.target.value)} title="远程仓库" data-testid="tags-remote">
            {remotes.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
        )}
        <button className="btn btn-sm" onClick={() => void reload()} disabled={busyRemote} title="重新拉取本地与远程标签列表" data-testid="tags-refresh">
          {busyRemote ? <Spinner size={12} /> : <Icon name="fetch" size={13} />}刷新
        </button>
        <div className="flex1" />
        <button className="btn btn-sm" onClick={() => void draftNotes()} data-testid="tags-draft-notes" title="根据近期提交生成白话中文发布说明草稿">
          <Icon name="file" size={13} />生成发布说明草稿
        </button>
      </div>

      <div className="table-wrap">
        {localTags === null ? <Skeleton rows={8} /> : rows.length === 0 ? (
          <Empty icon="tag" title="还没有标签">
            点「新建标签」在当前提交上打标签；有远程时会列出远程标签。分支页里的「标签」页签仍然保留。
          </Empty>
        ) : (
          <table className="table" data-testid="tags-table">
            <thead>
              <tr>
                <th>标签</th>
                <th>位置</th>
                <th>类型</th>
                <th>提交</th>
                <th>说明</th>
                <th>时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const loc = localMap.get(t.name)
                return (
                  <tr key={t.name} data-testid="tags-row">
                    <td><span className="bname"><Icon name="tag" size={13} />{t.name}</span></td>
                    <td className="muted">{presenceLabel(t.presence)}</td>
                    <td className="muted">{loc ? (loc.annotated ? '附注' : '轻量') : '—'}</td>
                    <td><code className="muted">{(t.localSha || t.remoteSha || '').slice(0, 7)}</code></td>
                    <td className="ellipsis">{loc?.subject || '—'}</td>
                    <td className="muted nowrap">{loc ? relTime(loc.date) : '—'}</td>
                    <td className="nowrap right">
                      {t.presence !== 'remote' && (
                        <button className="btn btn-xs" data-testid="tags-push" title="推送到远程"
                          onClick={() => void run('推送标签', () => git.pushTag(repo, t.name, remoteName), `已推送 ${t.name}`).then(() => reload())}>推送</button>
                      )}
                      {t.presence !== 'remote' && (
                        <button className="btn btn-xs" title="用此标签生成发布说明"
                          onClick={() => { setNotesTag(t.name); void draftNotes(t.name) }}>说明</button>
                      )}
                      {t.presence !== 'remote' && (
                        <button className="btn btn-xs btn-ghost-danger" data-testid="tags-delete-local"
                          onClick={async () => {
                            if (await dialog({ title: '删除本地标签', message: `删除本地标签 ${t.name}？`, danger: true, okText: '删除' })) {
                              await run('删除标签', () => git.deleteTag(repo, t.name), '已删除本地标签')
                              await reload()
                            }
                          }}>删本地</button>
                      )}
                      {t.presence !== 'local' && (
                        <button className="btn btn-xs btn-ghost-danger" data-testid="tags-delete-remote"
                          onClick={async () => {
                            if (await dialog({ title: '删除远程标签', message: `将从 ${remoteName} 删除标签 ${t.name}`, danger: true, okText: '删除远程' })) {
                              await run('删除远程标签', () => git.deleteRemoteTag(repo, t.name, remoteName), '已删除远程标签')
                              await reload()
                            }
                          }}>删远程</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {notes && (
        <section className="us-card" style={{ margin: 12 }} data-testid="tags-notes">
          <div className="row gap" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <b>发布说明草稿</b>
            <span className="muted small">标签：{notesTag || '—'}</span>
            <div className="flex1" />
            <button className="btn btn-sm" data-testid="tags-notes-copy" onClick={async () => {
              try { await navigator.clipboard.writeText(notes); toast('ok', '已复制发布说明') }
              catch { toast('err', '复制失败') }
            }}>复制</button>
            <button className="btn btn-sm" onClick={() => setNotes('')}>收起</button>
          </div>
          <textarea className="mono" style={{ width: '100%', minHeight: 220 }} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="tags-notes-text" />
        </section>
      )}
    </div>
  )
}
