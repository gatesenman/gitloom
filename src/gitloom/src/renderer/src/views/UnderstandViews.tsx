// 0.6.1 看懂改动 (summary-first flow: 全局摘要 → 影响模块 → 逐文件) and 当前架构 (C4 单侧: 系统上下文 → 容器 → 组件).
// Everything shown is computed statically from the viz analysis; AI explanation is optional. Every claim links to code.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VizResult, VizScope, VizViewId, VizAIResult } from '@shared/viz'
import type { BranchInfo } from '@shared/types'
import { viz, git, errMsg } from '../api'
import { clusterChangedFiles, filterFilesByCluster, CLUSTER_KIND_LABEL, type FileCluster } from '../lib/fileClusters'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Spinner, usePersistentState, useToast } from '../components/ui'
import { parkViz, softParkViz } from '../lib/vizNav'
import { buildSummary, buildC4, type Evidence, type Confidence, type ChangeSummary } from '../lib/changeSummary'
import { buildReviewBrief, downloadTextFile, reviewBriefFilename } from '../lib/reviewBrief'

const CONF: Record<Confidence, { label: string; tip: string }> = {
  high: { label: '高', tip: '置信度高：有源码依赖或统计数据直接佐证' },
  medium: { label: '中', tip: '置信度中：基于目录命名或部分数据推断' },
  low: { label: '低', tip: '置信度低：信息不足，仅供参考' }
}
const ConfBadge = ({ c }: { c: Confidence }) => <span className={`conf conf-${c}`} title={CONF[c].tip}>置信度 {CONF[c].label}</span>
const STATUS_TXT: Record<string, string> = { added: '新增', removed: '删除', modified: '修改', moved: '移动', unchanged: '未变' }

/** Friendly state block: one icon, one sentence, at most one primary action. */
export function Empty({ icon, title, text, action, tone }: { icon: string; title: string; text?: string; action?: { label: string; onClick: () => void }; tone?: 'err' }) {
  return <div className={`us-empty ${tone ?? ''}`} data-testid="us-empty" role={tone === 'err' ? 'alert' : undefined}><span className="us-empty-ic"><Icon name={icon} size={22} /></span><b>{title}</b>{text && <p>{text}</p>}{action && <button className="btn btn-primary" onClick={action.onClick}>{action.label}</button>}</div>
}
export function Loading({ text }: { text: string }) {
  return <div className="us-loading" data-testid="us-loading" aria-live="polite"><Spinner /><span>{text}</span><div className="us-skel"><i /><i /><i /></div></div>
}

type Preview = { title: string; text?: string; lines?: { t: string; text: string; a?: number; b?: number }[]; loading?: boolean; error?: string }

function PreviewPane({ p, onClose }: { p: Preview; onClose: () => void }) {
  return (
    <div className="us-preview" data-testid="us-preview">
      <div className="us-preview-h"><Icon name="file" size={13} /><b>{p.title}</b><div className="flex1" /><button className="btn btn-sm btn-ghost" onClick={onClose} title="关闭预览">✕</button></div>
      {p.loading ? <div className="us-pad"><Spinner /> 读取代码…</div> : p.error ? <div className="us-pad err">{p.error}</div>
        : p.lines ? <pre className="us-code">{p.lines.map((l, i) => <div key={i} className={`ln ln-${l.t}`}><span className="no">{l.a ?? l.b ?? ''}</span>{l.text}</div>)}</pre>
        : <pre className="us-code">{(p.text || '（没有差异内容）').split('\n').map((l, i) => <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'ln ln-add' : l.startsWith('-') && !l.startsWith('---') ? 'ln ln-del' : l.startsWith('@@') ? 'ln ln-hunk' : 'ln'}>{l}</div>)}</pre>}
    </div>
  )
}

function EvLinks({ ev, open }: { ev: Evidence[]; open: (e: Evidence) => void }) {
  if (!ev.length) return <span className="muted small" title="这条结论来自整体统计，没有单个文件位置">（整体统计）</span>
  return <span className="ev-links">{ev.map((e, i) => <button key={i} className="ev" onClick={() => open(e)} title={`查看代码：${e.file}${e.line ? `:${e.line}` : ''}${e.note ? ` — ${e.note}` : ''}`} data-testid="ev-link"><Icon name="file" size={11} />{e.file.split('/').pop()}{e.line ? `:${e.line}` : ''}{e.note && <i> · {e.note}</i>}</button>)}</span>
}

export function useAnalysis(repo: string | null, scope: VizScope | null) {
  const [res, setRes] = useState<VizResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [prog, setProg] = useState('')
  const ctl = useRef<AbortController | null>(null)
  const key = JSON.stringify([repo, scope])
  const run = useCallback(async () => {
    if (!repo || !scope) return
    ctl.current?.abort(); const c = new AbortController(); ctl.current = c
    setBusy(true); setErr(null); setRes(null)
    try { const r = await viz.analyze({ repo, scope, hops: 2 }, (p) => setProg(p.text), c.signal); if (!c.signal.aborted) setRes(r) }
    catch (e) { if (!c.signal.aborted) setErr(errMsg(e)) } finally { if (!c.signal.aborted) setBusy(false) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void run(); return () => ctl.current?.abort() }, [run])
  return { res, busy, err, prog, run }
}

type ScopeK = 'working' | 'commit' | 'refs'

export function SummaryView() {
  const { active, setView } = useApp()
  const toast = useToast()
  const [k, setK] = usePersistentState<ScopeK>('gitloom.summary.scope', 'working')
  const [base, setBase] = useState('')
  const [head, setHead] = useState('')
  const [branches, setBranches] = useState<BranchInfo[]>([])
  useEffect(() => {
    if (!active) return
    git.branches(active).then((b) => {
      setBranches(b)
      const cur = b.find((x) => x.current)?.name ?? ''
      const main = b.find((x) => !x.remote && (x.name === 'main' || x.name === 'master'))?.name ?? ''
      setHead((h) => h || cur); setBase((v) => v || (main && main !== cur ? main : b.find((x) => !x.remote && x.name !== cur)?.name ?? ''))
    }).catch(() => setBranches([]))
  }, [active])
  const scope: VizScope | null = k === 'working' ? { kind: 'working' } : k === 'commit' ? { kind: 'commit', sha: 'HEAD' } : base && head && base !== head ? { kind: 'refs', base, head } : null
  useEffect(() => { if (active && scope) softParkViz({ repo: active, scope }) }, [active, scope])
  const { res, busy, err, prog, run } = useAnalysis(active, scope)
  const sum: ChangeSummary | null = useMemo(() => (res ? buildSummary(res) : null), [res])
  const [pv, setPv] = useState<Preview | null>(null)
  const [ai, setAi] = useState<{ running: boolean; text?: string; result?: VizAIResult; error?: string }>({ running: false })
  const [modSel, setModSel] = useState<string | null>(null)
  const [clusterSel, setClusterSel] = useState<string | null>(null)
  const [clusters, setClusters] = useState<FileCluster[]>([])
  const [authorsBusy, setAuthorsBusy] = useState(false)
  useEffect(() => { setAi({ running: false }); setPv(null); setClusterSel(null); setClusters([]) }, [res])

  const openFile = useCallback(async (e: Evidence) => {
    if (!res) return
    const f = res.files.find((x) => x.path === e.file)
    setPv({ title: e.file, loading: true })
    try {
      if (f) setPv({ title: `${e.file}（改动）`, text: await viz.patch(res.id, f.path, f.oldPath) })
      else { const s = await viz.snippet(res.id, { after: { file: e.file, line: e.line ?? 1, endLine: (e.line ?? 1) + 40 } }); setPv({ title: e.file, lines: s.lines }) }
    } catch (x) { setPv({ title: e.file, error: errMsg(x) }) }
  }, [res])
  /** Open VizView with parked scope. `tab` forces a sub-tool (e.g. impact from file row); omit to keep last-used viz tab (default arch). */
  const deep = (tab?: VizViewId, filter?: string) => {
    if (!active || !scope) return
    if (tab) {
      sessionStorage.setItem('gitloom.tab', `viz-${tab}-`); setTimeout(() => sessionStorage.removeItem('gitloom.tab'), 800)
    }
    parkViz({ repo: active, scope, filter }); setView('viz')
  }
  const openViz = () => deep(undefined)
  const exportBrief = async (mode: 'download' | 'copy') => {
    if (!sum || !active) return
    const scopeLabel = k === 'working' ? '工作区改动' : k === 'commit' ? '最新提交' : `比较分支 ${base} → ${head}`
    const md = buildReviewBrief(sum, { repoName: active.split(/[\\/]/).pop(), scopeLabel })
    if (mode === 'copy') {
      try { await navigator.clipboard.writeText(md); toast('ok', '已复制审阅一页纸') }
      catch { toast('err', '复制失败') }
      return
    }
    downloadTextFile(reviewBriefFilename(active.split(/[\\/]/).pop()), md)
    toast('ok', '已下载审阅一页纸（Markdown）')
  }
  const runAI = async () => {
    if (!res) return
    setAi({ running: true })
    try { const r = await viz.ai(res.id, (p) => setAi((a) => ({ ...a, text: p.text }))); setAi({ running: false, result: r }) }
    catch (x) { setAi({ running: false, error: errMsg(x) }) }
  }
  const files = sum ? (modSel ? sum.files.filter((f) => f.module === modSel) : sum.files) : []
  useEffect(() => {
    if (!active || !sum?.files?.length) { setClusters([]); return }
    let cancelled = false
    const paths = sum.files.map((f) => f.path)
    const range = k === 'refs' && base && head && base !== head ? `${base}..${head}` : undefined
    setAuthorsBusy(true)
    void git.fileAuthors(active, paths, { range, max: 100 }).then((rows) => {
      if (cancelled) return
      const byPath = new Map(rows.map((r) => [r.path.replace(/\\/g, '/'), r]))
      const input = paths.map((path) => {
        const r = byPath.get(path.replace(/\\/g, '/'))
        return { path, author: r?.author, subjects: r?.subject ? [r.subject] : undefined }
      })
      setClusters(clusterChangedFiles(input))
    }).catch(() => {
      if (!cancelled) setClusters(clusterChangedFiles(paths.map((path) => ({ path }))))
    }).finally(() => { if (!cancelled) setAuthorsBusy(false) })
    return () => { cancelled = true }
  }, [active, sum, k, base, head])
  const clusteredFiles = filterFilesByCluster(files, clusters, clusterSel)

  return (
    <div className="us-root" data-testid="summary-view">
      <div className="us-bar">
        <div className="seg" role="tablist" title="选择要看懂的改动范围">
          {([['working', '工作区改动', '还没提交的全部改动（对比最新提交）'], ['commit', '最新提交', '最近一次提交改了什么'], ['refs', '比较分支', '两个分支之间的全部差异（类似合并请求）']] as const).map(([id, l, t]) =>
            <button key={id} className={k === id ? 'on' : ''} onClick={() => setK(id)} title={t} data-testid={`us-scope-${id}`}>{l}</button>)}
        </div>
        {k === 'refs' && <>
          <select value={base} onChange={(e) => setBase(e.target.value)} title="基准分支（改动之前）" data-testid="us-base">{branches.map((b) => <option key={b.fullRef} value={b.name}>{b.name}</option>)}</select>
          <span className="muted">→</span>
          <select value={head} onChange={(e) => setHead(e.target.value)} title="对比分支（改动之后）" data-testid="us-head">{branches.map((b) => <option key={b.fullRef} value={b.name}>{b.name}</option>)}</select>
        </>}
        <button className="btn btn-sm btn-ghost" onClick={() => void run()} disabled={busy} title="重新分析" aria-label="重新分析"><Icon name="fetch" size={13} /></button>
        <div className="flex1" />
        <div className="us-deep" role="group" aria-label="打开可视化与导出">
        <button className="btn btn-sm btn-primary" onClick={openViz} disabled={!scope} title="带着当前范围打开可视化（前后对比图 / 代码地图 / 阅读路线等工具在可视化内切换）" data-testid="us-open-viz"><Icon name="viz" size={13} /><span className="lbl">打开可视化</span></button>
        <button className="btn btn-sm" onClick={() => void exportBrief('download')} disabled={!sum} title="导出 Markdown 审阅一页纸（范围、风险、文件列表）" data-testid="us-export-brief"><Icon name="file" size={13} /><span className="lbl">导出审阅一页纸</span></button>
        <button className="btn btn-sm btn-ghost" onClick={() => void exportBrief('copy')} disabled={!sum} title="复制审阅一页纸到剪贴板" data-testid="us-copy-brief">复制一页纸</button>
        </div>
      </div>
      {!active ? <Empty icon="repo" title="还没有选择仓库" text="在左侧选择一个仓库，这里会用三步讲清楚它改了什么。" />
        : !scope ? <Empty icon="branch" title="选两个不同的分支" text="「比较分支」需要基准和对比两个不同的分支，例如 main → 你的功能分支。" />
        : busy ? <Loading text={`正在分析改动… ${prog}`} />
        : err ? <Empty icon="warn" tone="err" title="分析失败" text={err} action={{ label: '重试', onClick: () => void run() }} />
        : sum && sum.stats.files === 0 ? <Empty icon="ok" title={k === 'working' ? '工作区很干净' : '这里没有改动'} text={k === 'working' ? '还没有未提交的改动。可以看看最新一次提交改了什么。' : '两侧内容相同，换个范围试试。'} action={k === 'working' ? { label: '看最新提交', onClick: () => setK('commit') } : { label: '看工作区改动', onClick: () => setK('working') }} />
        : sum && res && (
          <div className="us-body">
            <div className="us-main">
              <section className="us-card" data-testid="us-global">
                <h3 title="整体统计，全部由静态分析得出">① 全局摘要</h3>
                <p className="us-headline" data-testid="us-headline">{sum.headline.text} <ConfBadge c={sum.headline.confidence} /></p>
                <div className="us-stats">
                  <span title="改动的文件数"><b>{sum.stats.files}</b> 文件</span>
                  <span title="新增 / 删除的行数"><b className="ad">+{sum.stats.add}</b> <b className="rm">−{sum.stats.del}</b> 行</span>
                  <span title="新增 / 删除 / 修改的函数"><b>{sum.stats.fnAdded}/{sum.stats.fnRemoved}/{sum.stats.fnModified}</b> 函数 增/删/改</span>
                  <span title="新增或删除的模块间依赖"><b>{sum.stats.depsChanged}</b> 依赖变化</span>
                  <span title="涉及的模块（组件）"><b>{sum.stats.modules}</b> 模块</span>
                  <span title="没有改、但引用了被改文件、可能受影响的文件"><b>{sum.stats.affectedFiles}</b> 间接受影响</span>
                </div>
                <div className="us-sub"><span className="muted small">依据：</span><EvLinks ev={sum.headline.evidence} open={openFile} /></div>
                <div className="us-h4row"><h4 title="根据文件引用关系、改动规模和类型推断的风险，每条都列出依据文件">风险提示 <span className="muted small">{sum.risks.length} 条</span></h4>
                  <span className="us-legend" data-testid="us-legend" title="风险等级 = 出问题的后果；置信度 = 这条结论有多大把握">
                    <span><i className="lvl lvl-高">高</i>可能直接出错</span><span><i className="lvl lvl-中">中</i>需要重点看</span><span><i className="lvl lvl-低">低</i>留意即可</span>
                    <span className="sep" /><span>置信度：结论有多大把握</span>
                  </span></div>
                {sum.risks.length === 0 ? <div className="muted" data-testid="us-norisk">没有发现明显风险。</div> : (
                  <ul className="us-risks" data-testid="us-risks" aria-label="风险提示">
                    {sum.risks.map((r) => <li key={r.id} data-risk={r.id}><span className={`lvl lvl-${r.level}`} title={`风险等级：${r.level}`}>{r.level}</span><b>{r.title}</b> <ConfBadge c={r.confidence} /><div className="muted small">{r.detail}</div><EvLinks ev={r.evidence} open={openFile} /></li>)}
                  </ul>)}
                <div className="us-ai">
                  {ai.result ? <div data-testid="us-ai-result"><b>AI 解释：</b>{ai.result.headline} {ai.result.risk && <span className={`lvl lvl-${ai.result.risk === 'high' ? '高' : ai.result.risk === 'medium' ? '中' : '低'}`}>{ai.result.risk === 'high' ? '高风险' : ai.result.risk === 'medium' ? '中风险' : '低风险'}</span>}<div className="muted small">AI 生成，仅供参考；以上静态结论不依赖 AI。</div></div>
                    : <button className="btn btn-sm" onClick={() => void runAI()} disabled={ai.running} title="可选：让 AI 用一句话解释这次改动的意图与风险（使用「设置 → AI 模型」）" data-testid="us-ai"><Icon name="wand" size={13} />{ai.running ? ' AI 解释中…' : ' AI 解释（可选）'}</button>}
                  {ai.error && <div className="err small">{ai.error}</div>}
                </div>
              </section>
              <section className="us-card" data-testid="us-modules">
                <h3 title="按架构组件归类的改动；点击只看该模块的文件">② 影响模块 <span className="muted small">{sum.modules.length} 个</span></h3>
                <div className="us-mods">
                  {sum.modules.map((m) => <button key={m.id} className={`us-mod st-${m.status}${modSel === m.id ? ' on' : ''}`} onClick={() => setModSel(modSel === m.id ? null : m.id)} title={`${m.layer} / ${m.name}：${STATUS_TXT[m.status]}，改了 ${m.changed} 个文件${m.blast ? `，最大影响面 ${m.blast}` : ''}。点击筛选下方文件`} data-testid="us-mod">
                    <span className="layer">{m.layer}</span><b>{m.name}</b><span className="muted small">{STATUS_TXT[m.status]} · {m.changed} 文件{m.blast ? ` · 影响 ${m.blast}` : ''}</span></button>)}
                  {!sum.modules.length && <span className="muted">没有可归类的模块（可能只改了文档或配置）。</span>}
                </div>
              </section>
              <section className="us-card" data-testid="us-files">
                <h3 title="按影响面从大到小排列；点击查看改动内容">③ 逐文件 <span className="muted small">{clusteredFiles.length} 个{modSel && <> · <button className="link" onClick={() => setModSel(null)}>显示全部</button></>}{clusterSel && <> · <button className="link" onClick={() => setClusterSel(null)} data-testid="us-cluster-clear">清除聚类筛选</button></>}</span></h3>
                <div className="us-clusters" data-testid="us-clusters" title="按目录 / 作者 / AI 痕迹把改动文件归组，点击可筛选下方列表">
                  <span className="muted small">改动聚类{authorsBusy ? '（识别作者中…）' : ''}：</span>
                  {!clusters.length && <span className="muted small">暂无</span>}
                  {clusters.map((c) => (
                    <button key={c.id} type="button" className={`us-cluster kind-${c.kind}${clusterSel === c.id ? ' on' : ''}`}
                      data-testid="us-cluster" data-cluster-kind={c.kind} data-cluster-id={c.id}
                      title={c.tip} onClick={() => setClusterSel(clusterSel === c.id ? null : c.id)}>
                      <em className="us-cluster-kind">{CLUSTER_KIND_LABEL[c.kind]}</em>
                      <b>{c.label}</b>
                      <span className="muted small">{c.count}</span>
                    </button>
                  ))}
                </div>
                <table className="us-table"><thead><tr><th>文件</th><th title="新增/删除/修改/移动">状态</th><th className="num" title="新增与删除的行数">行</th><th className="num" title="函数 新增/删除/修改">函数</th><th className="num" title="直接或间接引用此文件的文件数">影响面</th><th /></tr></thead>
                  <tbody>{clusteredFiles.map((f) => <tr key={f.path} data-testid="us-file">
                    <td><button className="link" onClick={() => void openFile({ file: f.path })} title="查看这个文件的改动">{f.path}</button>{f.hub && <span className="us-hot" title="热点文件：被很多文件引用，改动影响面大">热点</span>}</td>
                    <td className="nw"><span className={`us-st st-${f.status}`}>{STATUS_TXT[f.status]}</span></td><td className="num"><b className="ad">+{f.add}</b> <b className="rm">−{f.del}</b></td>
                    <td className="num">{f.fns ? `${f.fns[0]}/${f.fns[1]}/${f.fns[2]}` : '—'}</td><td className="num">{f.blast || '—'}</td>
                    <td><button className="btn btn-xs btn-ghost" onClick={() => deep('impact', f.path)} title="在影响范围图中查看这个文件">影响图</button></td></tr>)}</tbody></table>
              </section>
            </div>
            {pv && <PreviewPane p={pv} onClose={() => setPv(null)} />}
          </div>)}
    </div>
  )
}

export function ArchitectureView() {
  const { active, project } = useApp()
  const scope = useMemo<VizScope>(() => ({ kind: 'commit', sha: 'HEAD' }), [])
  const { res, busy, err, prog, run } = useAnalysis(active, scope)
  const repoName = active?.split(/[\\/]/).pop() ?? ''
  const c4 = useMemo(() => (res ? buildC4(res, repoName) : null), [res, repoName])
  const [level, setLevel] = usePersistentState<1 | 2 | 3>('gitloom.c4.level', 3)
  const [pv, setPv] = useState<Preview | null>(null)
  const open = async (e: Evidence) => {
    if (!res) return
    setPv({ title: e.file, loading: true })
    try { const s = await viz.snippet(res.id, { after: { file: e.file, line: e.line ?? 1, endLine: (e.line ?? 1) + 40 } }); setPv({ title: `${e.file}:${e.line ?? 1}`, lines: s.lines }) } catch (x) { setPv({ title: e.file, error: errMsg(x) }) }
  }
  void project
  return (
    <div className="us-root" data-testid="arch-view">
      <div className="us-bar">
        <b title="当前代码（最新提交）的架构，单侧，不做前后对比">当前架构</b><span className="muted small" title="C4 是常用的分层架构描述法：系统 → 容器 → 组件">C4 · 最新提交</span>
        <nav className="c4-crumb" aria-label="C4 层级" title="C4 三级：由粗到细，点击切换显示到哪一级">
          {([[1, '系统上下文', '整个系统与外部依赖', c4 ? c4.system.name : ''], [2, '容器', '按分层（界面/服务/基础设施…）', c4 ? `${c4.containers.length} 层` : ''], [3, '组件', '每层里的模块及其依赖', c4 ? `${c4.containers.reduce((n, c) => n + c.components.length, 0)} 个` : '']] as const).map(([l, t, tip, n], i) =>
            <React.Fragment key={l}>{i > 0 && <Icon name="chevron" size={12} className="c4-sep" />}<button className={`${level === l ? 'on' : ''} ${level > l ? 'past' : ''}`} aria-current={level === l ? 'step' : undefined} onClick={() => setLevel(l)} title={tip} data-testid={`c4-level-${l}`}><span className="c4-n">{l}</span>{t}{n && <em>{n}</em>}</button></React.Fragment>)}
        </nav>
        <div className="flex1" />
        <button className="btn btn-sm btn-ghost" onClick={() => void run()} disabled={busy} title="重新分析" aria-label="重新分析"><Icon name="fetch" size={13} /></button>
      </div>
      {!active ? <Empty icon="repo" title="还没有选择仓库" text="在左侧选择一个仓库，这里会画出它现在的分层架构，每一项都附源码位置。" /> : busy ? <Loading text={`正在分析当前代码… ${prog}`} /> : err ? <Empty icon="warn" tone="err" title="分析失败" text={err} action={{ label: '重试', onClick: () => void run() }} /> : c4 && (
        <div className="us-body"><div className="us-main">
          <div className="c4-legend" data-testid="c4-legend">
            <span title="C4 第 1 级"><i className="c4-sw sys" />系统</span><span title="系统调用的外部服务"><i className="c4-sw ext" />外部系统</span><span title="C4 第 2 级：分层"><i className="c4-sw cont" />容器（分层）</span>
            <span className="sep" /><span className="conf conf-high" title={CONF.high.tip}>高</span><span className="conf conf-medium" title={CONF.medium.tip}>中</span><span className="conf conf-low" title={CONF.low.tip}>低</span><span className="muted">置信度</span>
            <span className="sep" /><span className="muted"><Icon name="file" size={11} /> 点击文件名查看源码依据</span>
          </div>
          <section className="us-card c4-l1" data-testid="c4-l1">
            <h3 title="C4 第 1 级：系统作为一个整体，以及它调用的外部系统">1. 系统上下文</h3>
            <div className="c4-sys"><div className="c4-box sys"><b>{c4.system.name}</b><span className="muted small">{c4.system.files} 个文件 · {c4.system.langs.join(' / ') || '—'}{c4.system.routes ? ` · ${c4.system.routes} 个接口` : ''}</span></div>
              {c4.externals.length > 0 && <><span className="c4-arrow">→</span><div className="c4-ext">{c4.externals.map((x) => <div key={x.name} className="c4-box ext" title="外部系统（由调用时序推断）"><b>{x.name}</b><EvLinks ev={x.evidence} open={open} /></div>)}</div></>}
            </div>
          </section>
          {level >= 2 && <section className="us-card" data-testid="c4-l2">
            <h3 title="C4 第 2 级：系统内部的分层（容器）">2. 容器（分层）</h3>
            <div className="c4-containers">{c4.containers.map((c) => <button key={c.id} className="c4-box cont" data-testid="c4-container" title={`查看「${c.name}」里的组件`} onClick={() => { setLevel(3); setTimeout(() => document.getElementById(`c4g-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60) }}><b>{c.name}</b><span className="muted small">{c.components.length} 个组件</span><ConfBadge c={c.confidence} /></button>)}</div>
          </section>}
          {level >= 3 && <section className="us-card" data-testid="c4-l3">
            <h3 title="C4 第 3 级：每层里的组件、它依赖谁，以及源码依据">3. 组件</h3>
            {c4.containers.map((c) => <div key={c.id} className="c4-group" id={`c4g-${c.id}`}><h4>{c.name} <span className="muted small">{c.components.length} 个组件</span></h4>
              <table className="us-table c4-table"><colgroup><col className="w-name" /><col className="w-n" /><col /><col className="w-n" /><col className="w-ev" /><col className="w-conf" /></colgroup><thead><tr><th>组件</th><th className="num">文件</th><th title="这个组件 import 了哪些组件（次数）">依赖</th><th className="num" title="有多少组件依赖它">被依赖</th><th title="源码位置：组件内被引用最多的文件">依据</th><th>置信度</th></tr></thead>
                <tbody>{c.components.map((m) => <tr key={m.id} data-testid="c4-comp"><td><b>{m.name}</b></td><td className="num">{m.files}</td><td className="small">{m.dependsOn.map((d) => `${d.name}×${d.count}`).join('、') || '—'}</td><td className="num">{m.usedBy || '—'}</td><td><EvLinks ev={m.evidence} open={open} /></td><td><ConfBadge c={m.confidence} /></td></tr>)}</tbody></table></div>)}
          </section>}
          <div className="muted small c4-notes">{c4.notes.map((n) => <div key={n}>· {n}</div>)}</div>
        </div>{pv && <PreviewPane p={pv} onClose={() => setPv(null)} />}</div>)}
    </div>
  )
}
