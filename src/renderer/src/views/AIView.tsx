import React, { useEffect, useRef, useState } from 'react'
import type { AIAction, AIChatMessage } from '@shared/types'
import { app, errMsg } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { useAIRunner, useRunState } from '../hooks/useAIRun'
import { AIResultBody } from '../components/AIResult'
import { Markdown, Spinner, useDialog, useToast, usePersistentState } from '../components/ui'

interface NlResult { commands: string[]; explanation: string }

export default function AIView() {
  const { active, settings, setView, run, status } = useApp()
  const repo = active!
  const toast = useToast()
  const dialog = useDialog()
  const [tab, setTab] = usePersistentState<'chat' | 'tools'>('gitloom.ai.tab', 'chat')
  // 快捷工具 output: single-flight runner (aborted on unmount / repo switch), text published once per frame
  const toolRun = useAIRunner()
  const toolState = useRunState(toolRun)
  const [outTitle, setOutTitle] = useState<string | null>(null)
  const out = outTitle ? { title: outTitle, text: toolState.text } : null
  const [nlLoading, setNlLoading] = useState(false)
  const loading = toolState.status === 'running' ? toolState.key : nlLoading ? 'nlToGit' : null
  const [nl, setNl] = useState('')
  const [nlRes, setNlRes] = useState<NlResult | null>(null)
  const [base, setBase] = useState('main')
  const [task, setTask] = useState('')
  const [cmdOut, setCmdOut] = useState<string | null>(null)

  // multi-turn chat
  const [messages, setMessages] = usePersistentState<AIChatMessage[]>(`gitloom.ai.chat.${repo}`, [])
  const [input, setInput] = useState('')
  // chat: one request at a time; 停止 / leaving the view aborts it; streamed text throttled to animation frames
  const chatRun = useAIRunner()
  const chat = useRunState(chatRun)
  const chatBusy = chat.status === 'running'
  const partial = chatBusy ? chat.text : ''
  const pendingTurn = useRef<AIChatMessage[] | null>(null)
  useEffect(() => { chatRun.reset(); toolRun.reset(); setOutTitle(null) }, [chatRun, toolRun, repo])
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: partial ? 'auto' : 'smooth' }) }, [messages, chatBusy, partial])

  const send = (): void => {
    const text = input.trim()
    if (!text || chatRun.running) return          // synchronous guard: Ctrl+Enter ×5 → one request
    const next: AIChatMessage[] = [...messages, { role: 'user', content: text }]
    setMessages(next); setInput('')
    pendingTurn.current = next
    chatRun.start(`chat|${repo}|${next.length}|${Date.now()}`, async (signal, onDelta) => {
      try {
        const reply = await app.aiChat(next, repo, onDelta, signal)
        setMessages([...next, { role: 'assistant', content: reply }])
        return reply
      } catch (e) {
        if (!signal.aborted) toast('err', errMsg(e))
        throw e
      } finally { if (pendingTurn.current === next) pendingTurn.current = null }
    })
  }
  const stopChat = (): void => {
    const s = chatRun.getState()
    const turn = pendingTurn.current
    chatRun.stop()
    if (turn && s.text) setMessages([...turn, { role: 'assistant', content: `${s.text}\n\n_（已停止生成）_` }])
    pendingTurn.current = null
  }

  const go = (action: AIAction, title: string, payload?: Record<string, string>): void => {
    if (toolRun.running) return
    setOutTitle(title)
    toolRun.start(action, async (signal, onDelta) => {
      try { return await app.aiStream(action, repo, payload, onDelta, signal) } catch (e) { if (!signal.aborted) toast('err', errMsg(e)); throw e }
    }, { force: true })
  }
  const translate = async () => {
    if (!nl.trim() || nlLoading) return
    setNlLoading(true)
    try {
      const raw = await app.ai('nlToGit', repo, { question: nl })
      const m = /\{[\s\S]*\}/.exec(raw)
      const j = JSON.parse(m ? m[0] : raw) as NlResult
      setNlRes({ commands: (j.commands ?? []).filter((c) => c.trim().startsWith('git ')), explanation: j.explanation ?? '' })
    } catch (e) { toast('err', `解析失败：${errMsg(e)}`) } finally { setNlLoading(false) }
  }
  const exec = async (cmd: string) => {
    const danger = /reset --hard|push .*(-f|--force)|clean -[a-z]*f|branch -D|checkout -- \.|filter-branch/.test(cmd)
    const ok = await dialog({ title: danger ? '执行危险命令' : '执行命令', message: <><code>{cmd}</code><br />将在 {repo} 中执行。</>, danger, okText: '执行' })
    if (!ok) return
    const r = await run('执行命令', () => app.gitRaw(repo, cmd))
    if (r) setCmdOut(`$ ${cmd}\n${r.output || (r.ok ? '（完成，无输出）' : '')}`)
  }
  const configured = (settings?.ai.profiles ?? []).some((p) => !!p.baseUrl) || (!!settings?.ai.baseUrl && !!settings?.ai.model)

  return (
    <div className="page ai-page">
      {!configured && (
        <div className="notice"><Icon name="warn" />尚未配置 AI 模型。<a onClick={() => setView('settings')}>前往设置</a>，选择服务商（OpenAI、Claude、DeepSeek、通义千问、Kimi、OpenRouter、Ollama 等）并填写 API Key。</div>
      )}
      <div className="seg seg-sm" style={{ marginBottom: 12 }}>
        <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}><Icon name="ai" size={13} />对话</button>
        <button className={tab === 'tools' ? 'on' : ''} onClick={() => setTab('tools')}><Icon name="tools" size={13} />快捷工具</button>
      </div>

      {tab === 'chat' && (
        <div className="ai-chat">
          <div className="ai-chat-msgs" role="log" aria-live="polite">
            {!messages.length && (
              <EmptyChat repo={repo} branch={status?.branch} onHint={(t) => setInput(t)} />
            )}
            {messages.map((m, i) => (
              <div key={i} className={`ai-msg ai-${m.role}`}>
                <div className="ai-msg-role">{m.role === 'user' ? '你' : 'GitLoom AI'}</div>
                {m.role === 'assistant' ? <Markdown text={m.content} /> : <div className="ai-msg-text">{m.content}</div>}
              </div>
            ))}
            {chatBusy && (partial
              ? <div className="ai-msg ai-assistant ai-streaming" data-testid="ai-streaming"><div className="ai-msg-role">GitLoom AI <Spinner size={11} /></div><Markdown text={partial} /></div>
              : <div className="ai-msg ai-assistant"><Spinner size={14} /> 思考中…</div>)}
            <div ref={endRef} />
          </div>
          <div className="ai-chat-input">
            <textarea rows={2} value={input} onChange={(e) => setInput(e.target.value)}
              placeholder="询问当前仓库、差异、冲突解决建议…（已自动附带仓库上下文）"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }} />
            <div className="row gap">
              <button className="btn btn-sm" onClick={() => setMessages([])} disabled={!messages.length}>清空</button>
              <div className="flex1" />
              <span className="muted small">Ctrl+Enter 发送 · 已绑定当前仓库差异</span>
              {chatBusy
                ? <button className="btn" data-testid="ai-chat-stop" onClick={stopChat} title="停止生成（中断请求）"><Icon name="stop" size={13} />停止</button>
                : <button className="btn btn-ai" disabled={!input.trim()} onClick={() => send()}><Icon name="ai" size={13} />发送</button>}
            </div>
          </div>
        </div>
      )}

      {tab === 'tools' && (
        <>
          <div className="ai-grid">
            <div className="card ai-tool">
              <div className="ai-tool-head"><Icon name="ai" /><b>自然语言 → Git 命令</b></div>
              <div className="muted small">描述你想做的事，AI 给出命令和解释；确认后才会执行。</div>
              <textarea rows={3} placeholder="例如：撤销最近一次提交但保留改动…" value={nl} onChange={(e) => setNl(e.target.value)} />
              <div className="row"><button className="btn btn-ai" onClick={translate} disabled={!!loading}>{loading === 'nlToGit' ? <Spinner /> : <Icon name="ai" size={13} />}生成命令</button></div>
              {nlRes && (
                <div className="nl-result">
                  {nlRes.commands.map((c, i) => (
                    <div key={i} className="cmd-row"><code>{c}</code><button className="btn btn-xs" onClick={() => navigator.clipboard.writeText(c)}><Icon name="copy" size={12} /></button><button className="btn btn-xs btn-primary" onClick={() => exec(c)}><Icon name="play" size={12} />执行</button></div>
                  ))}
                  <Markdown text={nlRes.explanation} />
                </div>
              )}
              {cmdOut && <pre className="cmd-out">{cmdOut}</pre>}
            </div>
            <div className="card ai-tool">
              <div className="ai-tool-head"><Icon name="eye" /><b>代码审查 & 解释</b></div>
              <div className="muted small">暂存 {status?.staged.length ?? 0} · 未暂存 {status?.unstaged.length ?? 0}</div>
              <div className="btn-col">
                <button className="btn btn-ai" disabled={!!loading} onClick={() => go('reviewStaged', 'AI 代码审查（暂存区）')}>{loading === 'reviewStaged' ? <Spinner /> : <Icon name="eye" size={13} />}审查暂存区</button>
                <button className="btn btn-ai" disabled={!!loading} onClick={() => go('explainDiff', 'AI 解释工作区改动', {})}>{loading === 'explainDiff' ? <Spinner /> : <Icon name="diff" size={13} />}解释未暂存改动</button>
                <button className="btn btn-ai" disabled={!!loading} onClick={() => go('commitMessage', 'AI 提交信息草稿')}>{loading === 'commitMessage' ? <Spinner /> : <Icon name="check" size={13} />}生成提交信息</button>
              </div>
            </div>
            <div className="card ai-tool">
              <div className="ai-tool-head"><Icon name="merge" /><b>PR 描述</b></div>
              <label className="inline-field">基准分支 <input value={base} onChange={(e) => setBase(e.target.value)} /></label>
              <div className="row"><button className="btn btn-ai" disabled={!!loading} onClick={() => go('prDescription', `PR 描述（${base}..HEAD）`, { base })}>{loading === 'prDescription' ? <Spinner /> : <Icon name="ai" size={13} />}生成</button></div>
            </div>
            <div className="card ai-tool">
              <div className="ai-tool-head"><Icon name="branch" /><b>分支命名</b></div>
              <input placeholder="任务描述" value={task} onChange={(e) => setTask(e.target.value)} />
              <div className="row"><button className="btn btn-ai" disabled={!!loading || !task} onClick={() => go('branchName', '分支名建议', { question: task })}>{loading === 'branchName' ? <Spinner /> : <Icon name="ai" size={13} />}建议</button></div>
            </div>
          </div>
          {out && (
            <div className="card ai-output">
              <div className="ai-tool-head"><Icon name="ai" /><b>{out.title}</b><div className="flex1" />
                {toolState.status === 'running'
                  ? <button className="btn btn-xs" onClick={() => toolRun.stop()}><Icon name="stop" size={12} />停止</button>
                  : <button className="btn btn-xs" onClick={() => navigator.clipboard.writeText(out.text)}><Icon name="copy" size={12} />复制</button>}
                <button className="icon-btn" title="关闭" aria-label="关闭" onClick={() => { toolRun.stop(); setOutTitle(null) }}><Icon name="x" /></button></div>
              <div className="ai-output-body"><AIResultBody s={toolState} prefix="ai-tool" /></div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EmptyChat({ repo, branch, onHint }: { repo: string; branch?: string | null; onHint: (t: string) => void }) {
  const hints = [
    '总结当前未提交的改动，并建议提交信息',
    '解释最近一次合并冲突该如何解决',
    `当前在 ${branch ?? '未知分支'}，帮我规划一次交互式变基到 main`,
    '检查有没有误提交的密钥或大文件'
  ]
  return (
    <div className="ai-chat-empty">
      <Icon name="ai" size={28} />
      <b>多轮对话 · 已绑定仓库上下文</b>
      <p className="muted">{repo.split(/[\\/]/).pop()} {branch ? `· ${branch}` : ''}</p>
      <div className="ai-hints">{hints.map((h) => <button key={h} className="btn btn-sm" onClick={() => onHint(h)}>{h}</button>)}</div>
    </div>
  )
}
