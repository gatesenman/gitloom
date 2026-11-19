import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { readFileSync } from 'fs'
import * as path from 'path'
import { buildPrompt, chat, listModels, unfence } from '../src/main/ai'
import { GitService } from '../src/main/git/service'
import { tmpRepo, write, commitAll } from './helpers'
import type { AISettings } from '../src/shared/types'

// Minimal OpenAI-compatible mock server.
let server: http.Server
let base = ''
const seen: { auth?: string; body: { model: string; messages: { role: string; content: string }[] } }[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'mock-b' }, { id: 'mock-a' }] })); return }
      if (req.url !== '/v1/chat/completions') { res.statusCode = 404; res.end('nope'); return }
      const body = JSON.parse(data)
      seen.push({ auth: req.headers.authorization, body })
      const sys = body.messages[0].content as string
      let content = '<think>hidden</think>```\nfeat(core): add widget\n\n- adds widget\n```'
      if (sys.includes('项目文档维护者')) content = '- 新增 README 说明（mock 摘要）'
      if (sys.includes('JSON')) content = '{"commands":["git reset --soft HEAD~1"],"explanation":"撤销提交"}'
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(() => { server.close() })

const settings = (): AISettings => ({ baseUrl: base, apiKey: 'sk-test', model: 'mock-a', temperature: 0.1, language: 'zh', commitStyle: 'conventional' })

describe('AI client (OpenAI-compatible)', () => {
  it('sends auth + model and strips think/fences', async () => {
    const out = await chat(settings(), buildPrompt('commitMessage', settings(), { diff: 'diff --git a/x b/x' }))
    expect(unfence(out)).toBe('feat(core): add widget\n\n- adds widget')
    const last = seen[seen.length - 1]
    expect(last.auth).toBe('Bearer sk-test')
    expect(last.body.model).toBe('mock-a')
    expect(last.body.messages[0].content).toContain('Conventional Commits')
  })
  it('lists models', async () => {
    expect(await listModels(settings())).toEqual(['mock-a', 'mock-b'])
  })
  it('errors clearly when not configured', async () => {
    await expect(chat({ ...settings(), baseUrl: '' }, [])).rejects.toThrow(/接口地址/)
  })
  it('builds prompts for every action', () => {
    for (const a of ['commitMessage', 'explainDiff', 'reviewStaged', 'branchName', 'nlToGit', 'prDescription', 'conflictHelp'] as const) {
      const p = buildPrompt(a, settings(), { diff: 'd', question: 'q', log: 'l' })
      expect(p.length).toBe(2)
      expect(p[0].role).toBe('system')
    }
  })
  it('llmwiki hook appends an AI summary via the configured endpoint (env injection)', async () => {
    const git = new GitService()
    const repo = tmpRepo()
    write(repo, 'README.md', '# Wiki demo\n'); commitAll(repo, 'init')
    await git.installHookTemplate(repo, 'llmwiki')
    git.hookEnv = { LLMWIKI_BASE_URL: base, LLMWIKI_MODEL: 'mock-a', LLMWIKI_API_KEY: 'sk-hook', LLMWIKI_SYNC: '1' }
    write(repo, 'a.txt', 'a\n'); await git.stage(repo, ['a.txt'])
    await git.commit(repo, 'feat: add a')
    const cl = readFileSync(path.join(repo, 'docs/llmwiki/changelog.md'), 'utf8')
    expect(cl).toContain('feat: add a')
    expect(cl).toContain('AI 摘要')
    expect(cl).toContain('mock 摘要')
    expect(seen.some((s) => s.auth === 'Bearer sk-hook')).toBe(true)
  })
})
