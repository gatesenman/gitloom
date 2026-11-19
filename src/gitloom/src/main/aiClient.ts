// Protocol-aware AI client: request builders (OpenAI-compatible / Anthropic Messages / Azure OpenAI),
// SSE streaming parser, /models listing, Chinese error explanations, profile resolution + fallback chain.
// Pure module (no electron imports) so it is unit-tested directly — see tests/aiClient.test.ts.
// Endpoint/auth sources are documented per preset in src/shared/aiProviders.ts.
import type { AIAction, AIProfile, AISettings, AITask } from '../shared/types'
import { presetById, presetForUrl } from '../shared/aiProviders'

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface BuiltRequest { url: string; method: 'POST' | 'GET'; headers: Record<string, string>; body?: string }
export interface ChatOpts { model?: string; temperature?: number; maxTokens?: number; stream?: boolean }

export const ANTHROPIC_VERSION = '2023-06-01'
export const AZURE_DEFAULT_API_VERSION = '2024-10-21'

const trim = (u: string): string => u.trim().replace(/\/+$/, '')

function authHeaders(p: AIProfile): Record<string, string> {
  const h: Record<string, string> = { ...(presetById(p.preset).headers ?? {}), ...(p.headers ?? {}) }
  if (p.protocol === 'anthropic') {
    if (p.apiKey) h['x-api-key'] = p.apiKey
    h['anthropic-version'] = ANTHROPIC_VERSION
  } else if (p.protocol === 'azure') {
    if (p.apiKey) h['api-key'] = p.apiKey
  } else if (p.apiKey) h.authorization = `Bearer ${p.apiKey}`
  return h
}

/** Anthropic base may be given with or without /v1. */
function anthropicBase(u: string): string { return trim(u).replace(/\/v1$/, '') }

export function buildChatRequest(p: AIProfile, messages: ChatMessage[], o: ChatOpts = {}): BuiltRequest {
  const model = o.model || p.model
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(p) }
  if (o.stream) headers.accept = 'text/event-stream'
  if (p.protocol === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))
    // temperature is deprecated for newer Claude models (400 unless 1.0) → never sent
    const body: Record<string, unknown> = { model, max_tokens: o.maxTokens ?? 4096, messages: rest }
    if (system) body.system = system
    if (o.stream) body.stream = true
    return { url: `${anthropicBase(p.baseUrl)}/v1/messages`, method: 'POST', headers, body: JSON.stringify(body) }
  }
  const body: Record<string, unknown> = { messages }
  if (p.protocol !== 'azure') body.model = model
  if (o.temperature !== undefined) body.temperature = o.temperature
  if (o.maxTokens) body.max_tokens = o.maxTokens
  if (o.stream) body.stream = true
  if (p.protocol === 'azure') {
    const dep = encodeURIComponent((p.azureDeployment || model || '').trim())
    const ver = encodeURIComponent((p.azureApiVersion || AZURE_DEFAULT_API_VERSION).trim())
    return { url: `${trim(p.baseUrl)}/openai/deployments/${dep}/chat/completions?api-version=${ver}`, method: 'POST', headers, body: JSON.stringify(body) }
  }
  return { url: `${trim(p.baseUrl)}/chat/completions`, method: 'POST', headers, body: JSON.stringify(body) }
}

export function buildModelsRequest(p: AIProfile): BuiltRequest | null {
  if (p.protocol === 'azure') return null
  const headers = authHeaders(p)
  if (p.protocol === 'anthropic') return { url: `${anthropicBase(p.baseUrl)}/v1/models?limit=100`, method: 'GET', headers }
  return { url: `${trim(p.baseUrl)}/models`, method: 'GET', headers }
}

export function parseModels(json: unknown): string[] {
  const j = json as { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string; model?: string }[] }
  const list = j.data ?? j.models ?? []
  return [...new Set(list.map((m) => (m as { id?: string }).id ?? (m as { model?: string }).model ?? m.name ?? '').filter(Boolean))].sort()
}

export function parseChatResponse(protocol: AIProfile['protocol'], json: unknown): string {
  if (protocol === 'anthropic') {
    const j = json as { content?: { type: string; text?: string }[] }
    return (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  }
  const j = json as { choices?: { message?: { content?: string } }[] }
  return j.choices?.[0]?.message?.content ?? ''
}

/** Extract the text delta from one SSE `data:` payload (already JSON-parsed). Returns '' for non-text events. */
export function parseStreamChunk(protocol: AIProfile['protocol'], ev: unknown): string {
  if (protocol === 'anthropic') {
    const e = ev as { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } }
    if (e.type === 'error') throw new Error(e.error?.message || 'Anthropic 流式响应出错')
    return e.type === 'content_block_delta' && e.delta?.type === 'text_delta' ? e.delta.text ?? '' : ''
  }
  const e = ev as { choices?: { delta?: { content?: string | null } }[]; error?: { message?: string } }
  if (e.error) throw new Error(e.error.message || '流式响应出错')
  return e.choices?.[0]?.delta?.content ?? ''
}

/** Incremental SSE splitter: feed raw text, get complete `data:` payloads back. */
export class SSEParser {
  private buf = ''
  push(chunk: string): string[] {
    this.buf += chunk.replace(/\r\n/g, '\n')
    const out: string[] = []
    let i: number
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 2)
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
      if (data) out.push(data)
    }
    return out
  }
  flush(): string[] { const rest = this.buf; this.buf = ''; return rest.trim() ? this.push(rest + '\n\n') : [] }
}

export class AIError extends Error {
  constructor(message: string, public kind: 'auth' | 'region' | 'balance' | 'model' | 'rate' | 'network' | 'timeout' | 'server' | 'config' | 'cancelled' | 'other', public retryable: boolean) { super(message) }
}

/** Map an HTTP error (or network failure) to a clear Chinese message with a suggested fix. */
export function explainAIError(p: Pick<AIProfile, 'preset' | 'baseUrl' | 'model'>, status: number, body: string): AIError {
  const b = body.toLowerCase()
  const preset = presetById(p.preset)
  const name = preset.id === 'custom' ? '服务商' : preset.name
  const detail = body ? `（${body.replace(/\s+/g, ' ').slice(0, 160)}）` : ''
  if (/insufficient|balance|quota|arrearage|余额|欠费|credit|billing|payment/.test(b) || status === 402)
    return new AIError(`${name} 账户余额不足或额度已用完，请到控制台充值或检查套餐。${detail}`, 'balance', true)
  if (status === 401 || status === 403 || /invalid[_ ]api[_ ]key|incorrect api key|unauthori[sz]ed|authentication/.test(b)) {
    if (preset.regions?.length) return new AIError(`API Key 无效，或与所选地域不匹配（${name} 的 Key 按地域/站点绑定，请确认 Base URL 与创建 Key 的地域一致）。${detail}`, 'region', false)
    return new AIError(`API Key 无效或没有权限，请检查 Key 是否复制完整、是否已过期。${detail}`, 'auth', false)
  }
  if (status === 404 || /model[_ ]not[_ ]found|does not exist|no such model|unknown model|not found|deploymentnotfound/.test(b)) {
    if (/model|deployment/.test(b) || status === 404) return new AIError(`找不到模型「${p.model || '未填写'}」${preset.protocol === 'azure' ? '（或部署名 / api-version 不正确）' : ''}，请点击「获取模型」从列表中选择，或确认已在控制台开通该模型。${detail}`, 'model', true)
  }
  if (status === 429) return new AIError(`请求过于频繁或触发限流，请稍后再试，或在设置里配置备用模型。${detail}`, 'rate', true)
  if (status >= 500) return new AIError(`${name} 服务暂时不可用（HTTP ${status}），稍后重试或切换备用模型。${detail}`, 'server', true)
  if (status === 400 && /model/.test(b)) return new AIError(`模型参数有误：${detail}`, 'model', true)
  return new AIError(`AI 接口返回 HTTP ${status}${detail}`, 'other', false)
}

export function explainNetworkError(p: Pick<AIProfile, 'preset' | 'baseUrl'>, e: unknown): AIError {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return new AIError('AI 请求超时，请检查网络或稍后重试。', 'timeout', true)
  const cause = err?.cause as { code?: string; errors?: { code?: string }[] } | undefined
  const code = cause?.code ?? cause?.errors?.find((x) => x.code)?.code ?? ''
  const preset = presetById(p.preset)
  if (preset.keyOptional && preset.id !== 'custom' && /ECONNREFUSED/.test(code)) return new AIError(`连接不到 ${preset.name}（${p.baseUrl}），请确认本地服务已启动。`, 'network', true)
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return new AIError(`无法解析接口域名（${p.baseUrl}），请检查 Base URL 拼写或网络/代理设置。`, 'network', true)
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR/.test(code)) return new AIError(`无法连接到 ${p.baseUrl}（${code}），请检查网络、代理或地址是否正确。`, 'network', true)
  if (/CERT|SSL|TLS/.test(code)) return new AIError(`TLS 证书校验失败（${code}），如使用自签名中转请改用 http 或安装证书。`, 'network', true)
  if (err?.message === 'fetch failed') return new AIError(`无法连接到 ${p.baseUrl}${err.cause?.message ? `（${err.cause.message}）` : ''}，请检查地址、网络或代理。`, 'network', true)
  return new AIError(`AI 请求失败：${err?.message ?? String(e)}${code ? `（${code}）` : ''}`, 'network', true)
}

export function validateProfile(p: AIProfile | undefined): void {
  if (!p) throw new AIError('还没有配置 AI 服务商，请在「设置 → AI 模型」中添加', 'config', false)
  if (!p.baseUrl.trim() || /YOUR-RESOURCE/.test(p.baseUrl)) throw new AIError(`「${p.name}」未填写接口地址`, 'config', false)
  if (p.protocol === 'azure' && !(p.azureDeployment || p.model)) throw new AIError(`「${p.name}」未填写 Azure 部署名（deployment）`, 'config', false)
  if (p.protocol !== 'azure' && !p.model.trim()) throw new AIError(`「${p.name}」未选择模型`, 'config', false)
  if (!p.apiKey && !presetById(p.preset).keyOptional) throw new AIError(`「${p.name}」未填写 API Key`, 'config', false)
}

type Fetch = typeof fetch
/** The caller (user pressed 停止 / switched commit / closed the view) aborted the request. */
export const cancelledError = (): AIError => new AIError('已停止生成', 'cancelled', false)
export const isCancelled = (e: unknown): boolean => e instanceof AIError && e.kind === 'cancelled'

export interface CallOpts extends ChatOpts { timeoutMs?: number; onDelta?: (text: string) => void; signal?: AbortSignal; fetchImpl?: Fetch }

/** One request against one profile; streams when onDelta is given (all protocols use SSE). */
export async function callProfile(p: AIProfile, messages: ChatMessage[], o: CallOpts = {}): Promise<string> {
  validateProfile(p)
  if (o.signal?.aborted) throw cancelledError()
  const stream = !!o.onDelta
  const req = buildChatRequest(p, messages, { ...o, stream })
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 120000)
  const onAbort = (): void => ctl.abort()
  o.signal?.addEventListener('abort', onAbort, { once: true })
  const f = o.fetchImpl ?? fetch
  let res: Response
  try {
    res = await f(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ctl.signal })
  } catch (e) { clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); if (o.signal?.aborted) throw cancelledError(); throw explainNetworkError(p, e) }
  try {
    if (!res.ok) throw explainAIError({ ...p, model: o.model || p.model }, res.status, await res.text().catch(() => ''))
    const ctype = res.headers.get('content-type') ?? ''
    if (stream && res.body && /event-stream/.test(ctype)) {
      const sse = new SSEParser()
      const dec = new TextDecoder()
      const reader = res.body.getReader()
      let out = ''
      const handle = (data: string): boolean => {
        if (data === '[DONE]') return true
        let ev: unknown
        try { ev = JSON.parse(data) } catch { return false }
        const d = parseStreamChunk(p.protocol, ev)
        if (d) { out += d; o.onDelta!(d) }
        return false
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const d of sse.push(dec.decode(value, { stream: true }))) if (handle(d)) { void reader.cancel().catch(() => undefined); return finish(out) }
      }
      for (const d of sse.flush()) handle(d)
      return finish(out)
    }
    // non-streaming response (or a server that ignored stream:true)
    const text = await res.text()
    let j: unknown
    try { j = JSON.parse(text) } catch { throw new AIError('AI 接口返回的不是 JSON：' + text.slice(0, 200), 'other', false) }
    const content = parseChatResponse(p.protocol, j)
    if (stream && content) o.onDelta!(content)
    return finish(content)
  } catch (e) {
    if (o.signal?.aborted) throw cancelledError()
    if (e instanceof AIError) throw e
    throw explainNetworkError(p, e)
  } finally { clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort) }
}

function finish(s: string): string {
  const t = stripThink(s).trim()
  if (!t) throw new AIError('AI 接口没有返回内容', 'other', true)
  return t
}

/** Some reasoning models wrap thoughts in <think>…</think>. */
export function stripThink(s: string): string { return s.replace(/<think>[\s\S]*?<\/think>/g, '') }

export async function listProfileModels(p: AIProfile, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<{ models: string[]; source: 'remote' | 'preset'; error?: string }> {
  const preset = presetById(p.preset)
  const req = buildModelsRequest(p)
  if (!req) return { models: preset.models, source: 'preset', error: 'Azure 的模型由部署决定，请直接填写部署名' }
  try {
    const res = await fetchImpl(req.url, { headers: req.headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
    if (!res.ok) throw explainAIError(p, res.status, await res.text().catch(() => ''))
    const models = parseModels(await res.json())
    if (!models.length) return { models: preset.models, source: 'preset', error: '服务商返回了空列表，已显示推荐模型' }
    return { models, source: 'remote' }
  } catch (e) {
    if (signal?.aborted) throw cancelledError()
    const err = e instanceof AIError ? e : explainNetworkError(p, e)
    return { models: preset.models, source: 'preset', error: err.message }
  }
}

// ---------------------------------------------------------------- profiles, tasks, fallback

export const TASK_LABEL: Record<AITask, string> = { commit: '提交信息', review: '代码审查', explain: '解释差异', chat: 'AI 对话' }

export function taskOf(action: AIAction | 'chat'): AITask {
  switch (action) {
    case 'commitMessage': case 'branchName': return 'commit'
    case 'reviewStaged': case 'conflictHelp': return 'review'
    case 'explainDiff': case 'prDescription': return 'explain'
    default: return 'chat'
  }
}

/** Build profiles from a pre-0.4.2 single-endpoint config (idempotent). */
export function migrateAI(ai: AISettings): AISettings {
  if (ai.profiles && ai.profiles.length) return { ...ai, activeProfile: ai.profiles.some((p) => p.id === ai.activeProfile) ? ai.activeProfile : ai.profiles[0].id }
  if (!ai.baseUrl && !ai.apiKey && !ai.model) return { ...ai, profiles: [], activeProfile: undefined }
  const preset = presetForUrl(ai.baseUrl)
  const p: AIProfile = { id: 'p-legacy', name: preset.id === 'custom' ? '我的接口' : preset.name, preset: preset.id, protocol: preset.protocol === 'anthropic' ? 'openai' : preset.protocol, baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model }
  return { ...ai, profiles: [p], activeProfile: p.id, tasks: ai.tasks ?? {}, fallback: ai.fallback ?? [] }
}

export interface Candidate { profile: AIProfile; model: string }

/** Ordered list of (profile, model) to try for a task: task override → active profile → fallback chain. */
export function resolveCandidates(ai: AISettings, task: AITask): Candidate[] {
  const m = migrateAI(ai)
  const profiles = m.profiles ?? []
  const byId = (id?: string) => profiles.find((p) => p.id === id)
  const out: Candidate[] = []
  const add = (p: AIProfile | undefined, model?: string) => {
    if (!p) return
    const mdl = (model || p.model || '').trim()
    if (out.some((c) => c.profile.id === p.id && c.model === mdl)) return
    out.push({ profile: p, model: mdl })
  }
  const t = m.tasks?.[task]
  if (t?.profile || t?.model) add(byId(t.profile) ?? byId(m.activeProfile), t.model)
  add(byId(m.activeProfile) ?? profiles[0])
  for (const id of m.fallback ?? []) add(byId(id))
  return out
}

/** Run a chat through the candidate chain; retries the next candidate on retryable errors. */
export async function chatWithFallback(ai: AISettings, task: AITask, messages: ChatMessage[], o: CallOpts = {}): Promise<{ text: string; used: Candidate; attempts: string[] }> {
  const cands = resolveCandidates(ai, task)
  if (!cands.length) throw new AIError('还没有配置 AI 服务商，请在「设置 → AI 模型」中添加', 'config', false)
  const attempts: string[] = []
  let last: unknown
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]
    let streamed = false
    try {
      const text = await callProfile({ ...c.profile, model: c.model }, messages, {
        ...o, model: c.model, temperature: o.temperature ?? ai.temperature,
        onDelta: o.onDelta ? (d) => { streamed = true; o.onDelta!(d) } : undefined
      })
      return { text, used: c, attempts }
    } catch (e) {
      if (isCancelled(e) || o.signal?.aborted) throw cancelledError()   // user stopped: never fall back
      last = e
      attempts.push(`${c.profile.name} · ${c.model || '默认'}：${(e as Error).message}`)
      const retry = e instanceof AIError ? e.retryable || e.kind === 'auth' || e.kind === 'region' || e.kind === 'config' : true
      // never switch provider mid-answer: partial output was already shown
      if (streamed || !retry || i === cands.length - 1) break
    }
  }
  if (attempts.length > 1) throw new AIError(`所有模型都失败了：\n${attempts.map((a) => '• ' + a).join('\n')}`, (last as AIError)?.kind ?? 'other', false)
  throw last
}

/** Keep the legacy baseUrl/apiKey/model mirror in sync with the active OpenAI-compatible profile (used for hook env). */
export function syncLegacy(ai: AISettings): AISettings {
  const m = migrateAI(ai)
  const p = m.profiles?.find((x) => x.id === m.activeProfile)
  if (!p) return m
  if (p.protocol === 'openai') return { ...m, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }
  return m
}
