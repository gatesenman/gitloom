import React, { useEffect, useState } from 'react'
import type { BranchInfo, RemoteInfo, TagInfo } from '@shared/types'
import { app, errMsg, git } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Empty, Skeleton, Spinner, relTime, useDialog, useMenu, useToast } from '../components/ui'

type Tab = 'local' | 'remote' | 'tags' | 'remotes' | 'reflog'

export default function BranchesView() {
  const { active, run, tick, status, setView } = useApp()
  const repo = active!
  const dialog = useDialog()
  const menu = useMenu()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('local')
  const [branches, setBranches] = useState<BranchInfo[] | null>(null)
  const [tags, setTags] = useState<TagInfo[]>([])
  const [remotes, setRemotes] = useState<RemoteInfo[]>([])
  const [reflog, setReflog] = useState<{ sha: string; selector: string; subject: string; date: number }[]>([])
  const [q, setQ] = useState('')

  useEffect(() => {
    void Promise.all([git.branches(repo), git.tags(repo), git.remotes(repo), git.reflog(repo)])
      .then(([b, t, r, rl]) => { setBranches(b); setTags(t); setRemotes(r); setReflog(rl) })
      .catch((e) => toast('err', errMsg(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, tick % 5 === 0 ? tick : 0, status?.branch, status?.headSha])

  const newBranch = async (start?: string) => {
    let suggestions: string[] = []
    const r = await dialog({
      title: '新建分支', message: start ? `起点：${start}` : `起点：当前 HEAD（${status?.branch ?? ''}）`,
      fields: [
        { name: 'name', label: '分支名', placeholder: 'feature/login-page' },
        { name: 'desc', label: '用一句话描述任务（可选，用于 AI 建议分支名）', placeholder: '例如：修复登录页在暗色模式下的按钮颜色' },
        { name: 'checkout', label: '创建后立即切换', type: 'checkbox', value: true }
      ],
      okText: '创建',
      extra: (set) => <AiNames repo={repo} onPick={(n) => set('name', n)} getDesc={() => (document.querySelectorAll('.modal input')[1] as HTMLInputElement)?.value} />
    })
    void suggestions
    if (r?.name) await run('创建分支', () => git.createBranch(repo, String(r.name).trim(), start, !!r.checkout), `已创建分支 ${r.name}`)
  }

  const branchMenu = (e: React.MouseEvent, b: BranchInfo) => {
    const remoteName = b.remote ? b.name.split('/')[0] : null
    menu(e, [
      { label: b.remote ? '检出为本地跟踪分支' : '切换到此分支', icon: 'check', disabled: b.current, onClick: () => run('切换分支', () => git.checkout(repo, b.name), `已切换到 ${b.name}`) },
      { label: `合并到当前分支（${status?.branch}）`, icon: 'merge', disabled: b.current, onClick: async () => {
        const r = await dialog({ title: '合并分支', message: `将 ${b.name} 合并到 ${status?.branch}`, fields: [{ name: 'noFf', label: '总是创建合并提交（--no-ff）', type: 'checkbox' }, { name: 'squash', label: '压缩合并（--squash，不自动提交）', type: 'checkbox' }], okText: '合并' })
        if (r) await run('合并', () => git.merge(repo, b.name, { noFf: !!r.noFf, squash: !!r.squash }), '合并完成')
      } },
      { label: `将当前分支变基到此（rebase）`, icon: 'refresh', disabled: b.current, onClick: async () => { if (await dialog({ title: '变基', message: `将 ${status?.branch} 变基到 ${b.name} 之上？会改写当前分支历史。`, okText: '变基' })) await run('变基', () => git.rebase(repo, b.name), '变基完成') } },
      { label: '从此分支新建分支…', icon: 'plus', onClick: () => newBranch(b.name) },
      { sep: true },
      ...(!b.remote ? [
        { label: '重命名…', icon: 'file', onClick: async () => { const r = await dialog({ title: '重命名分支', fields: [{ name: 'name', label: '新名称', value: b.name }] }); if (r?.name && r.name !== b.name) await run('重命名', () => git.renameBranch(repo, b.name, String(r.name)), '已重命名') } },
        { label: '推送到远程', icon: 'push', onClick: () => run('推送', () => git.push(repo, b.upstream ? { remote: b.upstream.split('/')[0], branch: b.name } : { setUpstream: true, branch: b.name }), '已推送') },
        { label: '删除分支', icon: 'trash', danger: true, disabled: b.current, onClick: async () => {
          const r = await dialog({ title: '删除分支', message: `删除本地分支 ${b.name}？`, fields: [{ name: 'force', label: '强制删除（即使未合并，-D）', type: 'checkbox' }], danger: true, okText: '删除' })
          if (r) await run('删除分支', () => git.deleteBranch(repo, b.name, !!r.force), `已删除 ${b.name}`)
        } }
      ] : [
        { label: '删除远程分支', icon: 'trash', danger: true, onClick: async () => { if (await dialog({ title: '删除远程分支', message: `将执行 git push ${remoteName} --delete ${b.name.slice(remoteName!.length + 1)}`, danger: true, okText: '删除' })) await run('删除远程分支', () => git.deleteRemoteBranch(repo, remoteName!, b.name.slice(remoteName!.length + 1)), '已删除远程分支') } }
      ]),
      { sep: true },
      { label: '复制分支名', icon: 'copy', onClick: () => navigator.clipboard.writeText(b.name) }
    ])
  }

  const list = (branches ?? []).filter((b) => (tab === 'local' ? !b.remote : b.remote) && (!q || b.name.toLowerCase().includes(q.toLowerCase())))
  const locals = (branches ?? []).filter((b) => !b.remote).length
  return (
    <div className="page">
      <div className="pane-toolbar">
        <div className="seg">
          <button className={tab === 'local' ? 'on' : ''} onClick={() => setTab('local')}>本地分支 <em>{locals}</em></button>
          <button className={tab === 'remote' ? 'on' : ''} onClick={() => setTab('remote')}>远程分支 <em>{(branches?.length ?? 0) - locals}</em></button>
          <button className={tab === 'tags' ? 'on' : ''} onClick={() => setTab('tags')}>标签 <em>{tags.length}</em></button>
          <button className={tab === 'remotes' ? 'on' : ''} onClick={() => setTab('remotes')}>远程仓库 <em>{remotes.length}</em></button>
          <button className={tab === 'reflog' ? 'on' : ''} onClick={() => setTab('reflog')}>引用日志</button>
        </div>
        <div className="search"><Icon name="search" size={13} /><input placeholder="筛选…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="flex1" />
        {tab === 'local' && <button className="btn btn-primary" onClick={() => newBranch()}><Icon name="plus" size={14} />新建分支</button>}
        {tab === 'tags' && <button className="btn btn-primary" onClick={async () => { const r = await dialog({ title: '创建标签（当前 HEAD）', fields: [{ name: 'name', label: '标签名', placeholder: 'v1.0.0' }, { name: 'msg', label: '附注（可选）' }] }); if (r?.name) await run('创建标签', () => git.createTag(repo, String(r.name), undefined, String(r.msg || '') || undefined), '标签已创建') }}><Icon name="tag" size={14} />新建标签</button>}
        {tab === 'remotes' && <button className="btn btn-primary" onClick={async () => { const r = await dialog({ title: '添加远程仓库', fields: [{ name: 'name', label: '名称', value: remotes.length ? '' : 'origin' }, { name: 'url', label: 'URL' }] }); if (r?.name && r.url) await run('添加远程', () => git.addRemote(repo, String(r.name), String(r.url)), '已添加远程') }}><Icon name="plus" size={14} />添加远程</button>}
      </div>
      <div className="table-wrap">
        {!branches ? <Skeleton rows={10} /> : (tab === 'local' || tab === 'remote') ? (
          list.length ? (
            <table className="table">
              <thead><tr><th>分支</th><th>上游 / 同步</th><th>最新提交</th><th>时间</th><th /></tr></thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.fullRef} className={b.current ? 'current' : ''} onDoubleClick={() => !b.current && run('切换分支', () => git.checkout(repo, b.name), `已切换到 ${b.name}`)} onContextMenu={(e) => branchMenu(e, b)}>
                    <td><span className="bname">{b.current ? <span className="dot-cur" title="当前分支" /> : <Icon name={b.remote ? 'cloud' : 'branch'} size={13} />}{b.name}</span></td>
                    <td>{b.upstream ? <span className="muted">{b.upstream} {b.ahead > 0 && <span className="pill">↑{b.ahead}</span>} {b.behind > 0 && <span className="pill">↓{b.behind}</span>}</span> : !b.remote && <span className="muted">未发布</span>}</td>
                    <td className="ellipsis"><code className="muted">{b.sha.slice(0, 7)}</code> {b.subject}</td>
                    <td className="muted nowrap">{relTime(b.date)}</td>
                    <td className="nowrap right">
                      {!b.current && <button className="btn btn-xs" onClick={() => run('切换分支', () => git.checkout(repo, b.name), `已切换到 ${b.name}`)}>{b.remote ? '检出' : '切换'}</button>}
                      <button className="icon-btn sm" title="更多操作" aria-label="更多操作" onClick={(e) => branchMenu(e, b)}><Icon name="more" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty icon="branch" title={tab === 'local' ? '没有本地分支' : '没有远程分支'}>{tab === 'remote' ? '添加远程仓库并抓取后即可看到远程分支。' : ''}</Empty>
        ) : tab === 'tags' ? (
          <>
          <div className="moved-hint" role="note" data-testid="branches-tags-hub" style={{ margin: '8px 12px' }}>
            <Icon name="info" size={14} />发版相关操作集中在「标签与发布」（本地/远程对照、推送删除、发布说明草稿）。
            <button type="button" className="link" onClick={() => setView('tags')}>打开标签与发布</button>
          </div>
          {tags.length ? (
            <table className="table">
              <thead><tr><th>标签</th><th>类型</th><th>提交</th><th>说明</th><th>时间</th><th /></tr></thead>
              <tbody>{tags.filter((t) => !q || t.name.includes(q)).map((t) => (
                <tr key={t.name}>
                  <td><span className="bname"><Icon name="tag" size={13} />{t.name}</span></td>
                  <td className="muted">{t.annotated ? '附注' : '轻量'}</td>
                  <td><code className="muted">{t.sha.slice(0, 7)}</code></td>
                  <td className="ellipsis">{t.subject}</td>
                  <td className="muted nowrap">{relTime(t.date)}</td>
                  <td className="nowrap right">
                    <button className="btn btn-xs" onClick={() => run('推送标签', () => git.push(repo, { remote: remotes[0]?.name ?? 'origin', branch: `refs/tags/${t.name}` }), '标签已推送')}>推送</button>
                    <button className="btn btn-xs" onClick={() => run('检出', () => git.checkout(repo, t.name), `已检出 ${t.name}`)}>检出</button>
                    <button className="btn btn-xs btn-ghost-danger" onClick={async () => { if (await dialog({ title: '删除标签', message: `删除本地标签 ${t.name}？`, danger: true, okText: '删除' })) await run('删除标签', () => git.deleteTag(repo, t.name), '已删除') }}>删除</button>
                  </td>
                </tr>))}
              </tbody>
            </table>
          ) : <Empty icon="tag" title="还没有标签">在历史中右键某个提交即可打标签。</Empty>}
          </>
        ) : tab === 'remotes' ? (
          remotes.length ? (
            <table className="table">
              <thead><tr><th>名称</th><th>抓取地址</th><th>推送地址</th><th /></tr></thead>
              <tbody>{remotes.map((r) => (
                <tr key={r.name}>
                  <td><span className="bname"><Icon name="cloud" size={13} />{r.name}</span></td>
                  <td className="ellipsis"><code>{r.fetchUrl}</code></td>
                  <td className="ellipsis"><code>{r.pushUrl}</code></td>
                  <td className="nowrap right">
                    <button className="btn btn-xs" onClick={() => run('抓取', () => git.fetch(repo, r.name), '抓取完成')}>抓取</button>
                    {/^https?:\/\//.test(r.fetchUrl) && <button className="btn btn-xs" onClick={() => window.api.openExternal(r.fetchUrl.replace(/\.git$/, ''))}>浏览器打开</button>}
                    <button className="btn btn-xs btn-ghost-danger" onClick={async () => { if (await dialog({ title: '移除远程', message: `移除远程 ${r.name}？`, danger: true, okText: '移除' })) await run('移除远程', () => git.removeRemote(repo, r.name), '已移除') }}>移除</button>
                  </td>
                </tr>))}
              </tbody>
            </table>
          ) : <Empty icon="cloud" title="没有远程仓库">添加一个远程仓库以便推送和拉取。</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>引用</th><th>操作</th><th>提交</th><th>时间</th><th /></tr></thead>
            <tbody>{reflog.filter((r) => !q || r.subject.includes(q)).map((r) => (
              <tr key={r.selector}>
                <td><code>{r.selector}</code></td>
                <td className="ellipsis">{r.subject}</td>
                <td><code className="muted">{r.sha.slice(0, 7)}</code></td>
                <td className="muted nowrap">{relTime(r.date)}</td>
                <td className="nowrap right">
                  <button className="btn btn-xs" title="从该状态创建分支（找回丢失的提交）" onClick={async () => { const x = await dialog({ title: '从引用日志恢复', message: `基于 ${r.selector}（${r.sha.slice(0, 7)}）创建分支`, fields: [{ name: 'name', label: '分支名', value: `recover/${r.sha.slice(0, 7)}` }] }); if (x?.name) await run('恢复', () => git.createBranch(repo, String(x.name), r.sha, false), `已创建分支 ${x.name}`) }}>恢复为分支</button>
                  <button className="btn btn-xs btn-ghost-danger" title="git reset --hard 到该状态（撤销）" onClick={async () => { if (await dialog({ title: '撤销到此状态', message: `将当前分支 reset --hard 到 ${r.selector}，未提交的改动会丢失。`, danger: true, okText: '重置' })) await run('撤销', () => git.reset(repo, r.sha, 'hard'), '已重置') }}>重置到此</button>
                </td>
              </tr>))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function AiNames({ repo, onPick, getDesc }: { repo: string; onPick: (n: string) => void; getDesc: () => string }) {
  const [names, setNames] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const toast = useToast()
  const go = async () => {
    const d = getDesc()
    if (!d) { toast('info', '请先填写任务描述'); return }
    setLoading(true)
    try { setNames((await app.ai('branchName', repo, { question: d })).split('\n').map((s) => s.replace(/^[-*\d.\s`]+|`$/g, '').trim()).filter(Boolean).slice(0, 5)) }
    catch (e) { toast('err', errMsg(e)) } finally { setLoading(false) }
  }
  return (
    <div className="ai-names">
      <button type="button" className="btn btn-sm btn-ai" onClick={go} disabled={loading}>{loading ? <Spinner /> : <Icon name="ai" size={13} />}AI 建议分支名</button>
      {names.map((n) => <button type="button" key={n} className="chip" onClick={() => onPick(n)}>{n}</button>)}
    </div>
  )
}
