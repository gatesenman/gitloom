// Project-level LLM Wiki (local only, outside any repo). MVP for 0.6.3.
import { createHash } from 'crypto'
import { promises as fsp, existsSync } from 'fs'
import * as path from 'path'
import { chat, type ChatMessage } from './ai'
import type { AISettings } from '../shared/types'

export interface WikiSettings {
  enabledAuto: boolean
  dailyTokenCap: number
}

export interface WikiPageMeta {
  path: string
  title: string
  summary?: string
}

export interface WikiStatus {
  projectId: string
  root: string
  exists: boolean
  pages: WikiPageMeta[]
  settings: WikiSettings
  legacyDir?: string
}

const DEFAULT_SETTINGS: WikiSettings = { enabledAuto: false, dailyTokenCap: 200_000 }

const SCHEMA_MD = `# Wiki 规则（SCHEMA）

本目录是 **项目级、仅本地** 的知识库，不进入任何 Git 仓库。

## 页面类型
- **仓库页**：每个仓库一份概览（用途、入口、依赖）
- **模块页**：按目录/包描述职责与边界
- **概念页**：领域术语、缩写
- **决策页**：重要架构/产品决策与理由
- **变更摘要页**：某次吸收（ingest）产生的提交摘要

## 约定
- \`index.md\`：目录，每页一行摘要
- \`log.md\`：只追加时间线，条目形如 \`## [YYYY-MM-DD] 操作 | 标题\`
- \`pages/\`：正文 Markdown
- 自动更新默认关闭；手动「吸收最近提交」会更新相关页并写日志
`

const INDEX_MD = `# 项目 Wiki

> 由 GitLoom 维护的本地知识库。自动更新默认关闭。

## 页面

（建库后，吸收提交或手动新建页面会出现在这里。）
`

const LOG_MD = `# Wiki 日志

`

export function projectIdOf(projectRoot: string): string {
  const n = path.resolve(projectRoot).replace(/\\/g, '/').toLowerCase()
  return createHash('sha1').update(n).digest('hex').slice(0, 16)
}

/** Wiki lives under \`<userData>/projects/<projectId>/wiki/\`. */
export function wikiRoot(projectRoot: string, userData: string): string {
  return path.join(userData, 'projects', projectIdOf(projectRoot), 'wiki')
}

async function readSettings(root: string): Promise<WikiSettings> {
  try {
    const raw = await fsp.readFile(path.join(root, 'wiki-settings.json'), 'utf8')
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

async function writeSettings(root: string, s: WikiSettings): Promise<void> {
  await fsp.writeFile(path.join(root, 'wiki-settings.json'), JSON.stringify(s, null, 2), 'utf8')
}

function titleOf(file: string, body: string): string {
  const m = /^#\s+(.+)$/m.exec(body)
  if (m) return m[1].trim()
  return path.basename(file, '.md')
}

async function parseIndex(root: string): Promise<WikiPageMeta[]> {
  const indexPath = path.join(root, 'index.md')
  if (!existsSync(indexPath)) return []
  const text = await fsp.readFile(indexPath, 'utf8')
  const pages: WikiPageMeta[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^\s*[-*]\s+\[([^\]]+)\]\(([^)]+)\)(?:\s*[—–\-：:]\s*(.+))?/.exec(line)
    if (!m) continue
    const rel = m[2].replace(/^\.\//, '')
    if (seen.has(rel)) continue
    seen.add(rel)
    pages.push({ path: rel, title: m[1].trim(), summary: m[3]?.trim() })
  }
  const pagesDir = path.join(root, 'pages')
  if (existsSync(pagesDir)) {
    const walk = async (dir: string, prefix: string) => {
      const ents = await fsp.readdir(dir, { withFileTypes: true })
      for (const e of ents) {
        if (e.name.startsWith('.')) continue
        const rel = prefix ? `${prefix}/${e.name}` : e.name
        if (e.isDirectory()) await walk(path.join(dir, e.name), rel)
        else if (e.name.endsWith('.md')) {
          const fullRel = `pages/${rel}`.replace(/\\/g, '/')
          if (seen.has(fullRel)) continue
          seen.add(fullRel)
          try {
            const body = await fsp.readFile(path.join(dir, e.name), 'utf8')
            pages.push({ path: fullRel, title: titleOf(e.name, body) })
          } catch { pages.push({ path: fullRel, title: path.basename(e.name, '.md') }) }
        }
      }
    }
    await walk(pagesDir, '')
  }
  for (const f of ['SCHEMA.md', 'index.md', 'log.md']) {
    if (existsSync(path.join(root, f)) && !seen.has(f)) {
      seen.add(f)
      pages.unshift({ path: f, title: f === 'SCHEMA.md' ? '规则（SCHEMA）' : f === 'index.md' ? '目录' : '日志' })
    }
  }
  return pages
}

export async function ensureWiki(projectRoot: string, userData: string): Promise<WikiStatus> {
  const root = wikiRoot(projectRoot, userData)
  await fsp.mkdir(path.join(root, 'pages'), { recursive: true })
  for (const [name, content] of [['SCHEMA.md', SCHEMA_MD], ['index.md', INDEX_MD], ['log.md', LOG_MD]] as const) {
    const p = path.join(root, name)
    if (!existsSync(p)) await fsp.writeFile(p, content, 'utf8')
  }
  if (!existsSync(path.join(root, 'wiki-settings.json'))) await writeSettings(root, DEFAULT_SETTINGS)
  return statusOf(projectRoot, userData)
}

export async function statusOf(projectRoot: string, userData: string, repoHint?: string): Promise<WikiStatus> {
  const id = projectIdOf(projectRoot)
  const root = wikiRoot(projectRoot, userData)
  const exists = existsSync(path.join(root, 'index.md'))
  const settings = exists ? await readSettings(root) : { ...DEFAULT_SETTINGS }
  const pages = exists ? await parseIndex(root) : []
  let legacyDir: string | undefined
  for (const cand of [repoHint ? path.join(repoHint, 'docs', 'llmwiki') : '', path.join(projectRoot, 'docs', 'llmwiki')]) {
    if (cand && existsSync(cand)) { legacyDir = cand; break }
  }
  return { projectId: id, root, exists, pages, settings, legacyDir }
}

export async function listWikiPages(projectRoot: string, userData: string): Promise<WikiPageMeta[]> {
  return (await statusOf(projectRoot, userData)).pages
}

export async function readWikiPage(projectRoot: string, userData: string, rel: string): Promise<{ path: string; content: string }> {
  const root = wikiRoot(projectRoot, userData)
  const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '')
  if (safe.includes('..')) throw new Error('非法路径')
  const full = path.join(root, safe)
  if (!full.startsWith(root)) throw new Error('非法路径')
  const content = await fsp.readFile(full, 'utf8')
  return { path: safe.replace(/\\/g, '/'), content }
}

async function appendLog(root: string, op: string, title: string, detail?: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  const block = `\n## [${day}] ${op} | ${title}\n\n${detail ? detail.trim() + '\n' : ''}`
  await fsp.appendFile(path.join(root, 'log.md'), block, 'utf8')
}

async function upsertIndexLine(root: string, rel: string, title: string, summary: string): Promise<void> {
  const indexPath = path.join(root, 'index.md')
  let text = await fsp.readFile(indexPath, 'utf8')
  const line = `- [${title}](${rel}) — ${summary}`
  const re = new RegExp(`^\\s*[-*]\\s+\\[[^\\]]+\\]\\(${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\).*$`, 'm')
  if (re.test(text)) text = text.replace(re, line)
  else {
    if (!/## 页面/.test(text)) text += '\n\n## 页面\n\n'
    if (/## 页面\n\n/.test(text)) text = text.replace(/(## 页面\n\n)/, `$1${line}\n`)
    else text += `\n${line}\n`
  }
  await fsp.writeFile(indexPath, text, 'utf8')
}

export interface IngestInput {
  projectRoot: string
  userData: string
  repo: string
  commits: { hash: string; short: string; subject: string; body?: string; files?: string[] }[]
  ai?: AISettings | null
}

export async function ingestWiki(input: IngestInput): Promise<{ page: string; usedAi: boolean; message: string }> {
  const { projectRoot, userData, repo, commits, ai } = input
  await ensureWiki(projectRoot, userData)
  const root = wikiRoot(projectRoot, userData)
  const repoName = path.basename(repo)
  const day = new Date().toISOString().slice(0, 10)
  const slug = `ingest-${day}-${commits[0]?.short ?? 'manual'}`
  const rel = `pages/${slug}.md`

  const ruleSummary = [
    `# 变更摘要 · ${repoName} · ${day}`,
    '',
    `仓库：\`${repo}\``,
    '',
    '## 最近提交',
    '',
    ...commits.map((c) => {
      const files = c.files?.length ? `（${c.files.slice(0, 8).join(', ')}${c.files.length > 8 ? '…' : ''}）` : ''
      return `- \`${c.short}\` ${c.subject}${files}`
    }),
    ''
  ].join('\n')

  let body = ruleSummary
  let usedAi = false
  const hasAi = !!(ai && ((ai.profiles?.length ?? 0) > 0 || ai.baseUrl))
  if (hasAi && ai) {
    try {
      const msgs: ChatMessage[] = [
        { role: 'system', content: '你是项目百科维护助手。根据提交列表写一页 Markdown 变更摘要：先 2～4 句概述，再按主题分点；标注涉及模块/目录；不要编造未出现的文件。只用简体中文。' },
        { role: 'user', content: `仓库 ${repoName}\n\n${commits.map((c) => `${c.short} ${c.subject}\n${(c.files ?? []).join('\n')}`).join('\n\n')}` }
      ]
      const text = await chat(ai, msgs, { action: 'chat' })
      if (text.trim()) {
        body = `# 变更摘要 · ${repoName} · ${day}\n\n> AI 生成，仅供参考；下方附规则化提交列表。\n\n${text.trim()}\n\n---\n\n${ruleSummary}`
        usedAi = true
      }
    } catch { /* keep rule summary */ }
  }

  await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fsp.writeFile(path.join(root, rel), body, 'utf8')
  const summary = `${commits.length} 个提交 · ${repoName}`
  await upsertIndexLine(root, rel, `变更摘要 ${day}`, summary)
  await appendLog(root, 'Ingest', `吸收 ${repoName} 最近 ${commits.length} 个提交`, usedAi ? '含 AI 摘要' : '规则化摘要（未配置或未使用 AI）')
  return {
    page: rel,
    usedAi,
    message: usedAi
      ? '已吸收并生成 AI 摘要'
      : hasAi
        ? '已吸收（规则化摘要；AI 调用未成功）'
        : '已吸收（规则化摘要）。可在「设置 → AI 服务商」配置后重新吸收以生成 AI 摘要。'
  }
}

async function copyTree(src: string, dest: string): Promise<number> {
  let n = 0
  const ents = await fsp.readdir(src, { withFileTypes: true })
  await fsp.mkdir(dest, { recursive: true })
  for (const e of ents) {
    const from = path.join(src, e.name)
    const to = path.join(dest, e.name)
    if (e.isDirectory()) n += await copyTree(from, to)
    else if (e.isFile()) {
      if (!existsSync(to)) { await fsp.copyFile(from, to); n++ }
      else if (!existsSync(to + '.legacy')) { await fsp.copyFile(from, to + '.legacy'); n++ }
    }
  }
  return n
}

export async function migrateLegacyWiki(projectRoot: string, userData: string, legacyDir: string): Promise<{ copied: number; message: string }> {
  if (!existsSync(legacyDir)) throw new Error('未找到旧版 docs/llmwiki 目录')
  await ensureWiki(projectRoot, userData)
  const root = wikiRoot(projectRoot, userData)
  const dest = path.join(root, 'pages', 'legacy-llmwiki')
  const copied = await copyTree(legacyDir, dest)
  await upsertIndexLine(root, 'pages/legacy-llmwiki', '旧版 llmwiki 迁移', `从 ${legacyDir} 复制（未删除原文件）`)
  await appendLog(root, 'Migrate', '从仓库内 llmwiki 迁移', `源：${legacyDir} · 复制 ${copied} 个文件 · 原文件保留`)
  return { copied, message: `已复制 ${copied} 个文件到项目 Wiki（原 docs/llmwiki 未删除）` }
}

export async function saveWikiSettings(projectRoot: string, userData: string, patch: Partial<WikiSettings>): Promise<WikiSettings> {
  await ensureWiki(projectRoot, userData)
  const root = wikiRoot(projectRoot, userData)
  const cur = await readSettings(root)
  const next = { ...cur, ...patch }
  await writeSettings(root, next)
  return next
}


/** 0.6.5：新建 / 编辑 Wiki 页（写 pages、更新 index、append log） */
export async function writeWikiPage(
  projectRoot: string,
  userData: string,
  opts: { rel?: string; title: string; content: string; summary?: string }
): Promise<{ path: string; root: string }> {
  await ensureWiki(projectRoot, userData)
  const root = wikiRoot(projectRoot, userData)
  let rel = opts.rel?.replace(/\\/g, '/')
  if (!rel) {
    const slug = (opts.title || 'page')
      .replace(/[^\w\u4e00-\u9fff\-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'page'
    rel = `pages/${slug}.md`
    let n = 0
    while (existsSync(path.join(root, rel))) {
      n++
      rel = `pages/${slug}-${n}.md`
    }
  }
  const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '')
  if (safe.includes('..')) throw new Error('非法路径')
  const full = path.join(root, safe)
  if (!full.startsWith(root)) throw new Error('非法路径')
  if (/^SCHEMA\.md$/i.test(safe.replace(/\\/g, '/'))) throw new Error('请勿直接覆写 SCHEMA.md')
  await fsp.mkdir(path.dirname(full), { recursive: true })
  let body = opts.content ?? ''
  if (!/^#\s+/m.test(body)) body = `# ${opts.title}\n\n${body}`
  await fsp.writeFile(full, body, 'utf8')
  const norm = safe.replace(/\\/g, '/')
  const title = titleOf(norm, body)
  const summary = (opts.summary ?? body.replace(/^#.*$/m, '').trim().replace(/\s+/g, ' ').slice(0, 100)) || '（无摘要）'
  if (norm.startsWith('pages/')) await upsertIndexLine(root, norm, title, summary)
  await appendLog(root, opts.rel ? 'Edit' : 'Create', title, `路径：${norm}`)
  return { path: norm, root }
}

/** 0.6.4：问百科 — 读 index + 相关页再答；无 AI 则全文搜索 */
export async function queryWiki(
  projectRoot: string,
  userData: string,
  question: string,
  ai?: AISettings | null
): Promise<{ answer: string; usedAi: boolean; hits: { path: string; title: string; snippet: string }[] }> {
  const root = wikiRoot(projectRoot, userData)
  if (!existsSync(root)) return { answer: '尚未建立项目 Wiki。请先在「架构与知识」页建库。', usedAi: false, hits: [] }
  const q = question.trim()
  if (!q) return { answer: '请输入问题。', usedAi: false, hits: [] }
  const pages = await listWikiPages(projectRoot, userData)
  let index = ''
  try { index = await fsp.readFile(path.join(root, 'index.md'), 'utf8') } catch { /* */ }
  const terms = q.toLowerCase().split(/[\s,，、？?]+/).filter((t) => t.length >= 2)
  const scored: { path: string; title: string; content: string; score: number }[] = []
  for (const p of pages) {
    let content = ''
    try {
      const r = await readWikiPage(projectRoot, userData, p.path)
      content = r.content
    } catch { continue }
    const hay = (p.title + '\n' + (p.summary || '') + '\n' + content).toLowerCase()
    let score = 0
    for (const t of terms) if (hay.includes(t)) score += 1
    if (score > 0) scored.push({ path: p.path, title: p.title, content, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, 5)
  const hits = top.map((t) => {
    const lines = t.content.split(/\r?\n/)
    const hitLine = lines.find((l) => terms.some((x) => l.toLowerCase().includes(x))) || lines.find((l) => l.trim()) || ''
    return { path: t.path, title: t.title, snippet: hitLine.trim().slice(0, 160) }
  })
  const hasAi = !!(ai && (ai.profiles?.length || ai.baseUrl))
  if (hasAi && top.length) {
    const ctx = [
      'index.md:\n' + index.slice(0, 3000),
      ...top.map((t) => `${t.path}:\n${t.content.slice(0, 2500)}`)
    ].join('\n\n---\n\n')
    try {
      const answer = await chat(ai!, [
        { role: 'system', content: '你是项目 Wiki 助手。只根据提供的 Wiki 摘录回答，用简体中文。若资料不足请明说，不要编造。回答末尾列出引用的页面路径。' },
        { role: 'user', content: `问题：${q}\n\nWiki 摘录：\n${ctx.slice(0, 12000)}` }
      ], { action: 'chat', temperature: 0.2, maxTokens: 2000, timeoutMs: 90000 })
      return { answer, usedAi: true, hits }
    } catch { /* fall through to search */ }
  }
  if (!hits.length) {
    return {
      answer: terms.length
        ? `未在 Wiki 中找到与「${q}」相关的页面。可先吸收提交或补充页面后再问。`
        : '请输入更具体的关键词。',
      usedAi: false,
      hits: []
    }
  }
  const lines = [
    `全文搜索结果（未使用 AI${hasAi ? '调用失败或未命中足够上下文' : '· 未配置 AI'}）：`,
    ...hits.map((h, i) => `${i + 1}. **${h.title}**（\`${h.path}\`）\n   ${h.snippet}`)
  ]
  return { answer: lines.join('\n'), usedAi: false, hits }
}
