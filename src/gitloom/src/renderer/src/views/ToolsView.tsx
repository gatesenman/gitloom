import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { BlameLine, CleanEntry, ConfigEntry, FileHistoryEntry, LfsStatus, PickaxeHit, SigningStatus } from '@shared/types'
import { useApp } from '../state'
import { git, errMsg } from '../api'
import { Icon } from '../components/Icon'
import { Empty, Spinner, useDialog, useToast, usePersistentState } from '../components/ui'

type Tab = 'blame' | 'ignore' | 'pickaxe' | 'compare' | 'clean' | 'config' | 'signing' | 'lfs'

const TABS: { id: Tab; label: string; icon: string; tip: string }[] = [
  { id: 'blame', label: '逐行追溯 / 文件历史', icon: 'blame', tip: '每一行最后由谁、在哪次提交修改（git blame），以及文件的修改历史' },
  { id: 'ignore', label: '忽略规则', icon: 'file', tip: '查看 / 编辑 .gitignore，预览某路径为何被忽略' },
  { id: 'pickaxe', label: '代码搜索', icon: 'search', tip: '找出添加或删除了某段文字的提交（git log -S / -G）' },
  { id: 'compare', label: '比较分支', icon: 'compare', tip: '比较两个分支/标签/提交之间的提交与文件差异' },
  { id: 'clean', label: '清理未跟踪文件', icon: 'trash', tip: '预览并删除未被 Git 跟踪的文件（git clean）' },
  { id: 'config', label: '仓库配置', icon: 'settings', tip: '查看和编辑 git config（本仓库 / 全局）' },
  { id: 'signing', label: '提交签名', icon: 'lock', tip: '检查 GPG / SSH 提交签名设置' },
  { id: 'lfs', label: 'Git LFS', icon: 'lfs', tip: '大文件存储：跟踪规则与 LFS 文件列表' }
]

/** 文件追溯: blame + file history first, plus the occasional repo tools (search / compare / clean / config / signing / LFS). */
export default function ToolsView() {
  const { active, run, setView } = useApp()
  const [tab, setTab] = usePersistentState<Tab>('gitloom.tools.tab', 'blame')
  if (!active) return <Empty icon="settings" title="未选择仓库" />
  return (
    <div className="tools-view">
      <div className="tools-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} title={t.tip} data-testid={`tools-tab-${t.id}`}>
            <Icon name={t.icon} size={14} />{t.label}
          </button>
        ))}
      </div>
      <div className="tools-body">
        {tab === 'blame' && <BlamePanel repo={active} onOpenCommit={() => setView('history')} />}
        {tab === 'ignore' && <IgnorePanel repo={active} />}
        {tab === 'pickaxe' && <PickaxePanel repo={active} />}
        {tab === 'compare' && <ComparePanel repo={active} />}
        {tab === 'clean' && <CleanPanel repo={active} run={run} />}
        {tab === 'config' && <ConfigPanel repo={active} run={run} />}
        {tab === 'signing' && <SigningPanel repo={active} run={run} />}
        {tab === 'lfs' && <LfsPanel repo={active} run={run} />}
      </div>
    </div>
  )
}

function BlamePanel({ repo, onOpenCommit }: { repo: string; onOpenCommit: (sha: string) => void }) {
  const toast = useToast()
  const [file, setFile] = useState('')
  const [hist, setHist] = useState<FileHistoryEntry[]>([])
  const [blame, setBlame] = useState<BlameLine[]>([])
  const [rev, setRev] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const load = async (f = file, r?: string) => {
    if (!f.trim()) return
    setBusy(true)
    try {
      const [h, b] = await Promise.all([git.fileHistory(repo, f.trim()), git.blame(repo, f.trim(), r)])
      setHist(h); setBlame(b); setRev(r)
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }

  const groups = useMemo(() => {
    const out: { sha: string; author: string; date: number; start: number; lines: BlameLine[] }[] = []
    for (const l of blame) {
      const last = out[out.length - 1]
      if (last && last.sha === l.sha) last.lines.push(l)
      else out.push({ sha: l.sha, author: l.author, date: l.date, start: out.length ? out[out.length - 1].start + out[out.length - 1].lines.length : 1, lines: [l] })
    }
    return out
  }, [blame])

  return (
    <div className="blame-panel">
      <div className="row gap">
        <input className="flex1" value={file} onChange={(e) => setFile(e.target.value)} placeholder="文件路径，如 src/main.ts" onKeyDown={(e) => e.key === 'Enter' && void load()} />
        <button className="btn btn-primary" onClick={() => void load()} disabled={busy}>{busy ? <Spinner size={12} /> : <Icon name="search" size={14} />}查看</button>
      </div>
      {!!hist.length && (
        <div className="file-hist">
          <h3>文件历史 ({hist.length})</h3>
          <div className="file-hist-list">
            {hist.map((h) => (
              <button key={h.hash} className={`file-hist-row ${rev === h.hash ? 'on' : ''}`} onClick={() => void load(file, h.hash)} title="在此提交查看 blame">
                <span className="mono">{h.short}</span>
                <span className="flex1">{h.subject}</span>
                <span className="muted">{h.author}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!!blame.length && (
        <div className="blame-view" role="table" aria-label="Blame">
          {groups.map((g) => (
            <div key={g.sha + g.start} className="blame-group">
              <button className="blame-meta" onClick={() => onOpenCommit(g.sha)} title="跳转到提交">
                <span className="mono">{g.sha.slice(0, 8)}</span>
                <span>{g.author}</span>
                <span className="muted">{new Date(g.date * 1000).toLocaleDateString()}</span>
              </button>
              <pre className="blame-code">{g.lines.map((l, i) => `${String(g.start + i).padStart(4)} ${l.line}`).join('\n')}</pre>
            </div>
          ))}
        </div>
      )}
      {!blame.length && !busy && <Empty icon="blame" title="查看文件 Blame">输入路径后可查看每行最后修改的提交，并浏览该文件的完整历史。</Empty>}
    </div>
  )
}

function PickaxePanel({ repo }: { repo: string }) {
  const toast = useToast()
  const [q, setQ] = useState('')
  const [regex, setRegex] = useState(false)
  const [hits, setHits] = useState<PickaxeHit[]>([])
  const [busy, setBusy] = useState(false)
  const search = async () => {
    if (!q.trim()) return
    setBusy(true)
    try { setHits(await git.pickaxe(repo, q.trim(), { regex, max: 80 })) }
    catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }
  return (
    <div>
      <div className="row gap">
        <input className="flex1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索曾添加或删除的字符串 / 正则" onKeyDown={(e) => e.key === 'Enter' && void search()} />
        <label className="field-check"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> 正则 (-G)</label>
        <button className="btn btn-primary" onClick={() => void search()} disabled={busy}>{busy ? <Spinner size={12} /> : <Icon name="search" size={14} />}搜索</button>
      </div>
      <p className="muted" style={{ marginTop: 8 }}>基于 git log -S / -G（pickaxe），找出历史中引入或移除该字符串的提交。</p>
      {!hits.length && !busy && <Empty icon="search" title="没有结果" />}
      <div className="pickaxe-list">
        {hits.map((h) => (
          <div key={h.hash} className="pickaxe-row">
            <span className="mono">{h.short}</span>
            <span className="flex1">{h.subject}</span>
            <span className="muted">{h.author}</span>
            <span className="muted">{h.files.slice(0, 3).join(', ')}{h.files.length > 3 ? ` +${h.files.length - 3}` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ComparePanel({ repo }: { repo: string }) {
  const toast = useToast()
  const { setView } = useApp()
  const [a, setA] = useState('main')
  const [b, setB] = useState('HEAD')
  const [res, setRes] = useState<Awaited<ReturnType<typeof git.compareRefs>> | null>(null)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try { setRes(await git.compareRefs(repo, a.trim(), b.trim())) }
    catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }
  return (
    <div>
      <div className="row gap">
        <input value={a} onChange={(e) => setA(e.target.value)} placeholder="基准 ref" />
        <Icon name="compare" size={16} />
        <input value={b} onChange={(e) => setB(e.target.value)} placeholder="对比 ref" />
        <button className="btn btn-primary" onClick={() => void go()} disabled={busy}>{busy ? <Spinner size={12} /> : '比较'}</button>
      </div>
      {res && (
        <>
          <div className="stat-chips" style={{ marginTop: 12 }}>
            <span className="stat-chip">{b} 领先 <b>{res.ahead}</b></span>
            <span className="stat-chip">{b} 落后 <b>{res.behind}</b></span>
            <span className="stat-chip">提交 <b>{res.commits.length}</b></span>
            <span className="stat-chip">文件 <b>{res.files.length}</b></span>
          </div>
          <div className="compare-cols">
            <div>
              <h3>提交 ({a}..{b})</h3>
              {res.commits.map((c) => <div key={c.hash} className="pickaxe-row"><span className="mono">{c.short}</span><span className="flex1">{c.subject}</span></div>)}
            </div>
            <div>
              <h3>文件</h3>
              {res.files.map((f) => <div key={f.path} className="pickaxe-row"><span className="flex1">{f.path}</span><span className="add">+{f.additions}</span><span className="del">−{f.deletions}</span></div>)}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function CleanPanel({ repo, run }: { repo: string; run: ReturnType<typeof useApp>['run'] }) {
  const toast = useToast()
  const dialog = useDialog()
  const [ignored, setIgnored] = useState(false)
  const [entries, setEntries] = useState<CleanEntry[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const preview = async () => {
    setBusy(true)
    try {
      const list = await git.cleanPreview(repo, { ignored })
      setEntries(list)
      setSel(new Set(list.filter((e) => !e.nestedRepo).map((e) => e.path)))
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }
  useEffect(() => { void preview() }, [repo, ignored])
  const apply = async () => {
    const paths = [...sel]
    if (!paths.length) return
    if (!(await dialog({ title: '确认清理', message: `将永久删除 ${paths.length} 个未跟踪路径，无法撤销。嵌套仓库已被自动排除。`, danger: true, okText: '清理' }))) return
    await run('git clean', async () => { await git.cleanApply(repo, paths, { ignored }); await preview() }, `已清理 ${paths.length} 项`)
  }
  return (
    <div>
      <div className="row gap">
        <label className="field-check"><input type="checkbox" checked={ignored} onChange={(e) => setIgnored(e.target.checked)} /> 包含被忽略的文件 (-x)</label>
        <button className="btn" onClick={() => void preview()} disabled={busy}>{busy ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}预览</button>
        <button className="btn btn-danger" onClick={apply} disabled={!sel.size}><Icon name="trash" size={14} />清理选中 ({sel.size})</button>
      </div>
      {!entries.length && <Empty icon="check" title="工作区很干净">没有可清理的未跟踪文件。</Empty>}
      <div className="clean-list">
        {entries.map((e) => (
          <label key={e.path} className={`clean-row ${e.nestedRepo ? 'nested' : ''}`}>
            <input type="checkbox" disabled={!!e.nestedRepo} checked={sel.has(e.path)} onChange={(ev) => setSel((s) => { const n = new Set(s); if (ev.target.checked) n.add(e.path); else n.delete(e.path); return n })} />
            <Icon name={e.isDir ? 'folder' : 'file'} size={14} />
            <span className="flex1 mono">{e.path}{e.isDir ? '/' : ''}</span>
            {e.nestedRepo && <span className="kind-tag">嵌套仓库（已保护）</span>}
          </label>
        ))}
      </div>
    </div>
  )
}

function ConfigPanel({ repo, run }: { repo: string; run: ReturnType<typeof useApp>['run'] }) {
  const toast = useToast()
  const dialog = useDialog()
  const [scope, setScope] = useState<'local' | 'global' | 'system' | 'all'>('local')
  const [entries, setEntries] = useState<ConfigEntry[]>([])
  const [q, setQ] = useState('')
  const load = useCallback(async () => {
    try { setEntries(await git.listConfig(repo, scope === 'all' ? undefined : scope)) }
    catch (e) { toast('err', errMsg(e)) }
  }, [repo, scope, toast])
  useEffect(() => { void load() }, [load])
  const shown = entries.filter((e) => !q || e.key.includes(q) || e.value.includes(q))
  const edit = async (e?: ConfigEntry) => {
    const r = await dialog({
      title: e ? `编辑 ${e.key}` : '新增配置',
      fields: [
        { name: 'key', label: '键', value: e?.key ?? '', placeholder: 'user.name' },
        { name: 'value', label: '值', value: e?.value ?? '' },
        { name: 'global', label: '写入全局 (--global)', type: 'checkbox', value: e?.scope === 'global' }
      ]
    })
    if (!r?.key) return
    await run('设置配置', async () => { await git.setConfig(repo, String(r.key), String(r.value), !!r.global); await load() }, '已保存')
  }
  return (
    <div>
      <div className="row gap">
        <div className="seg seg-sm">{(['local', 'global', 'system', 'all'] as const).map((s) => <button key={s} className={scope === s ? 'on' : ''} onClick={() => setScope(s)}>{s}</button>)}</div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选…" />
        <button className="btn" onClick={() => void edit()}><Icon name="plus" size={14} />新增</button>
        <button className="btn" onClick={() => void load()}><Icon name="refresh" size={14} /></button>
      </div>
      <div className="config-list">
        {shown.map((e, i) => (
          <div key={`${e.scope}:${e.key}:${i}`} className="config-row">
            <span className="kind-tag">{e.scope}</span>
            <span className="mono">{e.key}</span>
            <span className="flex1 muted">{e.value}</span>
            {e.scope !== 'system' && <>
              <button className="icon-btn xs" title="编辑" aria-label="编辑" onClick={() => void edit(e)}><Icon name="settings" size={13} /></button>
              <button className="icon-btn xs" title="删除" aria-label="删除" onClick={async () => { if (await dialog({ title: '删除配置', message: `删除 ${e.key}？`, danger: true, okText: '删除' })) await run('删除配置', async () => { await git.unsetConfig(repo, e.key, e.scope === 'global'); await load() }) }}><Icon name="trash" size={13} /></button>
            </>}
          </div>
        ))}
      </div>
    </div>
  )
}

function SigningPanel({ repo, run }: { repo: string; run: ReturnType<typeof useApp>['run'] }) {
  const toast = useToast()
  const dialog = useDialog()
  const [st, setSt] = useState<SigningStatus | null>(null)
  const load = useCallback(async () => { try { setSt(await git.signingStatus(repo)) } catch (e) { toast('err', errMsg(e)) } }, [repo, toast])
  useEffect(() => { void load() }, [load])
  if (!st) return <Spinner />
  return (
    <div className="signing-panel">
      <div className="stat-chips">
        <span className="stat-chip">签名 {st.gpgSign ? '已开启' : '关闭'}</span>
        <span className="stat-chip">格式 <b>{st.format}</b></span>
        <span className="stat-chip">密钥 <b className="mono">{st.signingKey || '—'}</b></span>
        <span className="stat-chip">GPG {st.gpgAvailable ? '可用' : '未安装'}</span>
        <span className="stat-chip">SSH {st.sshAvailable ? '可用' : '未安装'}</span>
      </div>
      {st.hint && <p className="hint-banner"><Icon name="info" size={14} />{st.hint}</p>}
      <div className="row gap" style={{ marginTop: 12 }}>
        <button className="btn" onClick={async () => {
          const r = await dialog({ title: '配置签名', fields: [
            { name: 'format', label: '格式', type: 'select', value: st.format === 'ssh' ? 'ssh' : 'openpgp', options: [{ value: 'openpgp', label: 'GPG (openpgp)' }, { value: 'ssh', label: 'SSH' }] },
            { name: 'key', label: 'signingkey', value: st.signingKey, placeholder: 'GPG key id 或 SSH 公钥路径' },
            { name: 'enable', label: '启用 commit.gpgsign', type: 'checkbox', value: true }
          ] })
          if (!r) return
          await run('配置签名', async () => {
            await git.setConfig(repo, 'gpg.format', String(r.format))
            if (r.key) await git.setConfig(repo, 'user.signingkey', String(r.key))
            await git.setConfig(repo, 'commit.gpgsign', r.enable ? 'true' : 'false')
            await load()
          }, '签名设置已保存')
        }}><Icon name="lock" size={14} />配置签名</button>
        <button className="btn" onClick={async () => {
          await run('关闭签名', async () => { await git.setConfig(repo, 'commit.gpgsign', 'false'); await load() }, '已关闭自动签名')
        }}>关闭自动签名</button>
      </div>
      <p className="muted" style={{ marginTop: 16 }}>提示：SSH 签名需 Git ≥ 2.34，并把公钥添加到 GitHub/GitLab 的 Signing keys。单次提交可在变更页勾选「签名」。</p>
    </div>
  )
}

function LfsPanel({ repo, run }: { repo: string; run: ReturnType<typeof useApp>['run'] }) {
  const toast = useToast()
  const dialog = useDialog()
  const [st, setSt] = useState<LfsStatus | null>(null)
  const load = useCallback(async () => { try { setSt(await git.lfsStatus(repo)) } catch (e) { toast('err', errMsg(e)) } }, [repo, toast])
  useEffect(() => { void load() }, [load])
  if (!st) return <Spinner />
  return (
    <div>
      <div className="stat-chips">
        <span className="stat-chip">git-lfs {st.installed ? st.version ?? '已安装' : '未安装'}</span>
        <span className="stat-chip">仓库 {st.used ? '使用 LFS' : '未使用'}</span>
        <span className="stat-chip">跟踪模式 <b>{st.trackedPatterns.length}</b></span>
        <span className="stat-chip">文件 <b>{st.files.length}</b></span>
      </div>
      {!st.installed && <p className="hint-banner"><Icon name="warn" size={14} />未检测到 git-lfs。请先安装：https://git-lfs.com</p>}
      <div className="row gap" style={{ marginTop: 12 }}>
        <button className="btn" disabled={!st.installed} onClick={() => void run('LFS pull', () => git.lfsPull(repo), 'LFS 文件已拉取')}><Icon name="download" size={14} />Pull LFS</button>
        <button className="btn" disabled={!st.installed} onClick={() => void run('LFS push', () => git.lfsPush(repo), 'LFS 已推送')}><Icon name="push" size={14} />Push LFS</button>
        <button className="btn" disabled={!st.installed} onClick={async () => {
          const r = await dialog({ title: '跟踪大文件', fields: [{ name: 'pattern', label: '模式', placeholder: '*.psd / *.zip', value: '*.psd' }] })
          if (r?.pattern) await run('lfs track', async () => { await git.lfsTrack(repo, String(r.pattern)); await load() }, '已写入 .gitattributes')
        }}><Icon name="plus" size={14} />Track…</button>
        <button className="btn" onClick={() => void load()}><Icon name="refresh" size={14} /></button>
      </div>
      {!!st.trackedPatterns.length && <p className="muted" style={{ marginTop: 8 }}>模式：{st.trackedPatterns.join(', ')}</p>}
      <div className="lfs-list">
        {st.files.map((f) => (
          <div key={f.path} className="lfs-row">
            <Icon name="lfs" size={14} />
            <span className="flex1 mono">{f.path}</span>
            <span className="muted">{f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.round(f.size / 1e3)} KB`}</span>
            {f.size > 50 * 1e6 && <span className="kind-tag warn">大文件</span>}
          </div>
        ))}
      </div>
      {!st.files.length && st.used && <Empty icon="lfs" title="没有列出的 LFS 文件" />}
    </div>
  )
}


function IgnorePanel({ repo }: { repo: string }) {
  const toast = useToast()
  const [sources, setSources] = useState<Awaited<ReturnType<typeof git.listIgnoreSources>>>([])
  const [sel, setSel] = useState('.gitignore')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState('')
  const [explain, setExplain] = useState<{ ignored: boolean; explain: string; source?: string; line?: number; pattern?: string } | null>(null)
  const editable = sel === '.gitignore' || (!sel.startsWith('/') && sel.endsWith('.gitignore') && !sel.includes('exclude'))

  const applySource = useCallback(async (list: Awaited<ReturnType<typeof git.listIgnoreSources>>, path: string) => {
    setSel(path)
    const hit = list.find((s) => s.path === path)
    const canEdit = path === '.gitignore' || (path.endsWith('/.gitignore') && !path.startsWith('/'))
    if (!canEdit && hit) {
      setText(hit.lines.map((l) => l.raw).join('\n') + (hit.lines.length ? '\n' : ''))
      return
    }
    try { setText(await git.readIgnoreFile(repo, path)) } catch { setText(hit ? hit.lines.map((l) => l.raw).join('\n') : '') }
  }, [repo])

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const list = await git.listIgnoreSources(repo)
      setSources(list)
      const prefer = list.find((s) => s.path === '.gitignore')?.path || list[0]?.path || '.gitignore'
      await applySource(list, prefer)
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }, [repo, toast, applySource])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (!editable) { toast('err', '这里只能编辑仓库内的 .gitignore'); return }
    setBusy(true)
    try {
      await git.writeIgnoreFile(repo, text, sel)
      toast('ok', '已保存忽略规则')
      await load()
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false) }
  }

  const check = async () => {
    const p = probe.trim()
    if (!p) { toast('err', '输入要检查的路径，例如 dist/app.js'); return }
    setBusy(true)
    try { setExplain(await git.checkIgnorePath(repo, p)) }
    catch (e) { toast('err', errMsg(e)); setExplain(null) }
    finally { setBusy(false) }
  }

  return (
    <div className="ignore-panel" data-testid="ignore-panel">
      <p className="muted small">查看生效的忽略来源（根 .gitignore、子目录、本仓库 exclude、全局）。可编辑仓库内 .gitignore，并预览某路径为何被忽略。不影响 blame 等其它工具。</p>
      <div className="row gap" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <label className="muted small">来源{' '}
          <select value={sel} onChange={(e) => void applySource(sources, e.target.value)} data-testid="ignore-source" title="忽略规则来源">
            {sources.map((s) => <option key={s.path} value={s.path}>{s.label}（{s.lines.filter((l) => l.pattern).length} 条）</option>)}
            {!sources.length && <option value=".gitignore">仓库根 · .gitignore</option>}
          </select>
        </label>
        <button className="btn btn-sm" onClick={() => void load()} disabled={busy} data-testid="ignore-reload"><Icon name="refresh" size={13} />刷新</button>
        <button className="btn btn-sm btn-primary" onClick={() => void save()} disabled={busy || !editable} data-testid="ignore-save" title={editable ? '保存到所选 .gitignore' : '只能编辑仓库内 .gitignore'}>
          {busy ? <Spinner size={12} /> : null}保存
        </button>
      </div>
      <textarea className="ignore-editor mono" value={text} onChange={(e) => setText(e.target.value)} rows={14}
        readOnly={!editable} data-testid="ignore-editor" spellCheck={false}
        placeholder="# 每行一条规则，# 开头是注释，! 开头表示不忽略" />
      {!editable && <p className="muted small">此来源为只读预览（全局或 .git/info/exclude）。</p>}
      <div className="row gap" style={{ marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="flex1" value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="检查路径：如 node_modules/x 或 dist/a.js"
          data-testid="ignore-probe" onKeyDown={(e) => { if (e.key === 'Enter') void check() }} />
        <button className="btn btn-sm" onClick={() => void check()} disabled={busy} data-testid="ignore-check">为何忽略？</button>
      </div>
      {explain && (
        <div className={`ignore-explain ${explain.ignored ? 'ignored' : 'ok'}`} data-testid="ignore-explain">
          <b>{explain.ignored ? '会被忽略' : '不会被忽略'}</b>
          <p>{explain.explain}</p>
          {explain.pattern && <p className="muted small mono">规则：{explain.pattern}{explain.source ? ` · ${explain.source}` : ''}{explain.line != null ? `:${explain.line}` : ''}</p>}
        </div>
      )}
      {!!sources.length && (
        <details className="ignore-lines" style={{ marginTop: 10 }} data-testid="ignore-lines">
          <summary className="muted small">当前来源解析（{sources.find((s) => s.path === sel)?.lines.length ?? 0} 行）</summary>
          <ul className="mod-hub-list">
            {(sources.find((s) => s.path === sel)?.lines ?? []).filter((l) => l.pattern || l.comment).slice(0, 80).map((l) => (
              <li key={l.line} className="mono small">
                <span className="muted">{l.line}</span>{' '}
                {l.comment ? <span className="muted">{l.raw}</span> : <span>{l.negated ? '!' : ''}{l.pattern}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
