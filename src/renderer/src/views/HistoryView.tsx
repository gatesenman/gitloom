import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { CommitDetail, CommitInfo } from '@shared/types'
import { app, errMsg, git } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { aiTag } from '../lib/aiRun'
import { AI_CACHE, aiLabel, useAIRunner } from '../hooks/useAIRun'
import { CommitExplainButton, CommitExplainPanel } from '../components/AIResult'
import { DiffPane } from '../components/DiffPane'
import { GRAPH_COLORS, layoutGraph, type GraphRow } from '../lib/graph'
import { Empty, Resizer, Skeleton, StatusBadge, fullTime, hashColor, relTime, useDialog, useMenu, useToast, usePersistentState } from '../components/ui'

const ROW_H = 32
const LANE_W = 18

function RefBadges({ refs }: { refs: string[] }) {
  return <>{refs.map((r) => {
    let cls = 'ref-local'; let label = r
    if (r.startsWith('HEAD -> ')) { cls = 'ref-head'; label = r.slice(8) }
    else if (r === 'HEAD') cls = 'ref-head'
    else if (r.startsWith('tag: ')) { cls = 'ref-tag'; label = r.slice(5) }
    else if (r.includes('/')) cls = 'ref-remote'
    return <span key={r} className={`ref ${cls}`} title={r}>{cls === 'ref-tag' ? <Icon name="tag" size={10} /> : cls === 'ref-remote' ? <Icon name="cloud" size={10} /> : <Icon name="branch" size={10} />}{label}</span>
  })}</>
}

function GraphCell({ row, width, hover, author, merge, head }: { row: GraphRow; width: number; hover: number | null; author: string; merge: boolean; head: boolean }) {
  const w = Math.max(width, 1) * LANE_W + 8
  const x = (c: number) => 4 + c * LANE_W + LANE_W / 2
  const y = (f: number) => f * ROW_H
  const col = (c: number) => GRAPH_COLORS[c % GRAPH_COLORS.length]
  const op = (c: number) => (hover === null || hover === c ? 1 : 0.4)
  const nodeColor = col(row.color)
  const cx = x(row.col), cy = ROW_H / 2
  return (
    <svg width={w} height={ROW_H} className="graph-svg">
      {row.segments.map((s, i) => {
        const x1 = x(s.x1), y1 = y(s.y1), x2 = x(s.x2), y2 = y(s.y2)
        const sw = hover === s.color ? 2.6 : 2
        if (x1 === x2) return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={col(s.color)} strokeWidth={sw} strokeLinecap="round" opacity={op(s.color)} />
        // smooth S-curve: leave vertically, arrive vertically
        const dy = y2 - y1
        return <path key={i} d={`M${x1} ${y1} C ${x1} ${y1 + dy * 0.62}, ${x2} ${y2 - dy * 0.62}, ${x2} ${y2}`} stroke={col(s.color)} strokeWidth={sw} strokeLinecap="round" fill="none" opacity={op(s.color)} />
      })}
      <g opacity={op(row.color)}>
        {head && <circle cx={cx} cy={cy} r={11} fill="none" stroke={nodeColor} strokeWidth={1.5} opacity={0.55} />}
        {merge ? (
          <circle cx={cx} cy={cy} r={4.5} fill="var(--bg)" stroke={nodeColor} strokeWidth={2.2} />
        ) : (
          <>
            <circle cx={cx} cy={cy} r={8.5} fill={nodeColor} stroke="var(--bg)" strokeWidth={2} />
            <text x={cx} y={cy + 3.4} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#fff" style={{ fontFamily: 'var(--font-ui)', pointerEvents: 'none' }}>{author.slice(0, 1).toUpperCase()}</text>
          </>
        )}
      </g>
    </svg>
  )
}

export default function HistoryView({ mode }: { mode: 'history' | 'graph' }) {
  const { active, settings, run, tick, status, setView } = useApp()
  const repo = active!
  const menu = useMenu()
  const dialog = useDialog()
  const toast = useToast()
  const [commits, setCommits] = useState<CommitInfo[] | null>(null)
  const [all, setAll] = useState(mode === 'graph')
  const [query, setQuery] = useState('')
  const [grep, setGrep] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [listH, setListH] = useState(420)
  const [detailH, setDetailH] = usePersistentState('gitloom.history.detailH', 340)
  // AI 解释: one runner for the view (single-flight, aborts on stop / commit switch / unmount), results cached per
  // repo + sha + provider/model. HistoryView itself never subscribes to it, so streaming tokens don't re-render the list.
  const explainRun = useAIRunner(AI_CACHE.commitExplain)
  const [explainOpen, setExplainOpen] = useState(false)
  const aiKey = aiTag(settings?.ai, 'explain')
  const explainKey = (sha: string): string => `${repo}|${sha}|${aiKey}`
  const [hover, setHover] = useState<number | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const headSha = status?.headSha

  useEffect(() => { setAll(mode === 'graph') }, [mode])
  useEffect(() => {
    let alive = true
    git.log(repo, { limit: settings?.graphLimit ?? 800, all, grep: grep || undefined })
      .then((c) => {
        if (!alive) return
        setCommits(c)
        const want = sessionStorage.getItem('gitloom.select')
        if (want && /^\d+$/.test(want) && c[Number(want)]) { sessionStorage.removeItem('gitloom.select'); setSelected(c[Number(want)].hash) }
      }).catch((e) => { if (alive) { setCommits([]); toast('err', errMsg(e)) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, all, grep, headSha, settings?.graphLimit, tick % 8 === 0 ? tick : 0])
  useEffect(() => { setSelected(null); setDetail(null) }, [repo])
  useEffect(() => {
    if (!selected) { setDetail(null); return }
    git.commitDetail(repo, selected).then((d) => { setDetail(d); setFile(d.files[0]?.path ?? null) }).catch((e) => toast('err', errMsg(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, selected])
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setListH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const filtered = useMemo(() => {
    if (!commits) return []
    if (!query) return commits
    const q = query.toLowerCase()
    return commits.filter((c) => c.subject.toLowerCase().includes(q) || c.hash.startsWith(q) || c.author.toLowerCase().includes(q) || c.refs.some((r) => r.toLowerCase().includes(q)))
  }, [commits, query])
  const layout = useMemo(() => layoutGraph(query ? filtered.map((c) => ({ hash: c.hash, parents: [] })) : filtered), [filtered, query])
  const graphW = Math.min(layout.maxCols, 14)

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 10)
  const end = Math.min(filtered.length, Math.ceil((scrollTop + listH) / ROW_H) + 10)

  const commitMenu = (e: React.MouseEvent, c: CommitInfo) => menu(e, [
    { label: '检出此提交（分离 HEAD）', icon: 'check', onClick: async () => { if (await dialog({ title: '检出提交', message: `将检出 ${c.short}，进入分离 HEAD 状态。`, okText: '检出' })) await run('检出', () => git.checkout(repo, c.hash), `已检出 ${c.short}`) } },
    { label: '从此提交创建分支…', icon: 'branch', onClick: async () => { const r = await dialog({ title: '创建分支', message: `基于 ${c.short} ${c.subject}`, fields: [{ name: 'name', label: '分支名', placeholder: 'feature/xxx' }, { name: 'checkout', label: '创建后切换', type: 'checkbox', value: true }] }); if (r?.name) await run('创建分支', () => git.createBranch(repo, String(r.name), c.hash, !!r.checkout), `已创建分支 ${r.name}`) } },
    { label: '在此创建标签…', icon: 'tag', onClick: async () => { const r = await dialog({ title: '创建标签', fields: [{ name: 'name', label: '标签名', placeholder: 'v1.0.0' }, { name: 'msg', label: '附注（可选，填写则为附注标签）' }] }); if (r?.name) await run('创建标签', () => git.createTag(repo, String(r.name), c.hash, String(r.msg || '') || undefined), `已创建标签 ${r.name}`) } },
    { sep: true },
    { label: 'Cherry-pick 到当前分支', icon: 'cherry', onClick: () => run('Cherry-pick', () => git.cherryPick(repo, c.hash), '拣选成功') },
    { label: '还原此提交（revert）', icon: 'undo', onClick: () => run('还原', () => git.revert(repo, c.hash), '已创建还原提交') },
    { label: '将当前分支重置到此…', icon: 'refresh', danger: true, onClick: async () => {
      const r = await dialog({ title: '重置当前分支', message: `将 ${status?.branch ?? 'HEAD'} 重置到 ${c.short}`, fields: [{ name: 'mode', label: '模式', type: 'select', value: 'mixed', options: [
        { value: 'soft', label: 'soft — 保留改动并保持暂存' }, { value: 'mixed', label: 'mixed — 保留改动但取消暂存（默认）' }, { value: 'hard', label: 'hard — 丢弃所有改动（危险）' }] }], danger: true, okText: '重置' })
      if (r) await run('重置', () => git.reset(repo, c.hash, r.mode as 'soft' | 'mixed' | 'hard'), '重置完成')
    } },
    { sep: true },
    { label: 'AI 解释此提交', icon: 'ai', onClick: () => doExplain(c.hash) },
    { label: '复制 SHA', icon: 'copy', onClick: () => navigator.clipboard.writeText(c.hash) },
    { label: '复制提交信息', icon: 'copy', onClick: () => navigator.clipboard.writeText(c.subject) }
  ])
  const startExplain = (sha: string, force = false): void => {
    explainRun.start(explainKey(sha), (signal, onDelta) => app.aiStream('explainDiff', repo, { sha }, onDelta, signal), { force })
  }
  const doExplain = (sha: string): void => { setExplainOpen(true); startExplain(sha) }
  const toggleExplain = (): void => {
    if (!detail) return
    if (!explainOpen) { doExplain(detail.hash); return }
    if (explainRun.running) return            // 生成中: repeated clicks never start another request
    setExplainOpen(false)
  }
  // follow the selected commit: cached result shows instantly, an in-flight request for another commit is aborted
  useEffect(() => { explainRun.select(detail ? explainKey(detail.hash) : null) }, [explainRun, repo, detail?.hash, aiKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const closeExplain = (): void => { explainRun.stop(); setExplainOpen(false) }

  return (
    <div className="history">
      <div className="pane-toolbar">
        <div className="seg" role="tablist" aria-label="历史显示方式">
          <button role="tab" aria-selected={!all} className={!all ? 'on' : ''} onClick={() => setAll(false)} title="列表：只看当前分支的提交"><Icon name="list" size={13} />列表</button>
          <button role="tab" aria-selected={all} className={all ? 'on' : ''} onClick={() => setAll(true)} title="提交图：所有分支的提交与合并关系（原「分支图」）"><Icon name="graph" size={13} />提交图</button>
        </div>
        <div className="search wide"><Icon name="search" size={13} /><input placeholder="筛选：提交信息 / SHA / 作者 / 分支（回车在全部历史中搜索）" value={query}
          onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setGrep('') }} onKeyDown={(e) => { if (e.key === 'Enter') setGrep(query) }} /></div>
        <span className="muted">{commits ? `${filtered.length} 个提交` : ''}</span>
        <div className="flex1" />
        <button className="btn btn-sm" onClick={() => setView('branches')}><Icon name="branch" size={13} />分支</button>
      </div>
      {!!filtered.length && (
        <div className="commit-head">
          <div style={{ width: Math.max(graphW * LANE_W + 16, 44), paddingLeft: 12, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden' }}>图谱</div>
          <div className="flex1">描述</div>
          <div className="c-author">作者</div>
          <div className="c-date">时间</div>
          <div className="c-sha">SHA</div>
        </div>
      )}
      <div className="commit-list" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onMouseLeave={() => setHover(null)}>
        {!commits ? <Skeleton rows={14} variant="graph" /> : !filtered.length ? <Empty icon="history" title={query ? '没有匹配的提交' : '还没有提交'}>{query ? '换个关键词试试，或按回车在全部历史中搜索。' : '这个仓库还没有任何提交。在「变更」中暂存文件并完成第一次提交吧。以后想知道“某个功能是哪天合进来的”，就来这里看。'}</Empty> : (
          <div style={{ height: filtered.length * ROW_H, position: 'relative' }}>
            {filtered.slice(start, end).map((c, k) => {
              const i = start + k
              const row = layout.rows[i]
              const isHead = c.hash === headSha
              return (
                <div key={c.hash} className={`commit-row ${selected === c.hash ? 'sel' : ''} ${isHead ? 'head' : ''} ${hover !== null && row && row.color !== hover ? 'dim' : ''}`} style={{ top: i * ROW_H, height: ROW_H }}
                  onMouseEnter={() => row && setHover(row.color)}
                  onClick={() => setSelected(c.hash)} onContextMenu={(e) => { setSelected(c.hash); commitMenu(e, c) }}>
                  <div className="c-graph" style={{ width: graphW * LANE_W + 8 }}>{row && <GraphCell row={row} width={graphW} hover={hover} author={c.author} merge={c.parents.length > 1} head={isHead} />}</div>
                  <div className="c-subject"><RefBadges refs={c.refs} /><span className="c-msg">{c.subject}</span></div>
                  {c.signature && ['G', 'U'].includes(c.signature) && <span className="sig" title="已签名"><Icon name="check" size={11} />签名</span>}
                  <div className="c-author" title={`${c.author} <${c.email}>`}><span className="avatar sm" style={{ background: hashColor(c.author) }}>{c.author.slice(0, 1).toUpperCase()}</span><span>{c.author}</span></div>
                  <div className="c-date" title={fullTime(c.date)}>{relTime(c.date)}</div>
                  <div className="c-sha">{c.short}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {detail && (
        <>
          <Resizer vertical onResize={(d) => setDetailH((h) => Math.max(180, Math.min(800, h - d)))} />
          <div className="commit-detail" style={{ height: detailH }}>
            <div className="cd-left">
              <div className="cd-meta">
                <div className="cd-subject">{detail.subject}</div>
                {detail.body && <pre className="cd-body">{detail.body}</pre>}
                <div className="cd-line"><span className="avatar" style={{ background: hashColor(detail.author) }}>{detail.author.slice(0, 1).toUpperCase()}</span>{detail.author} &lt;{detail.email}&gt;</div>
                <div className="cd-line muted">{fullTime(detail.date)} · <code>{detail.short}</code>{detail.parents.length > 1 && <> · 合并提交（{detail.parents.length} 个父提交）</>}
                  {detail.signature && detail.signature !== 'N' && <> · 签名状态 {detail.signature}</>}</div>
                <div className="cd-refs"><RefBadges refs={detail.refs} /></div>
                <div className="cd-actions">
                  <button className="btn btn-xs" onClick={() => navigator.clipboard.writeText(detail.hash)}><Icon name="copy" size={12} />复制 SHA</button>
                  <CommitExplainButton runner={explainRun} open={explainOpen} onToggle={toggleExplain} />
                </div>
              </div>
              <div className="cd-files">
                <div className="file-section-head"><span>变更文件</span><em>{detail.files.length}</em></div>
                {detail.files.map((f) => (
                  <div key={f.path} className={`file-row ${file === f.path ? 'sel' : ''}`} onClick={() => setFile(f.path)} title={f.path}>
                    <StatusBadge code={f.status} />
                    <span className="file-name">{f.path.split('/').pop()}</span>
                    <span className="file-dir">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
                    <span className="stat"><i className="add">+{f.additions}</i><i className="del">−{f.deletions}</i></span>
                  </div>
                ))}
              </div>
            </div>
            <div className="cd-diff">
              {explainOpen && <CommitExplainPanel runner={explainRun} short={detail.short} model={aiLabel(settings?.ai, 'explain')}
                onGenerate={() => startExplain(detail.hash)} onRegenerate={() => startExplain(detail.hash, true)} onClose={closeExplain} />}
              <DiffPane repo={repo} file={file} source={{ kind: 'commit', sha: detail.hash, parent: detail.parents[0] }} origPath={detail.files.find((f) => f.path === file)?.origPath} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
