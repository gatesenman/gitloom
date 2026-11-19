import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'
import { projectIdOf, wikiRoot, ensureWiki, statusOf, listWikiPages, readWikiPage, ingestWiki, migrateLegacyWiki, saveWikiSettings, writeWikiPage } from '../src/main/wiki'
import { tmpRepo, write, commitAll } from './helpers'

describe('project wiki MVP', () => {
  let userData: string
  let projectRoot: string
  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'gitloom-wiki-ud-'))
    projectRoot = mkdtempSync(path.join(tmpdir(), 'gitloom-wiki-proj-'))
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('projectId is stable hash of normalized path', () => {
    const a = projectIdOf(projectRoot)
    const b = projectIdOf(projectRoot + path.sep)
    expect(a).toMatch(/^[a-f0-9]{16}$/)
    expect(a).toBe(b)
    expect(wikiRoot(projectRoot, userData)).toBe(path.join(userData, 'projects', a, 'wiki'))
  })

  it('ensureWiki creates SCHEMA/index/log/pages and settings', async () => {
    const st = await ensureWiki(projectRoot, userData)
    expect(st.exists).toBe(true)
    const root = wikiRoot(projectRoot, userData)
    for (const f of ['SCHEMA.md', 'index.md', 'log.md', 'wiki-settings.json']) expect(existsSync(path.join(root, f))).toBe(true)
    expect(existsSync(path.join(root, 'pages'))).toBe(true)
    const s = JSON.parse(readFileSync(path.join(root, 'wiki-settings.json'), 'utf8'))
    expect(s.enabledAuto).toBe(false)
    expect(s.dailyTokenCap).toBeGreaterThan(0)
  })

  it('list/read pages and ingest without AI writes rule summary', async () => {
    await ensureWiki(projectRoot, userData)
    const repo = tmpRepo('wiki-ingest-')
    write(repo, 'a.txt', 'one\n')
    commitAll(repo, 'feat: one')
    write(repo, 'a.txt', 'two\n')
    commitAll(repo, 'fix: two')
    const r = await ingestWiki({
      projectRoot, userData, repo,
      commits: [{ hash: 'abc', short: 'abc1234', subject: 'fix: two', files: ['a.txt'] }],
      ai: null
    })
    expect(r.usedAi).toBe(false)
    expect(r.message).toMatch(/规则化|设置/)
    const pages = await listWikiPages(projectRoot, userData)
    expect(pages.some((p) => p.path.startsWith('pages/ingest-'))).toBe(true)
    const page = await readWikiPage(projectRoot, userData, r.page)
    expect(page.content).toContain('fix: two')
    const log = readFileSync(path.join(wikiRoot(projectRoot, userData), 'log.md'), 'utf8')
    expect(log).toMatch(/Ingest/)
  })

  it('migrateLegacyWiki copies without deleting source', async () => {
    await ensureWiki(projectRoot, userData)
    const legacy = path.join(projectRoot, 'docs', 'llmwiki')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(path.join(legacy, 'index.md'), '# old\n')
    writeFileSync(path.join(legacy, 'changelog.md'), 'log\n')
    const r = await migrateLegacyWiki(projectRoot, userData, legacy)
    expect(r.copied).toBeGreaterThan(0)
    expect(existsSync(path.join(legacy, 'index.md'))).toBe(true)
    expect(existsSync(path.join(wikiRoot(projectRoot, userData), 'pages', 'legacy-llmwiki', 'index.md'))).toBe(true)
    const st = await statusOf(projectRoot, userData)
    expect(st.legacyDir).toBe(legacy)
  })

  it('saveWikiSettings merges patch', async () => {
    const s = await saveWikiSettings(projectRoot, userData, { dailyTokenCap: 1000 })
    expect(s.enabledAuto).toBe(false)
    expect(s.dailyTokenCap).toBe(1000)
  })

  it('writeWikiPage creates new page and updates index/log', async () => {
    await ensureWiki(projectRoot, userData)
    const r = await writeWikiPage(projectRoot, userData, { title: '架构约定', content: '分层：UI → 服务', summary: '约定' })
    expect(r.path).toMatch(/^pages\//)
    expect(existsSync(path.join(r.root, r.path))).toBe(true)
    const page = await readWikiPage(projectRoot, userData, r.path)
    expect(page.content).toContain('架构约定')
    const pages = await listWikiPages(projectRoot, userData)
    expect(pages.some((p) => p.path === r.path)).toBe(true)
    const index = readFileSync(path.join(wikiRoot(projectRoot, userData), 'index.md'), 'utf8')
    expect(index).toContain('架构约定')
    const log = readFileSync(path.join(wikiRoot(projectRoot, userData), 'log.md'), 'utf8')
    expect(log).toMatch(/Create/)
  })

  it('writeWikiPage edits existing page', async () => {
    await ensureWiki(projectRoot, userData)
    const created = await writeWikiPage(projectRoot, userData, { title: '草稿', content: 'v1' })
    const edited = await writeWikiPage(projectRoot, userData, { rel: created.path, title: '草稿', content: '# 草稿\n\nv2 已改' })
    expect(edited.path).toBe(created.path)
    const page = await readWikiPage(projectRoot, userData, edited.path)
    expect(page.content).toContain('v2 已改')
    const log = readFileSync(path.join(wikiRoot(projectRoot, userData), 'log.md'), 'utf8')
    expect(log).toMatch(/Edit/)
  })
})
