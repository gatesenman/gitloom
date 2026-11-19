// e2e 0.6.9: 标签与发布 / 质量历史对比 / 审阅一页纸导出
// Run: npm run build && xvfb-run -a node e2e/e2e-069-paths.mjs
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { createHash } from 'crypto'
import { makeHub, makeTsService, makePy } from '../scripts/viz-fixtures.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e069'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [DATA, SAVE, shots, join(DATA, 'profile')]) mkdirSync(d, { recursive: true })

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd, ...a) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'advice.detachedHead=false', ...a], { cwd, encoding: 'utf8', env: gitEnv }).trim()

const PROJ = join(ROOT, 'proj')
const SHOP = makeHub(join(PROJ, 'apps', 'web-shop'))
const TS = makeTsService(join(PROJ, 'services', 'ts-service'))
const PY = makePy(join(PROJ, 'services', 'py-worker'))
writeFileSync(join(SHOP, 'wip-e2e.ts'), 'export const wip = true\n')
git(SHOP, 'tag', '-a', 'v0.1.0', '-m', 'first')
git(SHOP, 'tag', 'v0.1.0-lite')

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-pro' }] })); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
    res.write('data: [DONE]\n\n'); res.end()
  })
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const base = `http://127.0.0.1:${server.address().port}/v1`
const AI = { baseUrl: base, apiKey: 'sk-good', model: 'mock-pro', temperature: 0.2, language: 'zh', commitStyle: 'conventional', profiles: [{ id: 'p-mock', name: 'Mock', preset: 'custom', protocol: 'openai', baseUrl: base, apiKey: 'sk-good', model: 'mock-pro' }], activeProfile: 'p-mock', tasks: {}, fallback: [] }
const repoEntry = (p, rel) => ({ path: p, rel, kind: 'normal', initialized: true })
writeFileSync(join(DATA, 'gitloom.json'), JSON.stringify({
  settings: { theme: 'dark', diffMode: 'split', graphLimit: 200, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 3, aiEnvForHooks: false, fontSize: 13, concurrency: 4, ai: AI },
  workspace: {
    repos: [TS, PY, SHOP],
    active: SHOP,
    projects: [{
      id: 'p', name: 'gitloom-demo', root: PROJ,
      repos: [repoEntry(TS, 'services/ts-service'), repoEntry(PY, 'services/py-worker'), repoEntry(SHOP, 'apps/web-shop')],
      hidden: []
    }],
    activeProject: 'p', pinned: [], recent: []
  }
}))

// Seed health snapshots for compare (比上次 / 比上周)
const repoId = createHash('sha1').update(SHOP.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16)
const healthDir = join(DATA, 'profile', 'health-reports', repoId)
mkdirSync(healthDir, { recursive: true })
const DAY = 86_400_000
const now = Date.now()
const mkReport = (id, createdAt, findings) => {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  const byCategory = {}
  for (const f of findings) { bySeverity[f.severity]++; byCategory[f.category] = (byCategory[f.category] || 0) + 1 }
  return {
    id, createdAt, scope: 'working', repo: SHOP, checksRun: ['secret', 'static'],
    findings, summary: { total: findings.length, open: findings.filter(f => f.status === 'open').length, bySeverity, byCategory },
    durationMs: 12
  }
}
const oldF = [{ id: 'o1', severity: 'high', category: 'static', title: '旧坏味道', evidence: { path: 'a.ts', line: 1 }, source: 'builtin', confidence: 'medium', status: 'open' }]
const newF = [
  { id: 'o1', severity: 'high', category: 'static', title: '旧坏味道', evidence: { path: 'a.ts', line: 1 }, source: 'builtin', confidence: 'medium', status: 'open' },
  { id: 'n1', severity: 'low', category: 'hygiene', title: '新提示', evidence: { path: 'b.ts' }, source: 'builtin', confidence: 'low', status: 'open' }
]
const rOld = mkReport('r-old', now - 8 * DAY, oldF)
const rPrev = mkReport('r-prev', now - 3600_000, oldF)
const rLatest = mkReport('r-latest', now - 60_000, newF)
for (const r of [rOld, rPrev, rLatest]) writeFileSync(join(healthDir, r.id + '.json'), JSON.stringify(r))

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', '--no-sandbox', '--disable-gpu'],
  env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_NO_WATCH: '1', GITLOOM_SAVE_DIR: SAVE },
  timeout: 120000
})
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|DevTools|Autofill|ResizeObserver/.test(m.text())) pageErrors.push('console: ' + m.text().slice(0, 300)) })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeout = 25000, what = '') => {
  const end = Date.now() + timeout; let last
  while (Date.now() < end) { try { last = await fn(); if (last) return last } catch (e) { last = e.message }; await sleep(120) }
  throw new Error('timeout ' + (what || fn.toString().slice(0, 140)) + ' last=' + JSON.stringify(last)?.slice(0, 200))
}
const results = []
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); console.log('✔', name) }
  catch (e) { results.push(['FAIL', name]); console.log('✘', name, (e.message || String(e)).slice(0, 700)); await page.screenshot({ path: join(shots, `fail-${results.length}.png`) }).catch(() => {}); await page.keyboard.press('Escape').catch(() => {}) }
}
const tid = (id) => page.locator(`[data-testid=${id}]`)
const mod = (id) => page.locator(`.modbar [data-module=${id}]`)
const on = async (id) => until(async () => (await mod(id).getAttribute('aria-selected')) === 'true', 8000, `module ${id}`)
const setActive = async (p) => { await page.evaluate((x) => window.__gitloomSetActive && window.__gitloomSetActive(x), p); await sleep(900) }

await sleep(2000)
await setActive(SHOP)

await step('日常 Git: 二级「标签与发布」可进', async () => {
  await mod('daily').click(); await on('daily')
  await until(async () => (await page.locator('.viewtabs [data-view=tags], .nav-item[data-view=tags]').count()) > 0, 10000, 'tags tab')
  await page.locator('.viewtabs [data-view=tags], .nav-item[data-view=tags]').first().click()
  await until(async () => (await tid('tags-release-view').count()) > 0, 10000, 'tags view')
  const txt = await tid('tags-release-view').innerText()
  if (!txt.includes('标签与发布')) throw new Error(txt.slice(0, 200))
  await until(async () => (await tid('tags-row').count()) >= 1, 10000, 'local tags listed')
})

await step('标签与发布: 生成发布说明草稿', async () => {
  await tid('tags-draft-notes').click()
  await until(async () => (await tid('tags-notes').count()) > 0, 10000, 'notes')
  const notes = await tid('tags-notes-text').inputValue()
  if (!/发布说明/.test(notes)) throw new Error(notes.slice(0, 200))
})

await step('分支页标签页签仍在且链到标签与发布', async () => {
  await page.locator('.viewtabs [data-view=branches], .nav-item[data-view=branches]').first().click()
  await sleep(600)
  await page.locator('.seg button', { hasText: '标签' }).click()
  await until(async () => (await tid('branches-tags-hub').count()) > 0, 8000, 'hub hint')
  await tid('branches-tags-hub').locator('button.link').click()
  await until(async () => (await tid('tags-release-view').count()) > 0, 8000, 'back to tags')
})

await step('质量把关: 历史对比 比上次/比上周', async () => {
  await mod('quality').click(); await on('quality')
  await until(async () => (await tid('health-score').count()) > 0, 15000, 'score')
  await until(async () => (await tid('health-compare').count()) > 0, 15000, 'compare')
  const prev = await tid('health-compare-prev').innerText()
  if (!/比上次/.test(prev)) throw new Error(prev)
  const week = await tid('health-compare-week').innerText()
  if (!/比上周/.test(week)) throw new Error(week)
})

await step('看懂改动: 导出审阅一页纸按钮', async () => {
  await mod('understand').click(); await on('understand')
  await until(async () => (await tid('summary-view').count()) > 0, 10000, 'summary')
  await until(async () => (await tid('us-export-brief').count()) > 0, 10000, 'export btn')
  // wait analysis
  await until(async () => {
    const disabled = await tid('us-export-brief').isDisabled()
    return !disabled || (await tid('us-headline').count()) > 0
  }, 60000, 'summary ready')
  if (await tid('us-export-brief').isDisabled()) {
    // empty working tree edge: switch to latest commit
    await tid('us-scope-commit').click()
    await until(async () => !(await tid('us-export-brief').isDisabled()), 60000, 'commit summary')
  }
  await tid('us-copy-brief').click()
  await sleep(400)
})

const failed = results.filter((r) => r[0] === 'FAIL')
console.log('\n=== e2e-069 summary ===')
for (const [st, name] of results) console.log(st, name)
if (pageErrors.length) console.log('pageErrors', pageErrors.slice(0, 8))
await app.close()
server.close()
if (failed.length) process.exit(1)
console.log('ALL PASS')
