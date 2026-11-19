import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import {
  buildChatRequest, buildModelsRequest, parseModels, parseStreamChunk, SSEParser, explainAIError, migrateAI,
  resolveCandidates, chatWithFallback, callProfile, listProfileModels, syncLegacy, taskOf, ANTHROPIC_VERSION, isCancelled
} from '../src/main/aiClient'
import { AI_PRESETS, presetForUrl, presetMatches, presetById } from '../src/shared/aiProviders'
import type { AIProfile, AISettings } from '../src/shared/types'

const prof = (o: Partial<AIProfile> = {}): AIProfile => ({ id: 'p1', name: 'P1', preset: 'openai', protocol: 'openai', baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-1', model: 'gpt-x', ...o })
const msgs = [{ role: 'system' as const, content: 'SYS' }, { role: 'user' as const, content: 'hi' }]
const base = (o: Partial<AISettings> = {}): AISettings => ({ baseUrl: '', apiKey: '', model: '', temperature: 0.2, language: 'zh', commitStyle: 'conventional', ...o })

describe('request builders', () => {
  it('OpenAI-compatible: /chat/completions + Bearer + model/temperature/stream', () => {
    const r = buildChatRequest(prof(), msgs, { temperature: 0.3, stream: true, maxTokens: 50 })
    expect(r.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(r.headers.authorization).toBe('Bearer sk-1')
    expect(r.headers.accept).toBe('text/event-stream')
    const b = JSON.parse(r.body!)
    expect(b).toMatchObject({ model: 'gpt-x', temperature: 0.3, stream: true, max_tokens: 50 })
    expect(b.messages).toEqual(msgs)
  })
  it('OpenAI-compatible without key sends no auth header (local Ollama)', () => {
    const r = buildChatRequest(prof({ preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '' }), msgs)
    expect(r.headers.authorization).toBeUndefined()
    expect(r.url).toBe('http://localhost:11434/v1/chat/completions')
  })
  it('OpenRouter adds HTTP-Referer / X-Title attribution headers', () => {
    const r = buildChatRequest(prof({ preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }), msgs)
    expect(r.headers['HTTP-Referer']).toBeTruthy()
    expect(r.headers['X-Title']).toBe('GitLoom')
  })
  it('Anthropic: /v1/messages, x-api-key + anthropic-version, top-level system, max_tokens, no temperature', () => {
    for (const url of ['https://api.anthropic.com', 'https://api.anthropic.com/v1/']) {
      const r = buildChatRequest(prof({ preset: 'anthropic', protocol: 'anthropic', baseUrl: url, model: 'claude-sonnet-5-5' }), msgs, { temperature: 0.2, stream: true })
      expect(r.url).toBe('https://api.anthropic.com/v1/messages')
      expect(r.headers['x-api-key']).toBe('sk-1')
      expect(r.headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
      expect(r.headers.authorization).toBeUndefined()
      const b = JSON.parse(r.body!)
      expect(b.system).toBe('SYS')
      expect(b.messages).toEqual([{ role: 'user', content: 'hi' }])
      expect(b.max_tokens).toBe(4096)
      expect(b.temperature).toBeUndefined()
      expect(b.stream).toBe(true)
    }
  })
  it('Azure: deployment URL + api-version + api-key header, no model in body', () => {
    const r = buildChatRequest(prof({ preset: 'azure', protocol: 'azure', baseUrl: 'https://res.openai.azure.com/', azureDeployment: 'gpt prod', azureApiVersion: '2024-10-21' }), msgs)
    expect(r.url).toBe('https://res.openai.azure.com/openai/deployments/gpt%20prod/chat/completions?api-version=2024-10-21')
    expect(r.headers['api-key']).toBe('sk-1')
    expect(r.headers.authorization).toBeUndefined()
    expect(JSON.parse(r.body!).model).toBeUndefined()
  })
  it('models requests per protocol', () => {
    expect(buildModelsRequest(prof())!.url).toBe('https://api.openai.com/v1/models')
    const a = buildModelsRequest(prof({ protocol: 'anthropic', preset: 'anthropic', baseUrl: 'https://api.anthropic.com' }))!
    expect(a.url).toBe('https://api.anthropic.com/v1/models?limit=100')
    expect(a.headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(buildModelsRequest(prof({ protocol: 'azure', preset: 'azure' }))).toBeNull()
    expect(parseModels({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] })).toEqual(['a', 'b'])
  })
})

describe('streaming parsers', () => {
  it('SSE parser handles split chunks, CRLF and [DONE]', () => {
    const p = new SSEParser()
    expect(p.push('data: {"a":1}\r\n\r\ndata: {"b"')).toEqual(['{"a":1}'])
    expect(p.push(':2}\n\nevent: x\ndata: [DONE]\n\n')).toEqual(['{"b":2}', '[DONE]'])
    expect(p.push('data: tail')).toEqual([])
    expect(p.flush()).toEqual(['tail'])
  })
  it('extracts deltas for OpenAI and Anthropic events', () => {
    expect(parseStreamChunk('openai', { choices: [{ delta: { content: '你' } }] })).toBe('你')
    expect(parseStreamChunk('azure', { choices: [] })).toBe('')
    expect(parseStreamChunk('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } })).toBe('好')
    expect(parseStreamChunk('anthropic', { type: 'message_start' })).toBe('')
    expect(() => parseStreamChunk('anthropic', { type: 'error', error: { message: 'overloaded' } })).toThrow(/overloaded/)
  })
})

describe('Chinese error explanations', () => {
  const p = { preset: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }
  it('maps auth / region / balance / model / rate / server', () => {
    expect(explainAIError(p, 401, '{"error":{"message":"Authentication Fails"}}').kind).toBe('auth')
    expect(explainAIError({ ...p, preset: 'dashscope' }, 401, 'Incorrect API key provided').message).toMatch(/地域/)
    expect(explainAIError(p, 402, 'Insufficient Balance').message).toMatch(/余额/)
    expect(explainAIError(p, 400, '{"error":{"code":"Arrearage"}}').kind).toBe('balance')
    const m = explainAIError(p, 404, 'model_not_found')
    expect(m.kind).toBe('model'); expect(m.message).toMatch(/deepseek-flash/)
    expect(explainAIError(p, 429, '').kind).toBe('rate')
    expect(explainAIError(p, 503, '').retryable).toBe(true)
  })
})

describe('profiles, migration, tasks', () => {
  it('migrates the legacy single endpoint into a profile and detects the preset', () => {
    const m = migrateAI(base({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-flash' }))
    expect(m.profiles).toHaveLength(1)
    expect(m.profiles![0]).toMatchObject({ preset: 'deepseek', apiKey: 'k', model: 'deepseek-flash', protocol: 'openai' })
    expect(m.activeProfile).toBe(m.profiles![0].id)
    expect(migrateAI(m)).toEqual(m)
    expect(migrateAI(base()).profiles).toEqual([])
    expect(presetForUrl('http://10.0.0.5:8000/v1').id).toBe('custom')
  })
  it('syncLegacy mirrors the active OpenAI-compatible profile', () => {
    const s = syncLegacy(base({ profiles: [prof({ baseUrl: 'https://x/v1', model: 'm' })], activeProfile: 'p1' }))
    expect(s).toMatchObject({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-1' })
  })
  it('resolves task override → active → fallback chain, de-duplicated', () => {
    const a = prof({ id: 'a', model: 'ma' }), b = prof({ id: 'b', model: 'mb' }), c = prof({ id: 'c', model: 'mc' })
    const s = base({ profiles: [a, b, c], activeProfile: 'a', tasks: { commit: { profile: 'b', model: 'fast' } }, fallback: ['c', 'a'] })
    expect(resolveCandidates(s, 'commit').map((x) => `${x.profile.id}:${x.model}`)).toEqual(['b:fast', 'a:ma', 'c:mc'])
    expect(resolveCandidates(s, 'chat').map((x) => x.profile.id)).toEqual(['a', 'c'])
    expect(taskOf('commitMessage')).toBe('commit'); expect(taskOf('reviewStaged')).toBe('review'); expect(taskOf('explainDiff')).toBe('explain'); expect(taskOf('nlToGit')).toBe('chat')
  })
})

describe('presets', () => {
  it('every preset has a verified source, a valid base URL and a key link', () => {
    expect(AI_PRESETS.length).toBeGreaterThanOrEqual(23)
    for (const p of AI_PRESETS) {
      expect(p.source.length, p.id).toBeGreaterThan(10)
      if (p.id !== 'custom') expect(() => new URL(p.baseUrl), p.id).not.toThrow()
      if (!['custom', 'oneapi'].includes(p.id)) expect(p.keyUrl, p.id).toMatch(/^https:\/\//)
      for (const r of p.regions ?? []) expect(() => new URL(r.baseUrl)).not.toThrow()
    }
    for (const id of ['openai', 'anthropic', 'gemini', 'xai', 'mistral', 'groq', 'azure', 'deepseek', 'dashscope', 'zhipu', 'moonshot', 'ark', 'qianfan', 'hunyuan', 'minimax', 'spark', 'yi', 'openrouter', 'siliconflow', 'oneapi', 'ollama', 'lmstudio', 'custom'])
      expect(presetById(id).id).toBe(id)
    expect(presetMatches(presetById('dashscope'), 'qwen')).toBe(true)
    expect(presetMatches(presetById('dashscope'), '千问')).toBe(true)
  })
})

// ------------------------------------------------------------------ live mock server: streaming for every protocol
let server: http.Server
let url = ''
let slowClosed = 0
const hits: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = []
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {}
      hits.push({ path: req.url ?? '', headers: req.headers, body })
      const u = req.url ?? ''
      if (u.startsWith('/slow')) {
        res.setHeader('content-type', 'text/event-stream')
        const t = setInterval(() => res.write('data: {"choices":[{"delta":{"content":"段"}}]}\n\n'), 30)
        res.on('close', () => { clearInterval(t); slowClosed++ })
        return
      }
      if (u.startsWith('/down')) { res.statusCode = 503; res.end('upstream down'); return }
      if (u.startsWith('/poor')) { res.statusCode = 402; res.end('{"error":{"message":"Insufficient Balance"}}'); return }
      if (u === '/v1/models' || u === '/anth/v1/models?limit=100') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }] })); return }
      res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json')
      if (u.startsWith('/anth/v1/messages')) {
        if (!body.stream) { res.end(JSON.stringify({ content: [{ type: 'text', text: '你好' }] })); return }
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n')
        setTimeout(() => { res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'); res.end() }, 20)
        return
      }
      if (!body.stream) { res.end(JSON.stringify({ choices: [{ message: { content: '<think>x</think>你好' } }] })); return }
      res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"delta":{"content":"你"}}]}\n\n')
      setTimeout(() => { res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n'); res.end() }, 20)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.close() })

describe('callProfile against a mock server', () => {
  it('streams OpenAI-compatible, Anthropic and Azure responses', async () => {
    const cases: AIProfile[] = [
      prof({ preset: 'custom', baseUrl: `${url}/v1` }),
      prof({ preset: 'anthropic', protocol: 'anthropic', baseUrl: `${url}/anth` }),
      prof({ preset: 'azure', protocol: 'azure', baseUrl: url, azureDeployment: 'dep1', azureApiVersion: '2024-10-21' })
    ]
    for (const c of cases) {
      const deltas: string[] = []
      const out = await callProfile(c, msgs, { onDelta: (d) => deltas.push(d) })
      expect(out, c.protocol).toBe('你好')
      expect(deltas, c.protocol).toEqual(['你', '好'])
    }
    expect(hits.some((h) => h.path === '/openai/deployments/dep1/chat/completions?api-version=2024-10-21' && h.headers['api-key'] === 'sk-1')).toBe(true)
    expect(hits.some((h) => h.path === '/anth/v1/messages' && h.headers['anthropic-version'] === ANTHROPIC_VERSION)).toBe(true)
  })
  it('non-streaming call strips <think>', async () => {
    expect(await callProfile(prof({ preset: 'custom', baseUrl: `${url}/v1` }), msgs)).toBe('你好')
  })
  it('falls back to the next profile when the primary is down, but not mid-stream', async () => {
    const s = base({ profiles: [prof({ id: 'down', name: 'Down', preset: 'custom', baseUrl: `${url}/down` }), prof({ id: 'ok', name: 'OK', preset: 'custom', baseUrl: `${url}/v1` })], activeProfile: 'down', fallback: ['ok'] })
    const r = await chatWithFallback(s, 'chat', msgs)
    expect(r.used.profile.id).toBe('ok')
    expect(r.attempts[0]).toMatch(/暂时不可用/)
  })
  it('reports every attempt in Chinese when all fail', async () => {
    const s = base({ profiles: [prof({ id: 'p', name: '穷', preset: 'custom', baseUrl: `${url}/poor` }), prof({ id: 'd', name: '挂', preset: 'custom', baseUrl: `${url}/down` })], activeProfile: 'p', fallback: ['d'] })
    await expect(chatWithFallback(s, 'commit', msgs)).rejects.toThrow(/所有模型都失败了[\s\S]*余额[\s\S]*暂时不可用/)
  })
  it('validates config and explains connection errors', async () => {
    await expect(callProfile(prof({ apiKey: '' }), msgs)).rejects.toThrow(/API Key/)
    await expect(callProfile(prof({ model: '' }), msgs)).rejects.toThrow(/模型/)
    await expect(callProfile(prof({ preset: 'ollama', baseUrl: 'http://127.0.0.1:59999/v1', apiKey: '' }), msgs, { timeoutMs: 5000 })).rejects.toThrow(/Ollama|连接/)
  })
  it('lists models remotely and falls back to preset suggestions', async () => {
    expect(await listProfileModels(prof({ preset: 'custom', baseUrl: `${url}/v1` }))).toEqual({ models: ['a-model', 'z-model'], source: 'remote' })
    expect((await listProfileModels(prof({ preset: 'anthropic', protocol: 'anthropic', baseUrl: `${url}/anth` }))).models).toEqual(['a-model', 'z-model'])
    const f = await listProfileModels(prof({ preset: 'deepseek', baseUrl: `${url}/down` }))
    expect(f.source).toBe('preset'); expect(f.models).toContain('deepseek-flash'); expect(f.error).toMatch(/不可用/)
  })
})

describe('cancellation (停止 / switching commit)', () => {
  it('aborting mid-stream rejects with a cancelled AIError and closes the HTTP connection', async () => {
    const ctl = new AbortController()
    let got = ''
    const before = slowClosed
    const p = callProfile(prof({ preset: 'custom', baseUrl: `${url}/slow` }), [{ role: 'user', content: 'hi' }], { signal: ctl.signal, onDelta: (d) => { got += d; if (got.length >= 3) ctl.abort() } })
    const e = await p.catch((x) => x)
    expect(isCancelled(e)).toBe(true)
    expect((e as Error).message).toBe('已停止生成')
    await new Promise((r) => setTimeout(r, 100))
    expect(slowClosed).toBe(before + 1)
  })
  it('an already-aborted signal never sends a request', async () => {
    const ctl = new AbortController(); ctl.abort()
    const n = hits.length
    await expect(callProfile(prof({ preset: 'custom', baseUrl: `${url}/v1` }), [{ role: 'user', content: 'x' }], { signal: ctl.signal })).rejects.toMatchObject({ kind: 'cancelled' })
    expect(hits.length).toBe(n)
  })
  it('a cancelled request never falls back to the next provider', async () => {
    const ai: AISettings = { baseUrl: '', apiKey: '', model: '', temperature: 0.2, language: 'zh', commitStyle: 'conventional',
      profiles: [prof({ id: 'a', preset: 'custom', baseUrl: `${url}/slow` }), prof({ id: 'b', preset: 'custom', baseUrl: `${url}/v1` })], activeProfile: 'a', fallback: ['b'] }
    const ctl = new AbortController()
    const n = hits.length
    setTimeout(() => ctl.abort(), 80)
    await expect(chatWithFallback(ai, 'explain', [{ role: 'user', content: 'x' }], { signal: ctl.signal, onDelta: () => undefined })).rejects.toMatchObject({ kind: 'cancelled' })
    expect(hits.slice(n).every((h) => h.path.startsWith('/slow'))).toBe(true)
  })
})
