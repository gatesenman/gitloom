import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileChange } from '@shared/types'
import { app, errMsg, git } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { DiffPane, DiffModeToggle } from '../components/DiffPane'
import { useAIRunner, useRunState } from '../hooks/useAIRun'
import { AIDrawer } from '../components/AIResult'
import { clearHistory, filterHistory, loadDraft, loadHistory, rememberMessage, saveDraft, splitMessage } from '../lib/commitHistory'
import { HunkPanel } from '../components/HunkPanel'
import { MOD, Empty, Skeleton, Markdown, Resizer, Spinner, StatusBadge, useDialog, useMenu, useToast, usePersistentState } from '../components/ui'
import { CHANGES_DRAWER_OPEN_KEY, CHANGES_DRAWER_W_KEY, CHANGES_DRAWER_DEFAULT_W, clampDrawerWidth, changesDrawerClass, defaultDrawerOpen } from '../lib/changesDrawer'
import { abortConfirmMessage, abortLabel, canAbortOp, canContinueOp, conflictFileRows, continueLabel, shouldShowConflictWizard, wizardHeadline, wizardSubline, WIZARD_HINT } from '../lib/conflictWizard'

type Sel = { path: string; area: 'staged' | 'unstaged' | 'conflicted'; origPath?: string } | null

export default function ChangesView() {
  const { active, status, run, setView } = useApp()
  const repo = active!
  const menu = useMenu()
  const dialog = useDialog()
  const [sel, setSel] = useState<Sel>(null)
  const [tab, setTab] = useState<'diff' | 'hunks'>('diff')
  const [drawerOpen, setDrawerOpen] = usePersistentState(CHANGES_DRAWER_OPEN_KEY, defaultDrawerOpen())
  const [drawerW, setDrawerW] = usePersistentState(CHANGES_DRAWER_W_KEY, CHANGES_DRAWER_DEFAULT_W)
  const [filter, setFilter] = useState('')
  const drawerRef = React.useRef<HTMLDivElement>(null)

  // Esc collapses the docked drawer when focus is inside it (AI modal drawer handles its own Esc)
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.closest('.drawer, .modal, .ctx-menu, .more-menu, .palette, .msg-hist-pop, .commit-opts-pop')) return
      const el = drawerRef.current
      if (!el) return
      const focusInside = el.contains(document.activeElement)
      const targetInside = !!(t && el.contains(t))
      if (!focusInside && !targetInside) return
      e.preventDefault()
      setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerOpen, setDrawerOpen])

  // keep selection valid
  useEffect(() => {
    if (!status) return
    const all = [...status.conflicted.map((f) => ({ f, a: 'conflicted' as const })), ...status.unstaged.map((f) => ({ f, a: 'unstaged' as const })), ...status.staged.map((f) => ({ f, a: 'staged' as const }))]
    const want = sessionStorage.getItem('gitloom.select')
    const wanted = want ? all.find((x) => x.f.path === want) : undefined
    if (wanted) { sessionStorage.removeItem('gitloom.select'); setSel({ path: wanted.f.path, area: wanted.a, origPath: wanted.f.origPath }); const t = sessionStorage.getItem('gitloom.tab'); if (t === 'hunks' || t === 'diff') setTab(t); return }
    if (sel && all.some((x) => x.f.path === sel.path && x.a === sel.area)) return
    const same = sel && all.find((x) => x.f.path === sel.path)
    const next = same ?? all[0]
    setSel(next ? { path: next.f.path, area: next.a, origPath: next.f.origPath } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])
  const prevRepo = React.useRef(repo)
  useEffect(() => { if (prevRepo.current !== repo) { prevRepo.current = repo; setSel(null) } }, [repo])

  // keyboard: j/k (↓/↑) move between files, s = stage, u = unstage — ignored while typing or inside the diff editor
  const keyState = React.useRef({ status, sel, filter })
  keyState.current = { status, sel, filter }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.closest('.monaco-editor, .modal, .ctx-menu, .more-menu, .palette'))) return
      const { status: st, sel: cur, filter: q } = keyState.current
      if (!st) return
      const m = (f: FileChange) => !q || f.path.toLowerCase().includes(q.toLowerCase())
      const order = [...st.conflicted.filter(m).map((f) => ({ f, a: 'conflicted' as const })), ...st.unstaged.filter(m).map((f) => ({ f, a: 'unstaged' as const })), ...st.staged.filter(m).map((f) => ({ f, a: 'staged' as const }))]
      const i = cur ? order.findIndex((x) => x.f.path === cur.path && x.a === cur.area) : -1
      const k = e.key
      if (k === 'j' || k === 'k') {
        if (!order.length) return
        e.preventDefault()
        const n = order[Math.max(0, Math.min(order.length - 1, i + (k === 'j' ? 1 : -1)))]
        setSel({ path: n.f.path, area: n.a, origPath: n.f.origPath })
        requestAnimationFrame(() => document.querySelector('.file-row.sel')?.scrollIntoView({ block: 'nearest' }))
      } else if (k === 's' && cur && (cur.area === 'unstaged' || cur.area === 'conflicted')) {
        e.preventDefault()
        // keep the cursor on the next file so you can press s repeatedly
        const nxt = order.slice(i + 1).find((x) => x.a !== 'staged')
        void run(cur.area === 'conflicted' ? '标记解决' : '暂存', () => git.stage(repo, [cur.path])).then(() => { if (nxt) setSel({ path: nxt.f.path, area: nxt.a, origPath: nxt.f.origPath }) })
      } else if (k === 'u' && cur?.area === 'staged') {
        e.preventDefault()
        void run('取消暂存', () => git.unstage(repo, [cur.path]))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [repo, run])

  if (!status) return <Skeleton rows={10} />
  const match = (f: FileChange) => !filter || f.path.toLowerCase().includes(filter.toLowerCase())

  const fileMenu = (e: React.MouseEvent, f: FileChange, area: 'staged' | 'unstaged' | 'conflicted') => menu(e, [
    area === 'unstaged' ? { label: '暂存', icon: 'plus', onClick: () => run('暂存', () => git.stage(repo, [f.path])) }
      : area === 'staged' ? { label: '取消暂存', icon: 'minus', onClick: () => run('取消暂存', () => git.unstage(repo, [f.path])) }
      : { label: '标记为已解决', icon: 'check', onClick: () => run('标记解决', () => git.stage(repo, [f.path])) },
    ...(area === 'unstaged' ? [{ label: '丢弃改动', icon: 'undo', danger: true, onClick: async () => { if (await dialog({ title: '丢弃改动', message: `确定丢弃 ${f.path} 的所有改动吗？${f.untracked ? '（未跟踪文件将被删除）' : ''}`, danger: true, okText: '丢弃' })) await run('丢弃', () => git.discard(repo, [f.path])) } }] : []),
    { sep: true },
    { label: '添加到 .gitignore', icon: 'eye', onClick: () => run('忽略', () => git.ignore(repo, f.path), `已忽略 ${f.path}`) },
    { label: `忽略所有 *.${f.path.split('.').pop()} 文件`, onClick: () => run('忽略', () => git.ignore(repo, `*.${f.path.split('.').pop()}`)) },
    { sep: true },
    { label: '在编辑器中打开', icon: 'code', onClick: () => window.api.openInEditor(`${repo}/${f.path}`) },
    { label: '打开所在文件夹', icon: 'folder', onClick: () => window.api.openPath(`${repo}/${f.path.split('/').slice(0, -1).join('/')}`) },
    { label: '复制路径', icon: 'copy', onClick: () => navigator.clipboard.writeText(f.path) }
  ])

  // plain render function (not a component) so rows keep identity across renders (double-click works)
  const section = (title: string, files: FileChange[], area: 'staged' | 'unstaged' | 'conflicted', actions?: React.ReactNode) => (
    <div className="file-section" key={area}>
      <div className="file-section-head">
        <span>{title}</span><em>{files.length}</em>
        <div className="flex1" />{actions}
      </div>
      {files.filter(match).map((f) => {
        const code = area === 'staged' ? f.index : area === 'conflicted' ? 'U' : f.untracked ? '?' : f.worktree
        const isSel = sel?.path === f.path && sel.area === area
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
        const base = f.path.slice(f.path.lastIndexOf('/') + 1)
        return (
          <div key={area + f.path} className={`file-row ${isSel ? 'sel' : ''}`} onClick={() => setSel({ path: f.path, area, origPath: f.origPath })}
            onDoubleClick={() => area === 'unstaged' ? run('暂存', () => git.stage(repo, [f.path])) : area === 'staged' ? run('取消暂存', () => git.unstage(repo, [f.path])) : undefined}
            onContextMenu={(e) => fileMenu(e, f, area)} title={f.path}>
            <StatusBadge code={code} />
            <span className="file-name">{base}</span>
            <span className="file-dir">{dir}</span>
            <div className="file-actions">
              {area === 'unstaged' && <>
                <button className="icon-btn sm" title="丢弃" onClick={async (e) => { e.stopPropagation(); if (await dialog({ title: '丢弃改动', message: `确定丢弃 ${f.path} 的改动吗？`, danger: true, okText: '丢弃' })) await run('丢弃', () => git.discard(repo, [f.path])) }}><Icon name="undo" size={13} /></button>
                <button className="icon-btn sm" title="暂存" onClick={(e) => { e.stopPropagation(); void run('暂存', () => git.stage(repo, [f.path])) }}><Icon name="plus" size={13} /></button>
              </>}
              {area === 'staged' && <button className="icon-btn sm" title="取消暂存" onClick={(e) => { e.stopPropagation(); void run('取消暂存', () => git.unstage(repo, [f.path])) }}><Icon name="minus" size={13} /></button>}
              {area === 'conflicted' && <>
                <button className="icon-btn sm" title="在编辑器中打开" data-testid={`conflict-open-${f.path}`} onClick={(e) => { e.stopPropagation(); window.api.openInEditor(`${repo}/${f.path}`) }}><Icon name="code" size={13} /></button>
                <button className="icon-btn sm" title="标记为已解决" data-testid={`conflict-resolve-${f.path}`} onClick={(e) => { e.stopPropagation(); void run('标记解决', () => git.stage(repo, [f.path])) }}><Icon name="check" size={13} /></button>
              </>}
            </div>
          </div>
        )
      })}
    </div>
  )

  const total = status.staged.length + status.unstaged.length + status.conflicted.length
  const badge = total > 0 ? total : 0
  return (
    <div className={`changes-workspace${drawerOpen ? ' drawer-open' : ' drawer-collapsed'}`} data-testid="changes-workspace">
      <div className="changes-canvas pane-right">
        <ConflictWizard
          repo={repo}
          status={status}
          selected={sel?.area === 'conflicted' ? sel.path : null}
          onSelectFile={(path) => {
            const f = status.conflicted.find((x) => x.path === path)
            setSel({ path, area: 'conflicted', origPath: f?.origPath })
            setDrawerOpen(true)
          }}
        />
        {sel?.area === 'conflicted' ? <ConflictPanel repo={repo} file={sel.path} /> : (
          <>
            <div className="diff-toolbar">
              <div className="seg" role="tablist" aria-label="差异视图">
                <button role="tab" aria-selected={tab === 'diff'} className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')} title="对比视图：查看整个文件的改动"><Icon name="diff" size={13} />对比视图</button>
                <button role="tab" aria-selected={tab === 'hunks'} className={tab === 'hunks' ? 'on' : ''} onClick={() => setTab('hunks')} title="分块暂存：按块或按行选择要暂存的改动"><Icon name="inline" size={13} />分块暂存</button>
              </div>
              {sel && <span className="diff-file" title={sel.path}><Icon name="file" size={13} />{sel.path.includes('/') && <span className="dir">{sel.path.slice(0, sel.path.lastIndexOf('/') + 1)}</span>}<b>{sel.path.split('/').pop()}</b>
                <span className={`area-chip ${sel.area}`} title={sel.area === 'staged' ? 'HEAD ↔ 暂存区' : '暂存区 ↔ 工作区'}>{sel.area === 'staged' ? '已暂存' : '未暂存'}</span></span>}
              <div className="flex1" />
              {tab === 'diff' && <DiffModeToggle />}
              {sel && <ExplainButton repo={repo} file={sel.path} staged={sel.area === 'staged'} />}
              {sel && (sel.area === 'staged'
                ? <button className="btn btn-sm" onClick={() => run('取消暂存', () => git.unstage(repo, [sel.path]))} title="把整个文件移出暂存区"><Icon name="minus" size={13} /><span className="lbl">取消暂存文件</span></button>
                : <button className="btn btn-sm" onClick={() => run('暂存', () => git.stage(repo, [sel.path]))} title="暂存整个文件；只想暂存一部分请用「分块暂存」"><Icon name="plus" size={13} /><span className="lbl">暂存文件</span></button>)}
              <button className={`btn btn-sm${drawerOpen ? ' on' : ''}`} data-testid="changes-drawer-toggle" aria-pressed={drawerOpen}
                onClick={() => setDrawerOpen(!drawerOpen)} title={drawerOpen ? '收起变更抽屉' : '展开变更抽屉'}>
                <Icon name="panel" size={13} /><span className="lbl">变更</span>{badge > 0 && <em className="count">{badge}</em>}
              </button>
            </div>
            {tab === 'diff' || !sel
              ? <DiffPane bare repo={repo} file={sel?.path ?? null} origPath={sel?.origPath} source={{ kind: sel?.area === 'staged' ? 'staged' : 'unstaged' }} />
              : <HunkPanel repo={repo} file={sel.path} staged={sel.area === 'staged'} />}
          </>
        )}
      </div>

      {!drawerOpen && (
        <button type="button" className="changes-drawer-handle" data-testid="changes-drawer-handle"
          aria-label="展开变更抽屉" title="展开变更" onClick={() => setDrawerOpen(true)}>
          <Icon name="chevron-left" size={14} /><span>变更</span>{badge > 0 && <em className="count">{badge}</em>}
        </button>
      )}

      <div ref={drawerRef} className={changesDrawerClass(drawerOpen)} data-testid="changes-drawer" aria-hidden={!drawerOpen}
        style={{ width: drawerOpen ? drawerW : 0 }} role="complementary" aria-label="变更与提交">
        {drawerOpen && <Resizer onResize={(d) => setDrawerW((w) => clampDrawerWidth(w - d))} />}
        <div className="changes-drawer-inner pane-left">
          <div className="changes-drawer-head">
            <Icon name="diff" size={15} /><b>变更</b>{badge > 0 && <em className="count">{badge}</em>}
            <div className="flex1" />
            <button type="button" className="icon-btn" data-testid="changes-drawer-collapse" aria-label="收起变更抽屉"
              title="收起" onClick={() => setDrawerOpen(false)}><Icon name="chevron" size={15} /></button>
          </div>
          <div className="pane-toolbar files-toolbar">
            <div className="search flex1"><Icon name="search" size={13} /><input placeholder="筛选文件…" aria-label="筛选文件" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
            <button className="btn btn-sm btn-primary" disabled={!status.unstaged.length} onClick={() => run('暂存全部', () => git.stageAll(repo))} title="暂存全部未暂存的改动（git add -A）"><Icon name="plus" size={13} />全部暂存</button>
            <button className="btn btn-sm" disabled={!status.staged.length} onClick={() => run('取消暂存', () => git.unstageAll(repo))} title="取消暂存全部文件（git reset）"><Icon name="minus" size={13} />全部取消</button>
            <button className="icon-btn danger-hover" disabled={!status.unstaged.length} aria-label="全部丢弃" title="丢弃全部未暂存的改动（无法撤销）"
              onClick={async () => { if (await dialog({ title: '丢弃全部改动', message: '将丢弃所有未暂存的改动并删除未跟踪文件，无法撤销。', danger: true, okText: '全部丢弃' })) await run('丢弃', () => git.discard(repo, status.unstaged.map((f) => f.path))) }}><Icon name="undo" size={15} /></button>
          </div>
          <div className="file-lists">
            {total === 0 && <Empty icon="check" title="工作区很干净" actions={<button className="btn btn-sm" onClick={() => setView('graph')}><Icon name="graph" size={14} />查看提交图</button>}>没有未提交的变更，修改的文件会自动出现在这里。<br /><span className="story">“改了几个文件，想先看看到底动了哪些行，挑出要提交的部分，写一句说明后提交”——就在这里完成。</span></Empty>}
            {status.conflicted.length > 0 && section('冲突', status.conflicted, 'conflicted')}
            {status.unstaged.length > 0 && section('未暂存的变更', status.unstaged, 'unstaged')}
            {status.staged.length > 0 && section('已暂存的变更', status.staged, 'staged')}
            {total > 0 && <div className="kbd-hint" data-testid="changes-keys" title="焦点不在输入框时可用"><kbd>J</kbd>/<kbd>K</kbd> 上下选文件 · <kbd>S</kbd> 暂存 · <kbd>U</kbd> 取消暂存 · <kbd>{MOD}</kbd>+<kbd>Enter</kbd> 提交</div>}
          </div>
          <CommitBox />
        </div>
      </div>
    </div>
  )
}

function ExplainButton({ repo, file, staged }: { repo: string; file: string; staged: boolean }) {
  // single-flight + cancellable: repeated clicks join the running request; closing the drawer, switching file or
  // leaving the view aborts it. Not cached — the working tree keeps changing.
  const runner = useAIRunner()
  const status = useRunState(runner, (x) => x.status)
  const [open, setOpen] = useState(false)
  const key = `${repo}|${file}|${staged}`
  const start = (force = false): void => { runner.start(key, (signal, onDelta) => app.aiStream('explainDiff', repo, { file, staged: String(staged) }, onDelta, signal), { force }) }
  useEffect(() => { runner.reset(); setOpen(false) }, [runner, key])
  const close = useCallback(() => { runner.stop(); setOpen(false) }, [runner])
  const running = status === 'running'
  return (
    <>
      <button className="btn btn-sm btn-ai" data-testid="chg-ai-explain" aria-busy={running} onClick={() => { setOpen(true); start() }}
        title={running ? '正在生成，重复点击不会再发请求' : 'AI 解释：用中文概括这个文件的改动'}>{running ? <Spinner /> : <Icon name="ai" size={13} />}<span className="lbl">{running ? '生成中…' : 'AI 解释'}</span></button>
      {open && <AIDrawer runner={runner} title={<>AI 解释：{file}</>} onClose={close} onRegenerate={() => start(true)} />}
    </>
  )
}

function CommitBox() {
  const { active, status, run, settings } = useApp()
  const repo = active!
  const toast = useToast()
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const [amend, setAmend] = useState(false)
  const [signoff, setSignoff] = useState(false)
  const [noVerify, setNoVerify] = useState(false)
  // AI 生成 / AI 审查: single-flight runners, aborted on repo switch and unmount (a late answer never lands in
  // another repo's commit box); review streams into a drawer at most once per frame.
  const genRun = useAIRunner()
  const genStatus = useRunState(genRun, (x) => x.status)
  const aiLoading = genStatus === 'running'
  const reviewRun = useAIRunner()
  const reviewStatus = useRunState(reviewRun, (x) => x.status)
  const reviewLoading = reviewStatus === 'running'
  const [reviewOpen, setReviewOpen] = useState(false)
  const committing = React.useRef(false)
  useEffect(() => { genRun.reset(); reviewRun.reset(); setReviewOpen(false) }, [genRun, reviewRun, repo])
  const staged = status?.staged.length ?? 0

  // unsent drafts survive switching repos / restarting (per repo)
  const draftRepo = React.useRef<string | null>(null)
  useEffect(() => {
    const d = loadDraft(repo); draftRepo.current = repo
    setSummary(d.summary); setBody(d.body); setAmend(false)
  }, [repo])
  useEffect(() => { if (draftRepo.current === repo && !amend) saveDraft(repo, { summary, body }) }, [repo, summary, body, amend])
  useEffect(() => {
    if (amend && !summary) git.lastCommitMessage(repo).then((m) => { const [s, ...b] = m.split('\n'); setSummary(s); setBody(b.join('\n').trim()) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amend])

  const aiGen = (): void => {
    const ctx = summary && !summary.startsWith('feat') ? summary : undefined
    genRun.start(`gen|${repo}`, async (signal) => {
      try {
        const msg = await app.aiStream('commitMessage', repo, { context: ctx }, undefined, signal)
        const [s, ...b] = msg.split('\n')
        setSummary(s.trim()); setBody(b.join('\n').trim())
        return msg
      } catch (e) {
        if (!signal.aborted) toast('err', `AI 生成失败：${errMsg(e)}`, { label: '重试', icon: 'refresh', onClick: () => aiGen() })
        throw e
      }
    }, { force: true })
  }
  const aiReview = (force = false): void => {
    setReviewOpen(true)
    reviewRun.start(`review|${repo}`, (signal, onDelta) => app.aiStream('reviewStaged', repo, {}, onDelta, signal), { force })
  }
  const closeReview = useCallback(() => { reviewRun.stop(); setReviewOpen(false) }, [reviewRun])
  const commit = async (andPush = false) => {
    if (committing.current) return            // Ctrl+Enter / double-click while a commit is running: ignore
    committing.current = true
    try { await doCommit(andPush) } finally { committing.current = false }
  }
  const doCommit = async (andPush: boolean) => {
    const msg = summary.trim() + (body.trim() ? `\n\n${body.trim()}` : '')
    const r = await run('提交', () => git.commit(repo, msg, { amend, signoff, noVerify }), amend ? '已修改上一次提交' : '提交成功')
    if (r !== undefined) {
      rememberMessage(msg); saveDraft(repo, { summary: '', body: '' })
      setSummary(''); setBody(''); setAmend(false)
      if (andPush) await run('推送', () => git.push(repo, status?.upstream ? {} : { setUpstream: true }), '推送完成')
    }
  }
  const canCommit = !!summary.trim() && (staged > 0 || amend) && !(status?.conflicted.length)
  const len = summary.length
  return (
    <div className="commit-box">
      <div className="commit-head">
        <span>提交信息</span>
        <div className="flex1" />
        <MessageHistory onPick={(m) => { const x = splitMessage(m); setSummary(x.summary); setBody(x.body) }} />
        {aiLoading
          ? <><button className="btn btn-xs btn-ghost" data-testid="cb-ai-gen-stop" onClick={() => genRun.stop()} title="停止生成">停止</button><button className="btn btn-xs btn-ai on ai-fixed" aria-busy data-testid="cb-ai-gen" title="正在生成提交信息，重复点击不会再发请求"><Spinner />生成中…</button></>
          : <button className="btn btn-xs btn-ai ai-fixed" data-testid="cb-ai-gen" onClick={aiGen} disabled={staged === 0} title="AI 生成：根据暂存区差异写提交信息"><Icon name="ai" size={12} />AI 生成</button>}
        <button className="btn btn-xs btn-ai ai-fixed" aria-busy={reviewLoading} onClick={() => aiReview()} disabled={staged === 0 && !reviewLoading} title={reviewLoading ? '正在审查，重复点击不会再发请求' : 'AI 审查：检查暂存区改动中的问题'}>{reviewLoading ? <Spinner /> : <Icon name="ai" size={12} />}{reviewLoading ? '审查中…' : 'AI 审查'}</button>
      </div>
      <div className="commit-input-wrap">
        <input className="commit-summary" placeholder={`提交摘要${settings?.ai.commitStyle === 'conventional' ? '（如 feat: 新增…）' : ''}`} value={summary} onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit) void commit() }} />
        <span className={`len ${len > 72 ? 'over' : ''}`}>{len}</span>
      </div>
      <textarea className="commit-body" placeholder="详细描述（可选）" rows={3} value={body} onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit) void commit() }} />
      <div className="commit-actions">
        <CommitOptions opts={[
          { label: '修改上次提交', hint: 'git commit --amend', on: amend, set: setAmend },
          { label: 'Sign-off', hint: '添加 Signed-off-by 署名行', on: signoff, set: setSignoff },
          { label: '跳过钩子', hint: '不运行 pre-commit / commit-msg 钩子（--no-verify）', on: noVerify, set: setNoVerify }
        ]} />
        <button className="btn btn-primary" disabled={!canCommit} onClick={() => commit()} title={`提交（${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter）`}>
          <Icon name="check" size={14} />{amend ? '修改提交' : `提交 ${staged ? `(${staged})` : ''}`}
        </button>
        <button className="btn icon-only" disabled={!canCommit} onClick={() => commit(true)} title="提交并推送" aria-label="提交并推送"><Icon name="push" size={14} /></button>
      </div>
      {reviewOpen && <AIDrawer runner={reviewRun} title="AI 代码审查（暂存区）" onClose={closeReview} onRegenerate={() => aiReview(true)} />}
    </div>
  )
}

/** 「历史」 popover: reuse one of the last 20 commit messages. */
function MessageHistory({ onPick }: { onPick: (msg: string) => void }) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<string[]>([])
  const [q, setQ] = useState('')
  const ref = React.useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    setList(loadHistory()); setQ('')
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  const shown = filterHistory(list, q)
  return (
    <div className="msg-hist-wrap" ref={ref}>
      <button className="btn btn-xs btn-ghost" data-testid="msg-history" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="最近用过的提交信息（最多 20 条），点选即可复用"><Icon name="clock" size={12} />历史</button>
      {open && (
        <div className="msg-hist-pop" role="listbox" aria-label="最近的提交信息">
          {list.length > 4 && <input className="msg-hist-q" autoFocus placeholder="搜索历史…" value={q} onChange={(e) => setQ(e.target.value)} />}
          {!shown.length && <div className="msg-hist-empty">{list.length ? '没有匹配的提交信息' : '还没有提交记录。提交过的信息会出现在这里，方便下次复用。'}</div>}
          {shown.map((m) => (
            <button key={m} role="option" className="msg-hist-item" title={m} onClick={() => { onPick(m); setOpen(false) }}>
              <b>{m.split('\n')[0]}</b>{m.includes('\n') && <small>{m.split('\n').slice(1).join(' ').trim()}</small>}
            </button>
          ))}
          {list.length > 0 && <button className="msg-hist-clear" onClick={() => { clearHistory(); setList([]) }}>清空历史</button>}
        </div>
      )}
    </div>
  )
}

type Opt = { label: string; hint: string; on: boolean; set: (v: boolean) => void }
/** 「选项」 popover for rarely-changed commit flags; active flags show as a count on the button. */
function CommitOptions({ opts }: { opts: Opt[] }) {
  const [open, setOpen] = useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  const n = opts.filter((o) => o.on).length
  return (
    <div className="commit-opts-wrap" ref={ref}>
      <button className={`btn ${n ? 'opts-on' : ''}`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        title={n ? `已启用：${opts.filter((o) => o.on).map((o) => o.label).join('、')}` : '提交选项：修改上次提交、Sign-off、跳过钩子'}>
        <Icon name="settings" size={13} />选项{n > 0 && <em className="count">{n}</em>}
      </button>
      {open && (
        <div className="commit-opts-pop" role="group" aria-label="提交选项">
          {opts.map((o) => (
            <label key={o.label} title={o.hint}><input type="checkbox" checked={o.on} onChange={(e) => o.set(e.target.checked)} /><span><b>{o.label}</b><small>{o.hint}</small></span></label>
          ))}
        </div>
      )}
    </div>
  )
}


/** Strong entry + file checklist when merge/rebase/cherry-pick has conflicts. */
function ConflictWizard({ repo, status, selected, onSelectFile }: {
  repo: string
  status: NonNullable<ReturnType<typeof useApp>['status']>
  selected: string | null
  onSelectFile: (path: string) => void
}) {
  const { run } = useApp()
  const dialog = useDialog()
  if (!shouldShowConflictWizard(status)) return null
  const n = status.conflicted.length
  const rows = conflictFileRows(status.conflicted)
  const cont = canContinueOp(status)
  const abortable = canAbortOp(status)
  const onAbort = async () => {
    const c = abortConfirmMessage(status.operation)
    if (!(await dialog({ title: c.title, message: c.message, danger: true, okText: c.okText }))) return
    await run('中止', () => git.abortOp(repo), '已中止')
  }
  const onContinue = () => run('继续', () => git.continueOp(repo), '操作已完成')
  return (
    <div className="conflict-wizard" data-testid="conflict-wizard">
      <div className="cw-banner" data-testid="conflict-wizard-banner" role="status">
        <Icon name="warn" size={18} />
        <div className="cw-copy">
          <div className="cw-title"><b>{wizardHeadline(status)}</b><span className="muted">{wizardSubline(status)}</span></div>
          <p className="cw-hint">{WIZARD_HINT}</p>
        </div>
        <div className="cw-actions">
          {abortable && status.operation !== 'BISECTING' && (
            <button type="button" className="btn btn-sm btn-primary" data-testid="conflict-wizard-continue"
              disabled={!cont} title={cont ? continueLabel(status.operation) : '请先解决全部冲突文件'}
              onClick={onContinue}><Icon name="play" size={13} />{continueLabel(status.operation)}</button>
          )}
          {abortable && (
            <button type="button" className="btn btn-sm btn-ghost-danger" data-testid="conflict-wizard-abort"
              onClick={() => void onAbort()}><Icon name="x" size={13} />{abortLabel(status.operation)}</button>
          )}
        </div>
      </div>
      {n > 0 && (
        <div className="cw-files" data-testid="conflict-wizard-files" role="list" aria-label="冲突文件列表">
          {rows.map((row) => (
            <div key={row.path} className={`cw-file ${selected === row.path ? 'sel' : ''}`} role="listitem"
              data-testid={`conflict-wizard-file-${row.path}`}
              onClick={() => onSelectFile(row.path)}>
              <StatusBadge code={row.code} />
              <span className="cw-path" title={row.path}>{row.path}</span>
              <span className="cw-st">{row.statusLabel}</span>
              <div className="cw-file-acts" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="btn btn-xs" data-testid={`cw-open-${row.path}`}
                  title="在编辑器中打开" onClick={() => window.api.openInEditor(`${repo}/${row.path}`)}>
                  <Icon name="code" size={12} />打开</button>
                <button type="button" className="btn btn-xs" data-testid={`cw-ours-${row.path}`}
                  title="整文件采用当前分支（ours）" onClick={() => run('采用我方', () => git.resolveWith(repo, row.path, 'ours'), '已采用我方版本')}>
                  我方</button>
                <button type="button" className="btn btn-xs" data-testid={`cw-theirs-${row.path}`}
                  title="整文件采用合入方（theirs）" onClick={() => run('采用对方', () => git.resolveWith(repo, row.path, 'theirs'), '已采用对方版本')}>
                  对方</button>
                <button type="button" className="btn btn-xs btn-primary" data-testid={`cw-mark-${row.path}`}
                  title="标记为已解决（git add）" onClick={() => run('标记解决', () => git.stage(repo, [row.path]), '已标记为解决')}>
                  <Icon name="check" size={12} />已解决</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ConflictPanel({ repo, file }: { repo: string; file: string }) {
  const { run, tick } = useApp()
  const toast = useToast()
  const [v, setV] = useState<{ base: string; ours: string; theirs: string; merged: string } | null>(null)
  const [ai, setAi] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => { git.conflictVersions(repo, file).then(setV).catch(() => setV(null)) }, [repo, file, tick])
  const suggestion = useMemo(() => { const m = ai ? /```[a-zA-Z]*\n([\s\S]*?)\n```/.exec(ai) : null; return m ? m[1] + '\n' : null }, [ai])
  const markers = v ? (v.merged.match(/^<<<<<<< /gm) ?? []).length : 0
  return (
    <div className="conflict" data-testid="conflict-panel">
      <div className="conflict-head">
        <Icon name="warn" /><b className="mono" style={{ fontSize: 12.5 }}>{file}</b>{markers > 0 ? <span className="tag tag-err">{markers} 处冲突</span> : <span className="tag tag-ok">无冲突标记</span>}
        <div className="flex1" />
        <button className="btn btn-sm" data-testid="conflict-panel-ours" onClick={() => run('采用我方', () => git.resolveWith(repo, file, 'ours'), '已采用当前分支（ours）版本')}>采用我方（ours）</button>
        <button className="btn btn-sm" data-testid="conflict-panel-theirs" onClick={() => run('采用对方', () => git.resolveWith(repo, file, 'theirs'), '已采用合入方（theirs）版本')}>采用对方（theirs）</button>
        <button className="btn btn-sm" data-testid="conflict-panel-open" onClick={() => window.api.openInEditor(`${repo}/${file}`)}><Icon name="code" size={13} />在编辑器中解决</button>
        <button className="btn btn-sm btn-primary" data-testid="conflict-panel-mark" disabled={markers > 0} title={markers ? '文件中仍有冲突标记' : ''} onClick={() => run('标记已解决', () => git.stage(repo, [file]), '已标记为解决')}>标记已解决</button>
        <button className="btn btn-sm btn-ai" disabled={loading} onClick={async () => { setLoading(true); try { setAi(await app.ai('conflictHelp', repo, { file })) } catch (e) { toast('err', errMsg(e)) } finally { setLoading(false) } }}>{loading ? <Spinner /> : <Icon name="ai" size={13} />}AI 建议</button>
      </div>
      {v && (
        <div className="conflict-cols">
          <div><div className="col-title ours">我方（当前分支 · ours）</div><pre>{v.ours}</pre></div>
          <div><div className="col-title merged">当前文件（含冲突标记）</div><pre className="merged">{renderMerged(v.merged)}</pre></div>
          <div><div className="col-title theirs">对方（合入方 · theirs）</div><pre>{v.theirs}</pre></div>
        </div>
      )}
      {ai && (
        <div className="ai-card">
          <div className="ai-card-head"><Icon name="ai" />AI 冲突解决建议<div className="flex1" />
            {suggestion && <button className="btn btn-sm btn-primary" onClick={() => run('应用 AI 建议', () => window.api.writeFile(repo, file, suggestion), '已写入建议结果，请检查后标记已解决')}>应用建议到文件</button>}
            <button className="icon-btn" title="关闭" aria-label="关闭" onClick={() => setAi(null)}><Icon name="x" /></button></div>
          <Markdown text={ai} />
        </div>
      )}
    </div>
  )
}

/** Color the conflict regions: ours (accent) · marker lines · theirs (teal). */
function renderMerged(text: string): React.ReactNode {
  let mode: 'none' | 'ours' | 'theirs' = 'none'
  return text.split('\n').map((line, i) => {
    if (line.startsWith('<<<<<<<')) { mode = 'ours'; return <span key={i} className="cm-marker">{line}</span> }
    if (line.startsWith('=======') && mode !== 'none') { mode = 'theirs'; return <span key={i} className="cm-marker">{line}</span> }
    if (line.startsWith('>>>>>>>') && mode !== 'none') { mode = 'none'; return <span key={i} className="cm-marker">{line}</span> }
    if (mode === 'ours') return <span key={i} className="cm-ours">{line || ' '}</span>
    if (mode === 'theirs') return <span key={i} className="cm-theirs">{line || ' '}</span>
    return <React.Fragment key={i}>{line}{'\n'}</React.Fragment>
  })
}
