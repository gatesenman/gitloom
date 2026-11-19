import React, { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { git } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { useToast } from '../components/ui'
import logo from '../assets/logo.svg'
import { AIProviderSettings } from '../components/AIProviderSettings'
import { AI_PRESETS } from '@shared/aiProviders'

export default function SettingsView() {
  const { settings, saveSettings, active, run, setView } = useApp()
  const toast = useToast()
  const [s, setS] = useState<AppSettings | null>(settings)
  const [info, setInfo] = useState<Record<string, string | boolean | number> | null>(null)
  const [user, setUser] = useState({ name: '', email: '' })
  const [appInfo, setAppInfo] = useState<{ version: string; platform: string; electron: string; userData: string } | null>(null)

  useEffect(() => { setS(settings) }, [settings])
  useEffect(() => { window.api.info().then(setAppInfo) }, [])
  useEffect(() => {
    if (!active) return
    git.repoInfo(active).then((i) => { setInfo(i); setUser({ name: String(i.userName), email: String(i.userEmail) }) }).catch(() => setInfo(null))
  }, [active])
  if (!s) return null
  const dirty = JSON.stringify(s) !== JSON.stringify(settings)
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setS({ ...s, [k]: v })
  const setAi = <K extends keyof AppSettings['ai']>(k: K, v: AppSettings['ai'][K]) => setS({ ...s, ai: { ...s.ai, [k]: v } })

  return (
    <div className="page settings">
      <div className="settings-inner">
        <div className="settings-head">
          <h2>设置</h2>
          <div className="flex1" />
          <button className="btn" disabled={!dirty} onClick={() => setS(settings)}>还原</button>
          <button className="btn btn-primary" disabled={!dirty} onClick={async () => { await saveSettings(s); toast('ok', '设置已保存') }}><Icon name="save" size={14} />保存设置</button>
        </div>

        <section className="card set-card" data-testid="ai-settings">
          <h3><Icon name="ai" />AI 模型<span className="muted small" style={{ fontWeight: 400, marginLeft: 8 }}>国际 · 国内 · 聚合与本地，共 {AI_PRESETS.length} 个预设</span></h3>
          <AIProviderSettings ai={s.ai} onChange={(ai) => setS({ ...s, ai })} />
          <div className="form-grid">
            <label>温度<input type="number" min={0} max={2} step={0.1} value={s.ai.temperature} onChange={(e) => setAi('temperature', Number(e.target.value))} />
              <span className="field-hint">Claude 新模型不支持自定义温度，会自动忽略。</span></label>
            <label>输出语言<select value={s.ai.language} onChange={(e) => setAi('language', e.target.value as 'zh' | 'en')}><option value="zh">简体中文</option><option value="en">English</option></select></label>
            <label>提交信息风格<select value={s.ai.commitStyle} onChange={(e) => setAi('commitStyle', e.target.value as AppSettings['ai']['commitStyle'])}>
              <option value="conventional">Conventional Commits（feat/fix…）</option><option value="gitmoji">Gitmoji</option><option value="simple">简洁摘要</option></select></label>
          </div>
          <label className="check"><input type="checkbox" checked={s.aiEnvForHooks} onChange={(e) => set('aiEnvForHooks', e.target.checked)} />通过 GitLoom 执行提交等操作时，向 Git 钩子注入默认配置（仅 OpenAI 兼容协议；LLMWIKI_BASE_URL / LLMWIKI_MODEL / LLMWIKI_API_KEY 环境变量，供 llmwiki 钩子使用；密钥不落盘）</label>
        </section>

        <section className="card set-card">
          <h3><Icon name="sun" />外观与行为</h3>
          <div className="form-grid">
            <label>主题<select value={s.theme} onChange={(e) => set('theme', e.target.value as AppSettings['theme'])}><option value="dark">深色</option><option value="light">浅色</option><option value="system">跟随系统</option></select></label>
            <label>差异视图<select value={s.diffMode} onChange={(e) => set('diffMode', e.target.value as 'split' | 'inline')}><option value="split">并排（Side-by-side）</option><option value="inline">统一（Unified）</option></select></label>
            <label>代码字号<input type="number" min={10} max={22} value={s.fontSize} onChange={(e) => set('fontSize', Number(e.target.value))} /></label>
            <label>分支图加载提交数<input type="number" min={100} max={20000} step={100} value={s.graphLimit} onChange={(e) => set('graphLimit', Number(e.target.value))} /></label>
            <label>自动抓取间隔（分钟，0 关闭）<input type="number" min={0} max={240} value={s.autoFetchMinutes} onChange={(e) => set('autoFetchMinutes', Number(e.target.value))} /></label>
            <label>添加文件夹时扫描深度<input type="number" min={0} max={6} value={s.scanDepth} onChange={(e) => set('scanDepth', Number(e.target.value))} /></label>
            <label>Git 可执行文件<input value={s.gitPath} onChange={(e) => set('gitPath', e.target.value)} placeholder="git" /></label>
          </div>
        </section>

        {active && (
          <section className="card set-card">
            <h3><Icon name="repo" />当前仓库：{active.split(/[\\/]/).pop()}<div className="flex1" /><button className="btn btn-sm" onClick={() => setView('hooks')} title="提交/推送时自动运行的脚本"><Icon name="hook" size={13} />管理 Git 钩子</button></h3>
            <div className="form-grid">
              <label>user.name<input value={user.name} onChange={(e) => setUser({ ...user, name: e.target.value })} /></label>
              <label>user.email<input value={user.email} onChange={(e) => setUser({ ...user, email: e.target.value })} /></label>
            </div>
            <div className="row">
              <button className="btn btn-sm" onClick={() => run('保存身份', async () => { await git.setConfig(active, 'user.name', user.name); await git.setConfig(active, 'user.email', user.email) }, '已保存到本仓库配置')}>保存到本仓库</button>
              <button className="btn btn-sm" onClick={() => run('保存身份', async () => { await git.setConfig(active, 'user.name', user.name, true); await git.setConfig(active, 'user.email', user.email, true) }, '已保存到全局配置')}>保存为全局</button>
            </div>
            {info && (
              <div className="kv">
                <div><span>提交签名</span><b>{info.gpgSign ? `已启用（${info.signFormat}${info.signingKey ? ` · ${info.signingKey}` : ''}）` : '未启用'}</b></div>
                <div><span>Git LFS</span><b>{info.lfsUsed ? '仓库使用 LFS' : '未使用'} · {info.lfsInstalled ? '已安装 git-lfs' : '未安装 git-lfs'}</b></div>
                <div><span>子模块</span><b>{String(info.submoduleCount)} 个</b></div>
                <div><span>浅克隆</span><b>{info.shallow ? '是' : '否'}</b></div>
                <div><span>稀疏检出</span><b>{info.sparse ? '是' : '否'}</b></div>
              </div>
            )}
          </section>
        )}

        <section className="card set-card">
          <h3><Icon name="pr" />PR 与 Issue（GitHub / GitLab）</h3>
          <p className="muted small">Token 使用系统密钥库加密保存（与 AI Key 相同）。仅用于列出/创建 PR·MR、Issues 与 CI 状态。</p>
          <div className="form-grid">
            <label>GitHub Token
              <input type="password" value={s.forge?.githubToken ?? ''} placeholder="ghp_…" onChange={(e) => set('forge', { ...(s.forge ?? { githubToken: '', gitlabToken: '', gitlabBaseUrl: 'https://gitlab.com' }), githubToken: e.target.value })} />
              <span className="field-hint">需要 repo 权限；用于 PR / Issues / commit status。</span>
            </label>
            <label>GitLab Token
              <input type="password" value={s.forge?.gitlabToken ?? ''} placeholder="glpat-…" onChange={(e) => set('forge', { ...(s.forge ?? { githubToken: '', gitlabToken: '', gitlabBaseUrl: 'https://gitlab.com' }), gitlabToken: e.target.value })} />
            </label>
            <label>GitLab 地址
              <input value={s.forge?.gitlabBaseUrl ?? 'https://gitlab.com'} placeholder="https://gitlab.com" onChange={(e) => set('forge', { ...(s.forge ?? { githubToken: '', gitlabToken: '', gitlabBaseUrl: 'https://gitlab.com' }), gitlabBaseUrl: e.target.value })} />
              <span className="field-hint">自建实例可改为 https://gitlab.example.com</span>
            </label>
          </div>
        </section>

        <section className="card set-card about">
          <img src={logo} width={56} />
          <div>
            <b>GitLoom 织线</b> <span className="muted">v{appInfo?.version}</span>
            <div className="muted small">跨平台多仓库 Git 客户端 · Electron {appInfo?.electron} · {appInfo?.platform}</div>
            <div className="muted small">配置文件：{appInfo?.userData}</div>
          </div>
        </section>
      </div>
    </div>
  )
}
