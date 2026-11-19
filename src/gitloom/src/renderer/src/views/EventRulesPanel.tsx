/** 自动化 → 事件触发：拉取/推送/抓取/提交成功后的本地规则 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import {
  type EventRule, type TriggerEvent, type RuleAction,
  EVENT_LABELS, ACTION_LABELS, RULE_PRESETS,
  makeRule, fromPreset, defaultRuleName, hasSameCombo
} from '@shared/eventRules'
import { loadRules, saveRule, setRuleEnabled, deleteRule } from '../lib/eventRulesStore'

const EVENTS = Object.keys(EVENT_LABELS) as TriggerEvent[]
const ACTIONS = Object.keys(ACTION_LABELS) as RuleAction[]

function loadRunLog(): string[] {
  try {
    const prev = JSON.parse(localStorage.getItem('gitloom.eventRules.runLog') || '[]') as unknown
    return Array.isArray(prev) ? prev.filter((x): x is string => typeof x === 'string').slice(0, 40) : []
  } catch { return [] }
}

const statusLabel = (s?: string) => s === 'ok' ? '成功' : s === 'err' ? '失败' : s === 'skip' ? '跳过' : '—'
const fmt = (t?: number | null) => t ? new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export default function EventRulesPanel() {
  const { project } = useApp()
  const pid = project?.id ?? ''
  const [rules, setRules] = useState<EventRule[]>([])
  const [log, setLog] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [ev, setEv] = useState<TriggerEvent>('pull')
  const [act, setAct] = useState<RuleAction>('health')
  const [name, setName] = useState('')

  const reload = useCallback(() => {
    if (!pid) { setRules([]); return }
    setRules(loadRules(pid).rules)
    setLog(loadRunLog())
  }, [pid])

  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { projectId?: string } | undefined
      if (!d?.projectId || d.projectId === pid) reload()
    }
    window.addEventListener('gitloom:event-rules-changed', h)
    return () => window.removeEventListener('gitloom:event-rules-changed', h)
  }, [pid, reload])

  const records = useMemo(() => {
    const fromRules = rules
      .filter((r) => r.lastRun)
      .map((r) => ({
        key: r.id,
        when: r.lastRun!.at,
        title: r.name || defaultRuleName(r.event, r.action),
        status: r.lastRun!.status,
        message: r.lastRun!.message
      }))
      .sort((a, b) => b.when - a.when)
    return fromRules
  }, [rules])

  if (!pid) {
    return <div className="er-panel" data-testid="event-rules"><p className="muted">打开一个项目后，可为该项目配置事件触发规则。</p></div>
  }

  const addPreset = (presetId: string) => {
    const p = RULE_PRESETS.find((x) => x.id === presetId)
    if (!p) return
    const st = loadRules(pid)
    if (hasSameCombo(st, p.event, p.action)) {
      window.alert('已有相同「事件 × 动作」的规则，可直接启用现有规则。')
      return
    }
    saveRule(pid, fromPreset(p))
    reload()
  }

  const addCustom = () => {
    const st = loadRules(pid)
    if (hasSameCombo(st, ev, act)) {
      window.alert('已有相同「事件 × 动作」的规则。')
      return
    }
    saveRule(pid, makeRule({ event: ev, action: act, name: name.trim() || undefined }))
    setAdding(false); setName(''); reload()
  }

  return (
    <div className="er-panel" data-testid="event-rules">
      <p className="muted small er-lead">
        在「拉取 / 推送 / 抓取 / 提交」成功后异步执行动作（体检、轻量更新 Wiki、写运行记录）。不拦截 Git 操作；失败只提示。规则按项目保存在本机。
      </p>

      <div className="er-presets" data-testid="er-presets">
        <div className="er-sec-h"><b>快速添加</b><span className="muted small">行业常用组合</span></div>
        <div className="er-preset-grid">
          {RULE_PRESETS.map((p) => (
            <button key={p.id} type="button" className="er-preset" data-testid={`er-preset-${p.id}`}
              onClick={() => addPreset(p.id)} title={p.desc}>
              <b>{p.name}</b>
              <span className="muted small">{p.desc}</span>
              <span className="er-go">添加规则 →</span>
            </button>
          ))}
        </div>
      </div>

      <div className="er-bar">
        <b>已配置规则</b>
        <span className="spacer" />
        <button className="btn btn-sm" data-testid="er-add" onClick={() => setAdding((v) => !v)}>
          <Icon name="plus" size={13} />自定义规则
        </button>
      </div>

      {adding && (
        <div className="er-form" data-testid="er-form">
          <label>触发事件
            <select value={ev} onChange={(e) => setEv(e.target.value as TriggerEvent)} data-testid="er-event">
              {EVENTS.map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}
            </select>
          </label>
          <label>动作
            <select value={act} onChange={(e) => setAct(e.target.value as RuleAction)} data-testid="er-action">
              {ACTIONS.map((k) => <option key={k} value={k}>{ACTION_LABELS[k]}</option>)}
            </select>
          </label>
          <label>名称（可选）
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultRuleName(ev, act)} data-testid="er-name" />
          </label>
          <div className="row gap">
            <button className="btn btn-sm btn-primary" data-testid="er-save" onClick={addCustom}>保存</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setAdding(false)}>取消</button>
          </div>
        </div>
      )}

      {!rules.length && (
        <div className="er-empty" data-testid="er-empty">
          <Icon name="zap" size={20} />
          <b>还没有事件规则</b>
          <p className="muted">从上方预设一键添加，或自定义「事件 × 动作」。成功拉取/推送后会自动跑。</p>
        </div>
      )}

      <div className="er-list" data-testid="er-list">
        {rules.map((r) => (
          <div key={r.id} className={`er-row ${r.enabled ? '' : 'off'}`} data-testid="er-row">
            <label className="er-tog" title={r.enabled ? '已启用' : '已停用'}>
              <input type="checkbox" checked={r.enabled} onChange={() => { setRuleEnabled(pid, r.id); reload() }} data-testid="er-toggle" />
            </label>
            <div className="er-main">
              <div className="er-title"><b>{r.name || defaultRuleName(r.event, r.action)}</b></div>
              <div className="er-meta muted small">
                {EVENT_LABELS[r.event]} · {ACTION_LABELS[r.action]}
                {r.lastRun && <> · 上次 {fmt(r.lastRun.at)} · {statusLabel(r.lastRun.status)}{r.lastRun.message ? ` · ${r.lastRun.message}` : ''}</>}
              </div>
            </div>
            <button className="btn btn-sm btn-ghost icon-only danger" title="删除" aria-label="删除"
              data-testid="er-del" onClick={() => { if (confirm(`删除规则「${r.name}」？`)) { deleteRule(pid, r.id); reload() } }}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>

      <section className="er-records" data-testid="er-records">
        <div className="er-sec-h"><b>本区运行记录</b><span className="muted small">规则最近一次结果</span></div>
        {!records.length && !log.length && <p className="muted small">还没有运行记录。启用规则并成功拉取/推送后会出现在这里。</p>}
        {!!records.length && (
          <ul className="er-rec-list">
            {records.slice(0, 20).map((x) => (
              <li key={x.key} data-testid="er-rec">
                <span className={`bdg tone-${x.status === 'ok' ? 'ok' : x.status === 'err' ? 'danger' : 'warn'}`}>{statusLabel(x.status)}</span>
                <span className="er-rec-when">{fmt(x.when)}</span>
                <b>{x.title}</b>
                {x.message && <span className="muted">{x.message}</span>}
              </li>
            ))}
          </ul>
        )}
        {!!log.length && (
          <details className="er-log-extra">
            <summary className="muted small">「写运行记录」动作流水（最近）</summary>
            <ul className="er-rec-list">{log.map((line, i) => <li key={i} className="muted small">{line}</li>)}</ul>
          </details>
        )}
      </section>
    </div>
  )
}
