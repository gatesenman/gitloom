// Settings → AI 模型: provider profiles (grouped picker), per-task models, fallback chain, 测试连接.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AIProfile, AISettings, AITask } from '@shared/types'
import { AI_GROUPS, AI_PRESETS, presetById, presetMatches, type AIProviderPreset } from '@shared/aiProviders'
import { app, errMsg } from '../api'
import { Icon } from './Icon'
import { Spinner } from './ui'

const TASKS: { id: AITask; label: string; hint: string }[] = [
  { id: 'commit', label: '提交信息', hint: '生成提交信息、分支名' },
  { id: 'review', label: '代码审查', hint: '审查暂存区、冲突建议' },
  { id: 'explain', label: '解释差异', hint: '解释改动、PR 描述' },
  { id: 'chat', label: 'AI 对话', hint: 'AI 助手对话、自然语言转命令' }
]

export function ProviderLogo({ preset, size = 28 }: { preset: AIProviderPreset; size?: number }) {
  return <span className="prov-logo" style={{ background: preset.color, width: size, height: size, fontSize: size * (preset.initials.length > 1 ? 0.38 : 0.48) }} aria-hidden>{preset.initials}</span>
}

export function newProfile(preset: AIProviderPreset, existing: AIProfile[]): AIProfile {
  const n = existing.filter((p) => p.preset === preset.id).length
  return {
    id: `p-${preset.id}-${Date.now().toString(36)}`,
    name: n ? `${preset.name} ${n + 1}` : preset.name,
    preset: preset.id, protocol: preset.protocol, baseUrl: preset.baseUrl, apiKey: '', model: preset.models[0] ?? '',
    ...(preset.protocol === 'azure' ? { azureApiVersion: '2024-10-21', azureDeployment: '' } : {})
  }
}

/** Grouped provider picker: 国际 / 国内 / 聚合与本地, initials logos, search. */
export function ProviderPicker({ onPick, onClose, current }: { onPick: (p: AIProviderPreset) => void; onClose: () => void; current?: string }) {
  const [q, setQ] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const list = AI_PRESETS.filter((p) => presetMatches(p, q))
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="modal prov-picker" role="dialog" aria-label="选择 AI 服务商">
        <div className="prov-picker-head">
          <div className="modal-title">选择 AI 服务商</div>
          <div className="flex1" />
          <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>
        <div className="prov-search"><Icon name="search" size={14} /><input ref={ref} data-testid="ai-search" placeholder="搜索服务商或模型，如 deepseek、千问、claude、本地…" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) onPick(list[0]) }} /></div>
        <div className="prov-groups">
          {AI_GROUPS.map((g) => {
            const items = list.filter((p) => p.group === g.id)
            if (!items.length) return null
            return (
              <div key={g.id} className="prov-group">
                <div className="prov-group-title">{g.label}<span className="muted">{items.length}</span></div>
                <div className="prov-grid">
                  {items.map((p) => (
                    <button key={p.id} className={`prov-tile${current === p.id ? ' on' : ''}`} data-preset={p.id} onClick={() => onPick(p)} title={`${p.name}\n${p.baseUrl || '自定义地址'}`}>
                      <ProviderLogo preset={p} />
                      <span className="prov-tile-text"><b>{p.name}</b><small>{p.protocol === 'anthropic' ? 'Messages API' : p.protocol === 'azure' ? 'Azure 部署' : p.keyOptional && p.id !== 'custom' ? '本地 · 无需 Key' : 'OpenAI 兼容'}</small></span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
          {!list.length && <div className="muted small" style={{ padding: 16 }}>没有匹配的服务商，可选择「自定义 OpenAI 兼容」。</div>}
        </div>
      </div>
    </div>
  )
}

type TestState = { kind: 'ok' | 'err' | 'run'; text: string } | null

export function AIProviderSettings({ ai, onChange }: { ai: AISettings; onChange: (ai: AISettings) => void }) {
  const profiles = ai.profiles ?? []
  const [sel, setSel] = useState<string | null>(ai.activeProfile ?? profiles[0]?.id ?? null)
  const [picker, setPicker] = useState<'add' | 'change' | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<Record<string, { list: string[]; source: string; error?: string }>>({})
  const [loadingModels, setLoadingModels] = useState(false)
  const [test, setTest] = useState<TestState>(null)
  const cur = profiles.find((p) => p.id === sel) ?? profiles[0]
  const preset = cur ? presetById(cur.preset) : null
  // 测试连接 / 获取模型: one request at a time; switching profile or leaving settings aborts it so a late result
  // never shows up under a different profile
  const testCtl = useRef<AbortController | null>(null)
  const modelsCtl = useRef<AbortController | null>(null)
  const abortAll = (): void => { testCtl.current?.abort(); modelsCtl.current?.abort(); testCtl.current = modelsCtl.current = null }
  useEffect(() => { abortAll(); setTest(null); setLoadingModels(false) }, [sel])
  useEffect(() => () => abortAll(), [])

  const setProfiles = (ps: AIProfile[], extra: Partial<AISettings> = {}) => onChange({ ...ai, profiles: ps, ...extra })
  const patch = (fields: Partial<AIProfile>) => { if (cur) { setTest(null); setProfiles(profiles.map((p) => (p.id === cur.id ? { ...p, ...fields } : p))) } }
  const modelList = (p?: AIProfile): string[] => {
    if (!p) return []
    return [...new Set([...(models[p.id]?.list ?? p.models ?? []), ...presetById(p.preset).models])]
  }

  const add = (pr: AIProviderPreset) => {
    const p = newProfile(pr, profiles)
    setProfiles([...profiles, p], profiles.length ? {} : { activeProfile: p.id })
    setSel(p.id); setPicker(null); setShowKey(false)
  }
  const changePreset = (pr: AIProviderPreset) => {
    if (!cur) return
    patch({ preset: pr.id, protocol: pr.protocol, baseUrl: pr.baseUrl, model: pr.models[0] ?? cur.model, name: cur.name === presetById(cur.preset).name ? pr.name : cur.name, ...(pr.protocol === 'azure' ? { azureApiVersion: cur.azureApiVersion || '2024-10-21' } : {}) })
    setPicker(null)
  }
  const remove = (id: string) => {
    const ps = profiles.filter((p) => p.id !== id)
    const tasks = Object.fromEntries(Object.entries(ai.tasks ?? {}).map(([k, v]) => [k, v?.profile === id ? {} : v]))
    onChange({ ...ai, profiles: ps, activeProfile: ai.activeProfile === id ? ps[0]?.id : ai.activeProfile, fallback: (ai.fallback ?? []).filter((f) => f !== id), tasks })
    setSel(ps[0]?.id ?? null)
  }
  const fetchModels = async () => {
    if (!cur || modelsCtl.current) return
    const ctl = new AbortController(); modelsCtl.current = ctl
    setLoadingModels(true)
    try {
      const r = await app.aiModels(cur, ctl.signal)
      setModels((m) => ({ ...m, [cur.id]: { list: r.models, source: r.source, error: r.error } }))
      if (r.source === 'remote') patch({ models: r.models.slice(0, 400), ...(cur.model ? {} : { model: r.models[0] }) })
    } catch (e) {
      if (!ctl.signal.aborted) setModels((m) => ({ ...m, [cur.id]: { list: preset?.models ?? [], source: 'preset', error: errMsg(e) } }))
    } finally { if (modelsCtl.current === ctl) { modelsCtl.current = null; setLoadingModels(false) } }
  }
  const runTest = async () => {
    if (!cur || testCtl.current) return          // single-flight: repeated clicks while testing are ignored
    const ctl = new AbortController(); testCtl.current = ctl
    setTest({ kind: 'run', text: '正在连接…' })
    try {
      const r = await app.aiTest(cur, ctl.signal)
      setTest({ kind: 'ok', text: `连接成功 · ${cur.protocol === 'azure' ? cur.azureDeployment : cur.model} · 首字 ${r.firstTokenMs}ms · 共 ${r.ms}ms · 回复「${r.text.slice(0, 24)}」` })
    } catch (e) {
      if (!ctl.signal.aborted) setTest({ kind: 'err', text: errMsg(e) })
    } finally { if (testCtl.current === ctl) testCtl.current = null }
  }
  const stopTest = (): void => { testCtl.current?.abort(); testCtl.current = null; setTest(null) }

  const fallback = ai.fallback ?? []
  const tasks = ai.tasks ?? {}
  const setTask = (t: AITask, v: { profile?: string; model?: string }) => onChange({ ...ai, tasks: { ...tasks, [t]: v } })
  const groupLabel = useMemo(() => Object.fromEntries(AI_GROUPS.map((g) => [g.id, g.label])), [])

  return (
    <div className="ai-prov">
      <div className="prov-profiles" role="list">
        {profiles.map((p) => {
          const pr = presetById(p.preset)
          return (
            <button key={p.id} role="listitem" className={`prov-card${p.id === cur?.id ? ' sel' : ''}`} data-profile={p.id} onClick={() => setSel(p.id)} title={`${p.name} · ${p.baseUrl}`}>
              <ProviderLogo preset={pr} size={26} />
              <span className="prov-card-text"><b>{p.name}</b><small>{p.protocol === 'azure' ? (p.azureDeployment || '未填部署') : (p.model || '未选模型')}</small></span>
              {ai.activeProfile === p.id && <span className="pill pill-accent">默认</span>}
              {fallback.includes(p.id) && <span className="pill">备用 {fallback.indexOf(p.id) + 1}</span>}
            </button>
          )
        })}
        <button className="prov-card prov-add" data-testid="ai-add" onClick={() => setPicker('add')}><Icon name="plus" size={15} />添加服务商</button>
      </div>

      {!cur && <div className="prov-empty muted">还没有 AI 服务商。点「添加服务商」，从 OpenAI、Claude、DeepSeek、通义千问、Kimi、本地 Ollama 等 {AI_PRESETS.length} 个预设中选择，只需填 Key。</div>}

      {cur && preset && (
        <div className="prov-editor" data-testid="ai-editor">
          <div className="prov-editor-head">
            <ProviderLogo preset={preset} size={34} />
            <div className="prov-editor-title">
              <input className="prov-name" value={cur.name} aria-label="配置名称" onChange={(e) => patch({ name: e.target.value })} />
              <span className="muted small">{groupLabel[preset.group]} · {preset.protocol === 'anthropic' ? 'Anthropic Messages API' : preset.protocol === 'azure' ? 'Azure OpenAI' : 'OpenAI 兼容'}</span>
            </div>
            <div className="flex1" />
            <button className="btn btn-sm" onClick={() => setPicker('change')}><Icon name="refresh" size={13} />更换服务商</button>
            {ai.activeProfile !== cur.id && <button className="btn btn-sm" data-testid="ai-make-default" onClick={() => onChange({ ...ai, activeProfile: cur.id })}><Icon name="check" size={13} />设为默认</button>}
            <button className="icon-btn danger" title="删除此配置" onClick={() => remove(cur.id)}><Icon name="trash" size={14} /></button>
          </div>
          {preset.note && <div className="prov-note"><Icon name="info" size={13} />{preset.note}</div>}
          <div className="form-grid">
            {preset.regions && (
              <label>地域 / 站点<select value={preset.regions.find((r) => r.baseUrl === cur.baseUrl)?.baseUrl ?? ''} onChange={(e) => e.target.value && patch({ baseUrl: e.target.value })}>
                {!preset.regions.some((r) => r.baseUrl === cur.baseUrl) && <option value="">自定义地址</option>}
                {preset.regions.map((r) => <option key={r.baseUrl} value={r.baseUrl}>{r.label}</option>)}
              </select></label>
            )}
            <label>{cur.protocol === 'azure' ? '资源 Endpoint' : '接口地址 Base URL'}
              <input data-testid="ai-baseurl" value={cur.baseUrl} placeholder={cur.protocol === 'azure' ? 'https://my-resource.openai.azure.com' : 'https://…/v1'} onChange={(e) => patch({ baseUrl: e.target.value.trim() })} />
              {cur.baseUrl !== preset.baseUrl && preset.baseUrl && <span className="field-hint">官方地址：<a href="#" onClick={(e) => { e.preventDefault(); patch({ baseUrl: preset.baseUrl }) }}>{preset.baseUrl}</a></span>}
            </label>
            <label>API Key{preset.keyOptional ? '（可选）' : ''}
              <div className="input-row"><input data-testid="ai-key" type={showKey ? 'text' : 'password'} value={cur.apiKey} placeholder={preset.keyOptional ? '本地服务可留空' : preset.id === 'spark' ? 'APIPassword' : 'sk-…'} onChange={(e) => patch({ apiKey: e.target.value.trim() })} />
                <button type="button" className="btn btn-sm" title={showKey ? '隐藏' : '显示'} onClick={() => setShowKey(!showKey)}><Icon name="eye" size={13} /></button></div>
              <span className="field-hint">
                {preset.keyUrl && <a href="#" data-testid="ai-key-link" onClick={(e) => { e.preventDefault(); void window.api.openExternal(preset.keyUrl!) }}>{preset.keyOptional ? '下载 / 安装' : '如何获取 Key'} <Icon name="external" size={11} /></a>}
                {preset.keyUrl && ' · '}仅保存在本机，使用系统密钥库（safeStorage）加密。
              </span>
            </label>
            {cur.protocol === 'azure' ? (<>
              <label>部署名 deployment<input data-testid="ai-azure-deployment" value={cur.azureDeployment ?? ''} placeholder="如 gpt-4o-prod" onChange={(e) => patch({ azureDeployment: e.target.value.trim() })} /></label>
              <label>api-version<input value={cur.azureApiVersion ?? '2024-10-21'} onChange={(e) => patch({ azureApiVersion: e.target.value.trim() })} /></label>
            </>) : (
              <label>默认模型
                <div className="input-row">
                  <input data-testid="ai-model" list={`models-${cur.id}`} value={cur.model} placeholder={preset.models[0] ?? '模型 ID'} onChange={(e) => patch({ model: e.target.value.trim() })} />
                  <datalist id={`models-${cur.id}`}>{modelList(cur).map((m) => <option key={m} value={m} />)}</datalist>
                  <button type="button" className="btn btn-sm" data-testid="ai-fetch-models" aria-busy={loadingModels} onClick={() => void fetchModels()}>{loadingModels ? <Spinner /> : <Icon name="download" size={13} />}获取模型</button>
                </div>
                {models[cur.id] && <span className={`field-hint${models[cur.id].error ? ' warn' : ''}`} data-testid="ai-models-info">{models[cur.id].source === 'remote' ? `从服务商获取到 ${models[cur.id].list.length} 个模型` : `${models[cur.id].error ?? ''}；已显示推荐模型`}</span>}
                {!models[cur.id] && preset.models.length > 0 && <span className="field-hint">推荐：{preset.models.slice(0, 4).map((m, i) => <React.Fragment key={m}>{i > 0 && '、'}<a href="#" onClick={(e) => { e.preventDefault(); patch({ model: m }) }}>{m}</a></React.Fragment>)}</span>}
              </label>
            )}
          </div>
          <div className="row prov-test-row">
            <button className="btn btn-ai" data-testid="ai-test" aria-busy={test?.kind === 'run'} onClick={() => void runTest()}>{test?.kind === 'run' ? <Spinner /> : <Icon name="play" size={13} />}{test?.kind === 'run' ? '测试中…' : '测试连接'}</button>
            {test?.kind === 'run' && <button className="btn btn-sm" data-testid="ai-test-stop" onClick={stopTest}><Icon name="stop" size={13} />停止</button>}
            {test && test.kind !== 'run' && <div className={`ai-test-result ${test.kind}`} data-testid="ai-test-result"><Icon name={test.kind === 'ok' ? 'ok' : 'error'} size={14} /><span>{test.text}</span></div>}
          </div>
        </div>
      )}

      {profiles.length > 0 && (
        <div className="prov-tasks">
          <div className="prov-sub-title">按任务选择模型<span className="muted small">留空 = 使用默认配置的默认模型</span></div>
          <div className="prov-task-grid">
            {TASKS.map((t) => {
              const v = tasks[t.id] ?? {}
              const tp = profiles.find((p) => p.id === v.profile) ?? profiles.find((p) => p.id === ai.activeProfile)
              return (
                <div key={t.id} className="prov-task" data-task={t.id}>
                  <div className="prov-task-label"><b>{t.label}</b><small className="muted">{t.hint}</small></div>
                  <select aria-label={`${t.label}使用的配置`} value={v.profile ?? ''} onChange={(e) => setTask(t.id, { profile: e.target.value || undefined, model: undefined })}>
                    <option value="">默认配置</option>
                    {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input aria-label={`${t.label}使用的模型`} list={`task-models-${t.id}`} placeholder={tp?.model || '默认模型'} value={v.model ?? ''} onChange={(e) => setTask(t.id, { ...v, model: e.target.value.trim() || undefined })} />
                  <datalist id={`task-models-${t.id}`}>{modelList(tp).map((m) => <option key={m} value={m} />)}</datalist>
                </div>
              )
            })}
          </div>
          <div className="prov-sub-title">备用链<span className="muted small">主模型因网络、限流、余额或模型不可用失败时，按顺序自动改用下面的配置</span></div>
          <div className="prov-fallback">
            {fallback.map((id, i) => {
              const p = profiles.find((x) => x.id === id)
              if (!p) return null
              return (
                <div key={id} className="prov-fb-item">
                  <span className="prov-fb-n">{i + 1}</span><ProviderLogo preset={presetById(p.preset)} size={20} /><span className="flex1">{p.name} <small className="muted">{p.model}</small></span>
                  <button className="icon-btn" title="上移" disabled={i === 0} onClick={() => { const f = [...fallback]; [f[i - 1], f[i]] = [f[i], f[i - 1]]; onChange({ ...ai, fallback: f }) }}><Icon name="chevron-down" size={13} style={{ transform: 'rotate(180deg)' }} /></button>
                  <button className="icon-btn" title="移除" onClick={() => onChange({ ...ai, fallback: fallback.filter((x) => x !== id) })}><Icon name="x" size={13} /></button>
                </div>
              )
            })}
            {profiles.filter((p) => !fallback.includes(p.id)).length > 0 && (
              <select className="prov-fb-add" aria-label="添加备用配置" value="" onChange={(e) => e.target.value && onChange({ ...ai, fallback: [...fallback, e.target.value] })}>
                <option value="">＋ 添加备用配置…</option>
                {profiles.filter((p) => !fallback.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
          </div>
        </div>
      )}

      {picker && <ProviderPicker current={picker === 'change' ? cur?.preset : undefined} onClose={() => setPicker(null)} onPick={picker === 'add' ? add : changePreset} />}
    </div>
  )
}
