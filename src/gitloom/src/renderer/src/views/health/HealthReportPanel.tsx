/** 0.6.4 统一体检报告 — 0.6.6+ 小白友好：大按钮、分数、白话结论 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../../state'
import { Icon } from '../../components/Icon'
import { Spinner, useToast } from '../../components/ui'
import { health, errMsg } from '../../api'
import {
  type Finding, type FindingCategory, type FindingSeverity, type FindingStatus,
  type HealthCheckId, type HealthReport, type HealthScopeKind,
  CHECK_LABELS, SAFE_DEFAULT_CHECKS, SEVERITY_LABELS, CATEGORY_LABELS,
  SEVERITY_ORDER, highestSeverity, reportSummaryText,
  PLAIN_SEV, healthScore, plainConclusions,
  compareHealthReports, pickCompareTargets, plainCompareLine,
  type HealthCompareResult
} from '@shared/health'

const SCOPE_OPTS: { id: HealthScopeKind; label: string; tip: string }[] = [
  { id: 'working', label: '本次改动', tip: '工作区相对 HEAD 的改动（含未暂存；空则含暂存）' },
  { id: 'staged', label: '已暂存', tip: '仅扫描暂存区' },
  { id: 'repo', label: '整仓抽样', tip: '近期提交与工作区抽样（有上限）' }
]

const STATUS_LABEL: Record<FindingStatus, string> = {
  open: '未关闭', fixed: '已修复', ignored: '已忽略', false_positive: '误报'
}

function sevClass(s: FindingSeverity): string {
  return s === 'critical' || s === 'high' ? 'sev-high' : s === 'medium' ? 'sev-med' : s === 'low' ? 'sev-low' : 'sev-info'
}

export function HealthReportPanel({
  tools,
  runRef
}: {
  tools: { id: string; found: boolean }[] | null
  /** 父级英雄区可调用同一套一键体检 */
  runRef?: React.MutableRefObject<(() => void) | null>
}) {
  const { active, project, setView } = useApp()
  const toast = useToast()
  const [scope, setScope] = useState<HealthScopeKind>('working')
  const [checks, setChecks] = useState<HealthCheckId[]>(() => [...SAFE_DEFAULT_CHECKS])
  const [checksOpen, setChecksOpen] = useState(false)
  const [report, setReport] = useState<HealthReport | null>(null)
  const [comparePrev, setComparePrev] = useState<HealthCompareResult | null>(null)
  const [compareWeek, setCompareWeek] = useState<HealthCompareResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [filtSev, setFiltSev] = useState<FindingSeverity | 'all'>('all')
  const [filtCat, setFiltCat] = useState<FindingCategory | 'all'>('all')
  const [filtStatus, setFiltStatus] = useState<FindingStatus | 'all'>('open')
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({})
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const reqIdRef = useRef<string>('')

  const loadLatest = useCallback(async () => {
    if (!active) { setReport(null); return }
    try {
      const r = await health.latest(active)
      setReport(r)
    } catch { /* */ }
  }, [active])

  useEffect(() => { void loadLatest() }, [loadLatest])


  const loadCompare = useCallback(async (current: HealthReport | null) => {
    if (!active || !current) { setComparePrev(null); setCompareWeek(null); return }
    try {
      const metas = await health.list(active)
      const { previousId, weekAgoId } = pickCompareTargets(metas, { latestId: current.id })
      const [prevR, weekR] = await Promise.all([
        previousId ? health.get(active, previousId) : Promise.resolve(null),
        weekAgoId && weekAgoId !== previousId ? health.get(active, weekAgoId) : Promise.resolve(null)
      ])
      setComparePrev(prevR ? compareHealthReports(current, prevR) : null)
      // 若「上周」与「上次」是同一份，仍显示；否则用 weekR；若 weekAgoId===previousId 已取 prevR
      const weekSrc = weekAgoId === previousId ? prevR : weekR
      setCompareWeek(weekSrc && weekAgoId ? compareHealthReports(current, weekSrc) : null)
    } catch {
      setComparePrev(null); setCompareWeek(null)
    }
  }, [active])

  useEffect(() => { void loadCompare(report) }, [report, loadCompare])

  const run = useCallback(async () => {
    if (!active) { toast('err', '请先在左侧选择一个仓库'); return }
    abortRef.current?.abort()
    const ctl = new AbortController()
    abortRef.current = ctl
    const reqId = `health-${Date.now().toString(36)}`
    reqIdRef.current = reqId
    setBusy(true)
    try {
      const r = await health.run({
        repo: active,
        projectRoot: project?.root,
        scope,
        checks: checks.length ? checks : [...SAFE_DEFAULT_CHECKS],
        reqId
      }, ctl.signal)
      setReport(r)
      setDetailsOpen(true)
      toast('ok', r.cancelled ? '体检已取消（部分结果已保存）' : `体检完成 · ${r.summary.total} 条发现`)
    } catch (e) {
      if ((e as Error).name === 'AbortError' || /已取消/.test(errMsg(e))) toast('ok', '已取消')
      else toast('err', errMsg(e))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [active, project?.root, scope, checks, toast])

  useEffect(() => {
    if (!runRef) return
    runRef.current = () => { void run() }
    return () => { runRef.current = null }
  }, [runRef, run])

  const cancel = () => {
    abortRef.current?.abort()
    if (reqIdRef.current) void health.cancel(reqIdRef.current)
  }

  const setStatus = async (f: Finding, status: FindingStatus) => {
    if (!active || !report) return
    try {
      const r = await health.setFindingStatus(active, report.id, f.id, status)
      if (r) setReport(r)
    } catch (e) { toast('err', errMsg(e)) }
  }

  const copySummary = async () => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(reportSummaryText(report))
      toast('ok', '已复制摘要')
    } catch { toast('err', '复制失败') }
  }

  const doExport = async (format: 'markdown' | 'json') => {
    if (!active || !report) return
    try {
      const path = await health.export(active, report.id, format)
      if (path) toast('ok', `已导出：${path}`)
      else toast('ok', '已取消导出')
    } catch (e) { toast('err', errMsg(e)) }
  }

  const openEvidence = (f: Finding) => {
    const p = f.evidence.path
    if (!p || !active) return
    try {
      sessionStorage.setItem('gitloom.focusFile', JSON.stringify({ repo: active, path: p, line: f.evidence.line }))
      if (f.evidence.line != null) {
        localStorage.setItem('gitloom.tools.tab', JSON.stringify('blame'))
        sessionStorage.setItem('gitloom.blameFile', p)
      }
    } catch { /* */ }
    setView(f.evidence.line != null ? 'tools' : 'changes')
  }

  const filtered = useMemo(() => {
    if (!report) return []
    return report.findings.filter((f) => {
      if (filtSev !== 'all' && f.severity !== filtSev) return false
      if (filtCat !== 'all' && f.category !== filtCat) return false
      if (filtStatus !== 'all' && f.status !== filtStatus) return false
      return true
    })
  }, [report, filtSev, filtCat, filtStatus])

  const grouped = useMemo(() => {
    const m = new Map<FindingSeverity, Finding[]>()
    for (const sev of SEVERITY_ORDER) m.set(sev, [])
    for (const f of filtered) m.get(f.severity)!.push(f)
    return m
  }, [filtered])

  const toggleCheck = (id: HealthCheckId) => {
    setChecks((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  const found = tools?.filter((t) => t.found).length ?? 0
  const total = tools?.length ?? 0
  const top = report ? highestSeverity(report.findings.filter((f) => f.status === 'open')) : null
  const score = report ? healthScore(report) : null
  const conclusions = report ? plainConclusions(report) : []

  const runButton = !busy ? (
    <button className="btn btn-lg btn-primary health-run-cta" disabled={!active || !checks.length} onClick={() => void run()}
      data-testid="health-run" title={!active ? '先在左侧选择一个仓库' : '用安全默认项一键检查'}>
      <Icon name="shield" size={18} />一键体检
    </button>
  ) : (
    <button className="btn btn-lg" onClick={cancel} title="取消本次体检" data-testid="health-cancel">
      <Spinner size={14} />取消体检
    </button>
  )

  return (
    <section className="mod-hub-sec health-report" data-testid="q-report" id="q-report">
      <div className="mod-hub-sec-head health-cta-row">
        <div>
          <b title="统一体检：静态、密钥、卫生、工具、可选 AI/ocr/Wiki Lint">一键体检</b>
          <span className="muted" style={{ marginLeft: 8 }}>默认已勾选安全项 · 不用会命令行</span>
        </div>
        <div className="flex1" />
        {runButton}
      </div>

      <div className="health-advanced-opts row gap" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <div className="btn-group" role="group" aria-label="体检范围">
          {SCOPE_OPTS.map((o) => (
            <button key={o.id} type="button" className={`btn btn-sm ${scope === o.id ? 'btn-primary' : ''}`}
              disabled={busy} title={o.tip} onClick={() => setScope(o.id)} data-testid={`health-scope-${o.id}`}>{o.label}</button>
          ))}
        </div>
        <button className="btn btn-sm" disabled={busy} onClick={() => setChecksOpen((v) => !v)} title="勾选要运行的检查项">
          检查项 ({checks.length}){checksOpen ? ' · 收起' : ''}
        </button>
      </div>

      {checksOpen && (
        <div className="health-checks" data-testid="health-checks">
          {(Object.keys(CHECK_LABELS) as HealthCheckId[]).map((id) => (
            <label key={id} className="health-check" title={CHECK_LABELS[id]}>
              <input type="checkbox" checked={checks.includes(id)} onChange={() => toggleCheck(id)} disabled={busy} />
              {CHECK_LABELS[id]}
            </label>
          ))}
        </div>
      )}

      {!active && (
        <div className="health-empty" data-testid="health-empty-norepo">
          <div className="health-empty-illu" aria-hidden><Icon name="folder" size={40} /></div>
          <p><b>还没选仓库</b></p>
          <p className="muted">在左侧点一个仓库，再点上面的「一键体检」。</p>
        </div>
      )}

      {active && !report && !busy && (
        <div className="health-empty" data-testid="health-empty">
          <div className="health-empty-illu" aria-hidden><Icon name="shield" size={48} /></div>
          <p><b>还没有体检结果</b></p>
          <p className="muted">点上面的「一键体检」开始。会自动查密钥泄露、坏味道、依赖漏洞等。</p>
          <p className="muted small">点上面开始</p>
        </div>
      )}

      {busy && !report && (
        <p className="muted" data-testid="health-busy"><Spinner size={14} /> 正在体检…稍等片刻</p>
      )}

      {report && (
        <>
          <div className="health-head" data-testid="health-head">
            <div className="health-score-block" data-testid="health-score">
              <div className={`health-score-num ${score != null && score >= 80 ? 'ok' : score != null && score >= 50 ? 'warn' : 'bad'}`}>
                {score}
                <small>分</small>
              </div>
              <ul className="health-conclusions" data-testid="health-conclusions">
                {conclusions.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            
            {(comparePrev || compareWeek) && (
              <div className="health-compare" data-testid="health-compare" style={{ marginTop: 10 }}>
                <b className="small">历史对比</b>
                <span className="muted small" style={{ marginLeft: 8 }}>和上次体检、大约一周前比一比分数和问题数</span>
                <ul className="health-conclusions" style={{ marginTop: 6 }}>
                  {comparePrev && <li data-testid="health-compare-prev">{plainCompareLine('上次', comparePrev)}</li>}
                  {compareWeek && <li data-testid="health-compare-week">{plainCompareLine('上周', compareWeek)}</li>}
                  {!compareWeek && comparePrev && <li className="muted" data-testid="health-compare-no-week">还没有大约一周前的体检记录，多跑几次就会出现「比上周」。</li>}
                </ul>
              </div>
            )}

            </div>
            <div className="stat-chips">
              {SEVERITY_ORDER.map((sev) => (
                <button key={sev} type="button"
                  className={`stat-chip ${sevClass(sev)} ${filtSev === sev ? 'on' : ''}`}
                  title={`${PLAIN_SEV[sev]}（${SEVERITY_LABELS[sev]}）：${report.summary.bySeverity[sev]}`}
                  onClick={() => { setFiltSev((x) => x === sev ? 'all' : sev); setDetailsOpen(true) }}>
                  {PLAIN_SEV[sev]} <b>{report.summary.bySeverity[sev]}</b>
                </button>
              ))}
              <span className="stat-chip" title="耗时">耗时 <b>{report.durationMs}</b> ms</span>
              <span className="stat-chip" title="范围">{SCOPE_OPTS.find((s) => s.id === report.scope)?.label ?? report.scope}</span>
              {top && <span className={`stat-chip ${sevClass(top)}`} title="未关闭最高严重级别">最高 <b>{PLAIN_SEV[top]}</b></span>}
              {report.cancelled && <span className="stat-chip sev-med">已取消</span>}
            </div>
            <div className="row gap" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={() => void copySummary()} title="复制一行摘要到剪贴板" data-testid="health-copy">复制摘要</button>
              <button className="btn btn-sm" onClick={() => void doExport('markdown')} title="导出 Markdown" data-testid="health-export-md">导出 Markdown</button>
              <button className="btn btn-sm" onClick={() => void doExport('json')} title="导出 JSON" data-testid="health-export-json">导出 JSON</button>
              <button className="btn btn-sm" onClick={() => setDetailsOpen((v) => !v)} data-testid="health-toggle-details">
                {detailsOpen ? '收起详情' : '展开详情'}
              </button>
              <span className="muted small">外部工具 {found}/{total} · 检查 {report.checksRun.map((c) => CHECK_LABELS[c] ?? c).join('、')}</span>
            </div>
            {report.notes?.length ? (
              <ul className="health-notes muted small">{report.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            ) : null}
          </div>

          {detailsOpen && (
            <>
              <div className="health-filters-wrap" style={{ marginTop: 10 }}>
                <button type="button" className="link small" onClick={() => setFiltersOpen((v) => !v)} data-testid="health-filters-toggle">
                  {filtersOpen ? '收起筛选' : '筛选（可选）'}
                </button>
                {(filtersOpen || filtSev !== 'all' || filtCat !== 'all' || filtStatus !== 'open') && (
                  <div className="health-filters row gap" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                    <select value={filtSev} onChange={(e) => setFiltSev(e.target.value as FindingSeverity | 'all')} title="按严重级别筛选">
                      <option value="all">全部级别</option>
                      {SEVERITY_ORDER.map((s) => <option key={s} value={s}>{PLAIN_SEV[s]}（{SEVERITY_LABELS[s]}）</option>)}
                    </select>
                    <select value={filtCat} onChange={(e) => setFiltCat(e.target.value as FindingCategory | 'all')} title="按类别筛选">
                      <option value="all">全部类别</option>
                      {(Object.keys(CATEGORY_LABELS) as FindingCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                    </select>
                    <select value={filtStatus} onChange={(e) => setFiltStatus(e.target.value as FindingStatus | 'all')} title="按状态筛选">
                      <option value="all">全部状态</option>
                      {(Object.keys(STATUS_LABEL) as FindingStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                    </select>
                    <span className="muted small">显示 {filtered.length}/{report.findings.length}</span>
                  </div>
                )}
              </div>

              <div className="health-findings" data-testid="health-findings">
                {!filtered.length && <p className="muted">没有符合筛选的发现项。</p>}
                {SEVERITY_ORDER.map((sev) => {
                  const list = grouped.get(sev) || []
                  if (!list.length) return null
                  const open = groupOpen[sev] !== false
                  return (
                    <div key={sev} className={`health-group ${sevClass(sev)}`}>
                      <button type="button" className="health-group-h" onClick={() => setGroupOpen((g) => ({ ...g, [sev]: !open }))}>
                        <Icon name={open ? 'chevron-down' : 'chevron'} size={14} />
                        <b>{PLAIN_SEV[sev]}</b>
                        <span className="muted">{list.length}</span>
                      </button>
                      {open && list.map((f) => (
                        <article key={f.id} className="health-finding" data-testid="health-finding">
                          <div className="hf-top">
                            <span className={`hf-sev ${sevClass(f.severity)}`}>{PLAIN_SEV[f.severity]}</span>
                            <span className="hf-cat muted">{CATEGORY_LABELS[f.category] ?? f.category}</span>
                            <b className="hf-title">{f.title}</b>
                            <span className="muted small">{STATUS_LABEL[f.status]} · {f.source}</span>
                          </div>
                          {f.detail && <p className="hf-detail muted small">{f.detail.slice(0, 400)}</p>}
                          {f.evidence.path && (
                            <button type="button" className="link small mono" onClick={() => openEvidence(f)}
                              title="打开相关文件 / 跳到变更或追溯">
                              {f.evidence.path}{f.evidence.line != null ? `:${f.evidence.line}` : ''}
                            </button>
                          )}
                          {f.evidence.snippet && <pre className="hf-snip">{f.evidence.snippet}</pre>}
                          {(f.fix || f.impact) && (
                            <p className="muted small">{f.fix ? `修复：${f.fix}` : ''}{f.impact ? ` · 影响：${f.impact}` : ''}</p>
                          )}
                          {f.status === 'open' && (
                            <div className="btn-group hf-actions">
                              <button className="btn btn-xs" onClick={() => void setStatus(f, 'fixed')} title="标记为已修复">已修复</button>
                              <button className="btn btn-xs" onClick={() => void setStatus(f, 'ignored')} title="忽略此条">忽略</button>
                              <button className="btn btn-xs" onClick={() => void setStatus(f, 'false_positive')} title="标记为误报">误报</button>
                            </div>
                          )}
                          {f.status !== 'open' && (
                            <button className="link small" onClick={() => void setStatus(f, 'open')} title="重新打开">重新打开</button>
                          )}
                        </article>
                      ))}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
