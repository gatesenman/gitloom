import React, { useCallback, useEffect, useState } from 'react'
import type { ForgeIssue, ForgePR, ForgeRemote } from '@shared/types'
import { useApp } from '../state'
import { app, errMsg } from '../api'
import { Icon } from '../components/Icon'
import { Empty, Spinner, useDialog, useToast } from '../components/ui'

export default function ForgeView() {
  const { active, run, settings, saveSettings, setView } = useApp()
  const toast = useToast()
  const dialog = useDialog()
  const [forge, setForge] = useState<ForgeRemote | null>(null)
  const [tab, setTab] = useState<'prs' | 'issues'>('prs')
  const [prs, setPrs] = useState<ForgePR[]>([])
  const [issues, setIssues] = useState<ForgeIssue[]>([])
  const [busy, setBusy] = useState(false)

  const detect = useCallback(async () => {
    if (!active) return
    try { setForge(await app.forgeDetect(active)) } catch { setForge(null) }
  }, [active])

  const tokenMissing = !forge ? false : forge.kind === 'github' ? !settings?.forge?.githubToken : !settings?.forge?.gitlabToken
  const [token, setToken] = useState('')

  const load = useCallback(async () => {
    // never call the API (and never toast) without a token — the inline setup below handles that case
    if (!active || !forge || tokenMissing) return
    setBusy(true)
    try {
      if (tab === 'prs') setPrs(await app.forgePRs(active))
      else setIssues(await app.forgeIssues(active))
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }, [active, forge, tab, toast, tokenMissing])

  useEffect(() => { void detect() }, [detect])
  useEffect(() => { void load() }, [load])

  const create = async () => {
    if (!active || !forge) return
    const r = await dialog({
      title: forge.kind === 'github' ? '创建 Pull Request' : '创建 Merge Request',
      fields: [
        { name: 'title', label: '标题', placeholder: '简述改动' },
        { name: 'head', label: '源分支', value: '' },
        { name: 'base', label: '目标分支', value: 'main' },
        { name: 'body', label: '描述', type: 'textarea' },
        { name: 'draft', label: '草稿', type: 'checkbox', value: false }
      ]
    })
    if (!r?.title || !r.head) return
    await run('创建 PR/MR', async () => {
      const pr = await app.forgeCreatePR(active, { title: String(r.title), body: String(r.body || ''), head: String(r.head), base: String(r.base || 'main'), draft: !!r.draft })
      toast('ok', `已创建 #${pr.number}`)
      window.api.openExternal(pr.url)
      await load()
    })
  }

  if (!active) return <Empty icon="pr" title="未选择仓库" />
  if (!forge) return (
    <Empty icon="cloud" title="未识别到 GitHub / GitLab 远程">
      需要 origin 指向 github.com 或 gitlab.com（或自建 GitLab）。可在设置中配置 Token。
      <div style={{ marginTop: 12 }}><button className="btn" onClick={() => setView('settings')}>打开设置</button></div>
    </Empty>
  )

  const host = forge.kind === 'github' ? 'GitHub' : 'GitLab'
  const saveToken = async () => {
    if (!settings || !token.trim()) return
    const f = settings.forge ?? { githubToken: '', gitlabToken: '', gitlabBaseUrl: 'https://gitlab.com' }
    await saveSettings({ ...settings, forge: { ...f, ...(forge.kind === 'github' ? { githubToken: token.trim() } : { gitlabToken: token.trim() }) } })
    setToken('')
    toast('ok', `已保存 ${host} Token（加密存储）`)
  }
  const tokenUrl = forge.kind === 'github' ? 'https://github.com/settings/tokens' : `${(settings?.forge?.gitlabBaseUrl || 'https://gitlab.com').replace(/\/+$/, '')}/-/user_settings/personal_access_tokens`

  return (
    <div className="tools-view">
      <div className="tools-head">
        <div>
          <h2><Icon name="pr" size={18} /> {forge.kind === 'github' ? 'GitHub' : 'GitLab'} · {forge.owner}/{forge.repo}</h2>
          <p className="muted">{forge.url}</p>
        </div>
        <div className="row gap">
          <div className="seg seg-sm">
            <button className={tab === 'prs' ? 'on' : ''} onClick={() => setTab('prs')}>{forge.kind === 'github' ? 'Pull Requests' : 'Merge Requests'}</button>
            <button className={tab === 'issues' ? 'on' : ''} onClick={() => setTab('issues')}>Issues</button>
          </div>
          {tab === 'prs' && <button className="btn btn-primary" onClick={create} disabled={tokenMissing}><Icon name="plus" size={14} />新建</button>}
          <button className="btn" onClick={() => void load()} disabled={busy}>{busy ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}</button>
        </div>
      </div>
      {tokenMissing ? (
        <div className="forge-setup card" data-testid="forge-setup">
          <h3><Icon name="lock" size={16} />连接 {host}</h3>
          <p className="muted">要在这里查看 {forge.kind === 'github' ? 'Pull Request' : 'Merge Request'}、Issue 与 CI 状态，需要一个 {host} 个人访问令牌（Token）。
            {forge.kind === 'github' ? '建议勾选 repo 权限。' : '建议勾选 api 权限。'}Token 会用系统密钥库加密保存，只用于访问 {host} API。</p>
          <div className="row gap">
            <input className="flex1" type="password" value={token} placeholder={forge.kind === 'github' ? 'ghp_… 或 github_pat_…' : 'glpat-…'} aria-label={`${host} Token`}
              onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveToken() }} />
            <button className="btn btn-primary" onClick={() => void saveToken()} disabled={!token.trim()}>保存并连接</button>
          </div>
          <div className="row gap small">
            <button className="btn btn-sm btn-ghost" onClick={() => window.api.openExternal(tokenUrl)}><Icon name="external" size={12} />去 {host} 创建 Token</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setView('settings')}><Icon name="settings" size={12} />在设置中管理</button>
          </div>
        </div>
      ) : <>
      {tab === 'prs' && (
        <div className="forge-list">
          {!prs.length && !busy && <Empty icon="pr" title="没有打开的 PR/MR" />}
          {prs.map((p) => (
            <a key={p.id} className="forge-row" href={p.url} onClick={(e) => { e.preventDefault(); window.api.openExternal(p.url) }}>
              <Icon name="pr" size={16} />
              <div className="flex1">
                <div><b>#{p.number}</b> {p.title} {p.draft && <span className="kind-tag">草稿</span>}</div>
                <div className="muted">{p.head} → {p.base} · {p.author}</div>
              </div>
              <span className={`ci-badge ci-${p.ci ?? 'neutral'}`} title="CI">{p.ci === 'success' ? '✓' : p.ci === 'failure' ? '✗' : p.ci === 'pending' ? '…' : '—'}</span>
            </a>
          ))}
        </div>
      )}
      {tab === 'issues' && (
        <div className="forge-list">
          {!issues.length && !busy && <Empty icon="dot" title="没有打开的 Issue" />}
          {issues.map((i) => (
            <a key={i.id} className="forge-row" href={i.url} onClick={(e) => { e.preventDefault(); window.api.openExternal(i.url) }}>
              <Icon name="dot" size={16} />
              <div className="flex1">
                <div><b>#{i.number}</b> {i.title}</div>
                <div className="muted">{i.author} · {i.labels.join(', ')}</div>
              </div>
            </a>
          ))}
        </div>
      )}
      </>}
    </div>
  )
}
