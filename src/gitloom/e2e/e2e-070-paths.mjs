// e2e 0.6.x: 设计审查 / 改动聚类 / .gitignore 可视化
// Run: npm run build && xvfb-run -a node e2e/e2e-070-paths.mjs
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { makeHub, makeTsService, makePy } from '../scripts/viz-fixtures.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e070'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [DATA, SAVE, shots, join(DATA, 'profile')]) mkdirSync(d, { recursive: true })

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd, ...a) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'advice.detachedHead=false', ...a], { cwd, encoding: 'utf8', env: gitEnv }).trim()

const PROJ = join(ROOT, 'proj')
const SHOP = makeHub(join(PROJ, 'apps', 'web-shop'))
const TS = makeTsService(join(PROJ, 'services', 'ts-service'))
const PY = makePy(join(PROJ, 'services', 'py-worker'))

// front-ish debt + ignore rules for shop
mkdirSync(join(SHOP, 'src', 'ui'), { recursive: true })
writeFileSync(join(SHOP, 'src', 'debt.css'), '.x { color: #7b74ff; background: #112233; padding: 24px; }\n')
writeFileSync(join(SHOP, 'wip-a.ts'), 'export const a = 1\n')
writeFileSync(join(SHOP, 'src', 'ui', 'wip-b.tsx'), 'export const B = () => <div style={{ color: "red", padding: "24px" }}>x</div>\n')
if (!existsSync(join(SHOP, '.gitignore'))) writeFileSync(join(SHOP, '.gitignore'), 'dist/\n*.log\n')
else {
  const prev = require('fs').readFileSync(join(SHOP, '.gitignore'), 'utf8')
  if (!prev.includes('dist/')) writeFileSync(join(SHOP, '.gitignore'), prev + '\ndist/\n')
}
mkdirSync(join(SHOP, 'dist'), { recursive: true })
writeFileSync(join(SHOP, 'dist', 'out.js'), '1\n')
writeFileSync(join(SHOP, 'DESIGN.md'), '# Design\n\n## Tokens\n- --accent: #7b74ff\n')

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-pro' }] })); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '## 总结\\nDESIGN.md 基本可用。\\n## 问题\\n🟢 可补充间距令牌。' } }] })}\n\n`)
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

await step('质量把关: 设计审查入口 + 扫描设计债', async () => {
  await mod('quality').click(); await on('quality')
  await tid('mod-hub-quality').waitFor()
  await tid('q-design').waitFor()
  const lead = await tid('q-design-lead').innerText()
  if (!/硬编码|DESIGN/.test(lead)) throw new Error(lead.slice(0, 200))
  await tid('q-design-scan').click()
  await until(async () => (await tid('q-design-result').count()) > 0, 120000, 'design result')
  const summary = await tid('q-design-summary').innerText()
  if (!/设计发现/.test(summary)) throw new Error(summary)
  // findings or clean both ok; with debt.css expect at least one finding usually
  const n = await tid('q-design-finding').count()
  const clean = await tid('q-design-clean').count()
  if (n + clean < 1) throw new Error('no finding list or clean state')
  await tid('q-design-ai').waitFor()
})

await step('看懂改动: 改动聚类芯片可筛选', async () => {
  await mod('understand').click(); await on('understand')
  await tid('summary-view').waitFor()
  await tid('us-scope-working').click()
  await until(async () => (await tid('us-headline').count()) > 0 || (await tid('us-files').count()) > 0, 90000, 'summary analyzed')
  if (await tid('us-files').count() === 0) {
    // empty? force commit scope with files
    await tid('us-scope-commit').click()
    await until(async () => (await tid('us-files').count()) > 0, 90000, 'commit files')
  }
  await until(async () => (await tid('us-clusters').count()) > 0, 30000, 'clusters')
  await until(async () => (await tid('us-cluster').count()) > 0, 30000, 'cluster chips')
  const before = await tid('us-file').count()
  await tid('us-cluster').first().click()
  await sleep(400)
  const after = await tid('us-file').count()
  if (after > before) throw new Error(`filter widened ${before} -> ${after}`)
  if (after < 1) throw new Error('filtered to empty unexpectedly')
  if (await tid('us-cluster-clear').count()) await tid('us-cluster-clear').click()
})

await step('日常 Git: 文件追溯 · 忽略规则', async () => {
  await mod('daily').click(); await on('daily')
  await until(async () => (await page.locator('.viewtabs [data-view=tools], .nav-item[data-view=tools]').count()) > 0, 10000, 'tools tab')
  await page.locator('.viewtabs [data-view=tools], .nav-item[data-view=tools]').first().click()
  await until(async () => (await tid('tools-tab-blame').count()) > 0, 10000, 'tools tabs')
  await tid('tools-tab-ignore').click()
  await tid('ignore-panel').waitFor()
  await until(async () => (await tid('ignore-editor').inputValue()).length >= 0, 10000, 'editor')
  await tid('ignore-source').waitFor()
  await tid('ignore-probe').fill('dist/out.js')
  await tid('ignore-check').click()
  await until(async () => (await tid('ignore-explain').count()) > 0, 15000, 'explain')
  const ex = await tid('ignore-explain').innerText()
  if (!/忽略/.test(ex)) throw new Error(ex.slice(0, 200))
  // blame tab still present
  await tid('tools-tab-blame').click()
  await sleep(300)
  if ((await tid('tools-tab-blame').getAttribute('aria-selected')) !== 'true') throw new Error('blame lost')
})

const failed = results.filter((r) => r[0] === 'FAIL')
console.log('\n=== e2e-070 summary ===')
for (const [st, name] of results) console.log(st, name)
if (pageErrors.length) console.log('pageErrors', pageErrors.slice(0, 8))
await app.close()
server.close()
if (failed.length) process.exit(1)
console.log('ALL PASS')
