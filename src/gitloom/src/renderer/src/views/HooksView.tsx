import React, { useEffect, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { HookInfo, HookTemplate } from '@shared/types'
import { errMsg, git } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Empty, Skeleton, Spinner, useDialog, useToast } from '../components/ui'

const DESC: Record<string, string> = {
  'pre-commit': '提交前运行（检查代码、格式化、阻止提交）',
  'prepare-commit-msg': '生成默认提交信息后、编辑器打开前',
  'commit-msg': '校验提交信息',
  'post-commit': '提交完成后（通知、生成文档，如 llmwiki）',
  'pre-push': '推送前运行（测试、检查）',
  'post-checkout': '切换分支 / 检出后',
  'post-merge': '合并（含 pull）完成后',
  'pre-rebase': '变基开始前',
  'post-rewrite': 'amend / rebase 改写提交后'
}

export default function HooksView() {
  const { active, run, theme, settings, setView } = useApp()
  const repo = active!
  const dialog = useDialog()
  const toast = useToast()
  const [data, setData] = useState<{ dir: string; hooksPath: string | null; hooks: HookInfo[] } | null>(null)
  const [templates, setTemplates] = useState<HookTemplate[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [orig, setOrig] = useState('')
  const [wikiDir, setWikiDir] = useState('')

  const load = async () => {
    try {
      const d = await git.hooks(repo)
      setData(d)
      if (!sel && d.hooks.length) setSel(d.hooks[0].name)
    } catch (e) { toast('err', errMsg(e)) }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); git.hookTemplates().then(setTemplates); git.config(repo, 'llmwiki.dir').then((d) => setWikiDir(d || 'docs/llmwiki')) }, [repo])
  useEffect(() => { if (sel) git.readHook(repo, sel).then((c) => { setContent(c); setOrig(c) }) }, [repo, sel, data])

  const cur = data?.hooks.find((h) => h.name === sel)
  const dirty = content !== orig
  const install = async (t: HookTemplate) => {
    const exists = data?.hooks.find((h) => h.name === t.hook)?.exists
    if (exists && !(await dialog({ title: '覆盖钩子', message: `已存在 ${t.hook} 钩子，安装模板会覆盖它（会自动备份为 ${t.hook}.bak-时间戳）。`, okText: '覆盖安装' }))) return
    await run('安装模板', () => git.installHookTemplate(repo, t.id), `已安装「${t.name}」到 ${t.hook}`)
    setSel(t.hook)
    await load()
  }

  return (
    <div className="hooks-page">
      <div className="pane-toolbar">
        <b>Git 钩子</b>
        <span className="muted" title={data?.dir}>{data?.hooksPath ? `core.hooksPath = ${data.hooksPath}` : data?.dir}</span>
        <div className="flex1" />
        <button className="btn btn-sm" onClick={() => data && window.api.openPath(data.dir)}><Icon name="folder" size={13} />打开钩子目录</button>
      </div>
      <div className="hooks-grid">
        <div className="hook-list">
          {!data ? <Skeleton rows={9} variant="cards" /> : data.hooks.map((h) => (
            <div key={h.name} className={`hook-item ${sel === h.name ? 'sel' : ''}`} onClick={() => setSel(h.name)}>
              <div className="hook-main">
                <div className="hook-name">{h.name}</div>
                <div className="hook-desc">{h.exists ? (h.enabled ? '已启用' : '已禁用') : h.sample ? '仅示例（.sample）' : '未安装'}{DESC[h.name] ? ` · ${DESC[h.name]}` : ''}</div>
              </div>
              {h.exists && (
                <label className="switch" onClick={(e) => e.stopPropagation()} title={h.enabled ? '禁用' : '启用'}>
                  <input type="checkbox" checked={h.enabled} onChange={(e) => run(e.target.checked ? '启用钩子' : '禁用钩子', () => git.setHookEnabled(repo, h.name, e.target.checked)).then(load)} />
                  <span />
                </label>
              )}
            </div>
          ))}
        </div>
        <div className="hook-editor">
          {cur ? (
            <>
              <div className="diff-head">
                <Icon name="hook" size={14} /><b>{cur.name}</b>
                <span className="muted">{cur.exists ? cur.path : cur.sample ? '显示的是 .sample 示例，保存后生效' : '新建钩子'}</span>
                <div className="flex1" />
                {cur.exists && <button className="btn btn-sm btn-ghost-danger" onClick={async () => { if (await dialog({ title: '删除钩子', message: `删除 ${cur.name}？`, danger: true, okText: '删除' })) { await run('删除钩子', () => git.deleteHook(repo, cur.name), '已删除'); await load() } }}><Icon name="trash" size={13} />删除</button>}
                <button className="btn btn-sm btn-primary" disabled={!dirty && cur.exists} onClick={async () => { await run('保存钩子', () => git.writeHook(repo, cur.name, content, cur.exists ? cur.enabled : true), '已保存（并设置为可执行）'); await load() }}><Icon name="save" size={13} />{cur.exists ? '保存' : '创建并启用'}</button>
              </div>
              <div className="diff-body">
                <Editor value={content} onChange={(v) => setContent(v ?? '')} language="shell" theme={theme === 'dark' ? 'gitloom-dark' : 'gitloom-light'}
                  options={{ minimap: { enabled: false }, fontSize: settings?.fontSize ?? 13, automaticLayout: true, scrollBeyondLastLine: false, tabSize: 2, unicodeHighlight: { ambiguousCharacters: false } }} />
              </div>
            </>
          ) : <Empty icon="hook" title="选择一个钩子" />}
        </div>
      </div>
      <div className="templates">
        <div className="section-title"><Icon name="ai" size={14} />钩子模板</div>
        <div className="tpl-grid">
          {templates.map((t) => (
            <div key={t.id} className={`tpl ${t.id === 'llmwiki' ? 'tpl-featured' : ''}`}>
              <div className="tpl-head"><b>{t.name}</b><span className="tag">{t.hook}</span></div>
              <div className="tpl-desc">{t.description}</div>
              {t.id === 'llmwiki' && (
                <div className="tpl-extra">
                  <label className="inline-field">输出目录 <input value={wikiDir} onChange={(e) => setWikiDir(e.target.value)} onBlur={() => run('保存配置', () => git.setConfig(repo, 'llmwiki.dir', wikiDir || 'docs/llmwiki'))} /></label>
                  <div className="muted small">AI 摘要：{settings?.aiEnvForHooks && settings.ai.baseUrl ? `通过 GitLoom 提交时自动使用 ${settings.ai.model || '（未设模型）'}` : '未启用'} · <a onClick={() => setView('settings')}>设置</a></div>
                </div>
              )}
              <div className="tpl-actions">
                <button className="btn btn-sm btn-primary" onClick={() => install(t)}><Icon name="download" size={13} />安装</button>
                {t.id === 'llmwiki' && <button className="btn btn-sm" onClick={() => window.api.openInEditor(`${repo}/${wikiDir || 'docs/llmwiki'}/index.md`)}><Icon name="eye" size={13} />查看 wiki</button>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
