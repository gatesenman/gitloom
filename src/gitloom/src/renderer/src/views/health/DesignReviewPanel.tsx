/** 质量把关 · 设计审查：静态设计债 + 可选 AI DESIGN.md 审查 */
import React, { useEffect, useState } from 'react'
import { useApp } from '../../state'
import { health, errMsg, app as appApi } from '../../api'
import { Icon } from '../../components/Icon'
import { Spinner, useToast } from '../../components/ui'
import { useAIRunner, useRunState } from '../../hooks/useAIRun'
import { AIDrawer } from '../../components/AIResult'
import type { Finding, HealthReport } from '@shared/health'
import { CATEGORY_LABELS, PLAIN_SEV, SEVERITY_LABELS } from '@shared/health'

export function DesignReviewPanel() {
  const { active, setView, settings } = useApp()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<HealthReport | null>(null)
  const [err, setErr] = useState('')
  const aiRun = useAIRunner()
  const aiLoading = useRunState(aiRun, (x) => x.status) === 'running'
  const aiText = useRunState(aiRun, (x) => x.text)
  const [aiOpen, setAiOpen] = useState(false)
  const hasAi = !!(settings?.ai && ((settings.ai.profiles?.length ?? 0) > 0 || settings.ai.baseUrl))

  useEffect(() => {
    setReport(null); setErr(''); aiRun.reset(); setAiOpen(false)
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    if (!active) { toast('err', '请先在左侧选择一个仓库'); return }
    setBusy(true); setErr('')
    try {
      const r = await health.run({ repo: active, scope: 'working', checks: ['design'] })
      setReport(r)
      const n = r.findings.filter((f) => f.category === 'design' && f.status === 'open').length
      toast('ok', n ? `设计审查完成：${n} 条发现` : '设计审查完成：暂无设计债提示')
    } catch (e) {
      const m = errMsg(e)
      setErr(m)
      toast('err', m)
    } finally { setBusy(false) }
  }

  const startAi = (force = false) => {
    if (!active) return
    setAiOpen(true)
    aiRun.start(`designReview|${active}`, (signal, onDelta) =>
      appApi.aiStream('designReview', active, {}, onDelta, signal), { force })
  }

  const findings: Finding[] = (report?.findings ?? []).filter((f) => f.category === 'design')
  const open = findings.filter((f) => f.status === 'open')

  return (
    <section className="mod-hub-sec" data-testid="q-design">
      <div className="mod-hub-sec-head">
        <b title="硬编码颜色、内联样式、令牌漂移；可选 AI 读 DESIGN.md">设计审查</b>
        <span className="muted">白话：界面颜色和样式有没有乱写</span>
        <div className="flex1" />
        <button type="button" className="btn btn-sm btn-primary" disabled={!active || busy}
          onClick={() => void scan()} data-testid="q-design-scan"
          title={!active ? '先选择仓库' : '扫描硬编码颜色、内联样式与 DESIGN.md 契约'}>
          {busy ? <Spinner size={12} /> : <Icon name="shield" size={13} />}
          {busy ? '扫描中…' : '扫描设计债'}
        </button>
        <button type="button" className="btn btn-sm btn-ai" disabled={!active || aiLoading}
          onClick={() => startAi()} data-testid="q-design-ai"
          title={!hasAi ? '未配置 AI 时会提示前往设置' : '让 AI 阅读 DESIGN.md 并给改进建议'}>
          {aiLoading ? <Spinner size={12} /> : <Icon name="ai" size={13} />}
          {aiLoading ? 'AI 审查中…' : 'AI 审 DESIGN.md'}
        </button>
      </div>
      <p className="muted small" data-testid="q-design-lead">
        自动找硬编码颜色、内联 style、随意像素间距，并对照 DESIGN.md。
        结果会写入体检「设计」类别；也可点上方「一键体检」一并检查。
        {!hasAi ? <> AI 审查需先 <button type="button" className="link" onClick={() => setView('settings')}>配置 AI</button>。</> : null}
      </p>
      {err && <p className="err small" data-testid="q-design-err">{err}</p>}
      {report && (
        <div className="q-design-body" data-testid="q-design-result">
          <div className="stat-chips" data-testid="q-design-summary">
            <span className="stat-chip">设计发现 <b>{open.length}</b></span>
            <span className="stat-chip muted">共 {findings.length} 条 · {report.durationMs} ms</span>
            {report.notes?.length ? <span className="stat-chip muted" title={report.notes.join('\n')}>备注 {report.notes.length}</span> : null}
          </div>
          {open.length === 0 ? (
            <p className="muted small" data-testid="q-design-clean">暂无设计债提示（或仓库不像有前端 UI）。有 DESIGN.md 且令牌一致时会更安静。</p>
          ) : (
            <ul className="mod-hub-list q-design-list" data-testid="q-design-list">
              {open.slice(0, 40).map((f) => (
                <li key={f.id} data-testid="q-design-finding" data-sev={f.severity}>
                  <div>
                    <span className={`lvl lvl-${PLAIN_SEV[f.severity] === '严重' ? '高' : PLAIN_SEV[f.severity] === '注意' ? '中' : '低'}`} title={SEVERITY_LABELS[f.severity]}>
                      {PLAIN_SEV[f.severity]}
                    </span>
                    <b> {f.title}</b>
                    <span className="muted small"> · {CATEGORY_LABELS[f.category]}</span>
                    {f.evidence?.path && <div className="muted small mono">{f.evidence.path}{f.evidence.line ? `:${f.evidence.line}` : ''}</div>}
                    {f.detail && <p className="muted small">{f.detail}</p>}
                    {f.fix && <p className="small">建议：{f.fix}</p>}
                  </div>
                </li>
              ))}
              {open.length > 40 && <li className="muted small">…另有 {open.length - 40} 条，可在上方体检报告详情中查看</li>}
            </ul>
          )}
        </div>
      )}
      {aiOpen && aiText && <div className="muted small" data-testid="q-design-ai-hint">AI 结果见下方抽屉；静态发现不依赖 AI。</div>}
      {aiOpen && <AIDrawer runner={aiRun} title="AI · DESIGN.md 审查" onClose={() => { aiRun.stop(); setAiOpen(false) }} onRegenerate={() => startAi(true)} />}
    </section>
  )
}
