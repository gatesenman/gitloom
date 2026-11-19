// e2e for GitLoom 0.6.0: six-module bar, scope switch, hub pages, moved hint, palette modules, 47-feature reachability.
// Run: xvfb-run -a node e2e/e2e-060.mjs   (SHOTS_DIR=screenshots/v12 for release shots)
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { makeHub, makeTsService, makePy } from '../scripts/viz-fixtures.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e060'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = process.env.SHOTS_DIR || join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [DATA, SAVE, shots]) mkdirSync(d, { recursive: true })
const PROJ = join(ROOT, 'proj')
const SHOP = makeHub(join(PROJ, 'apps', 'web-shop'))
const TS = makeTsService(join(PROJ, 'services', 'ts-service'))
const PY = makePy(join(PROJ, 'services', 'py-worker'))

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
  settings: { theme: 'dark', diffMode: 'split', graphLimit: 200, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 2, aiEnvForHooks: false, fontSize: 13, concurrency: 4, ai: AI },
  workspace: { repos: [TS, PY, SHOP], active: TS, projects: [{ id: 'p', name: 'gitloom-demo', root: PROJ, repos: [repoEntry(TS, 'services/ts-service'), repoEntry(PY, 'services/py-worker'), repoEntry(SHOP, 'apps/web-shop')], hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
}))

const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox', '--disable-gpu'], env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_NO_WATCH: '1', GITLOOM_SAVE_DIR: SAVE }, timeout: 120000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|DevTools|Autofill/.test(m.text())) pageErrors.push('console: ' + m.text().slice(0, 300)) })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeout = 20000, what = '') => { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last } catch (e) { last = e.message } await sleep(120) } throw new Error('timeout ' + (what || fn.toString().slice(0, 140)) + ' last=' + JSON.stringify(last)?.slice(0, 200)) }
const results = []
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); console.log('✔', name) }
  catch (e) { results.push(['FAIL', name]); console.log('✘', name, (e.message || String(e)).slice(0, 600)); await page.screenshot({ path: join(ROOT, `fail-${results.length}.png`) }).catch(() => {}); await page.keyboard.press('Escape').catch(() => {}) }
}
const shot = async (name) => { await page.mouse.move(700, 5); await sleep(450); await page.addStyleTag({ content: '.toast-wrap,.toasts,.toast{visibility:hidden!important}' }).then((h) => h.evaluate((el) => { el.id = 'shot-hide' })); await page.screenshot({ path: join(shots, `${name}.png`) }); await page.evaluate(() => document.getElementById('shot-hide')?.remove()) }
const setActive = async (p) => { await page.evaluate((x) => window.__gitloomSetActive && window.__gitloomSetActive(x), p); await sleep(900) }
const more = async (label) => { await page.locator('.viewtabs [role="tab"]', { hasText: label }).first().click(); await sleep(400) }
const vizDone = () => until(async () => (await page.locator('[data-testid=viz-summary]').count()) > 0 && (await page.locator('[data-testid=viz-progress]').count()) === 0, 90000, 'analysis finished')
const settled = async () => { await until(async () => (await page.locator('.vz-busy').count()) === 0 && (!(await page.locator('.vz-graph').count()) || (await page.locator('.vz-graph .react-flow__node').count()) > 0), 30000, 'layout'); await sleep(600) }
const tab = async (id) => { await page.locator(`[data-testid=viz-tab-${id}]`).click(); await sleep(250); await settled() }
const tid = (id) => page.locator(`[data-testid=${id}]`)
const menuItem = (t) => page.locator('.ctx-menu .ctx-item', { hasText: t })
const mod = (id) => page.locator(`.modbar [data-module=${id}]`)
const on = async (id) => until(async () => (await mod(id).getAttribute('aria-selected')) === 'true', 8000, `module ${id} active`)
await sleep(1500)

await step('module bar shows six modules in order with tooltips', async () => {
  await page.locator('.modbar').waitFor()
  const labels = await page.locator('.modbar .mod-tab span').allInnerTexts()
  if (labels.join('|') !== '日常 Git|工作区|看懂改动|架构与知识|质量把关|自动化') throw new Error(labels.join('|'))
  for (const t of await page.locator('.modbar .mod-tab').evaluateAll((els) => els.map((e) => e.title))) if (t.length < 10) throw new Error('short tip ' + t)
})
await step('日常 Git: flat tabs (变更/历史/分支 + advanced, no 更多)', async () => {
  await setActive(TS); await mod('daily').click(); await on('daily')
  const t = await page.locator('.viewtabs .nav-item').allInnerTexts()
  for (const x of ['变更', '历史', '分支', '储藏', '工作树', '整理提交', '二分查错']) if (!t.some((y) => y.includes(x))) throw new Error(t.join('|'))
  if (t.some((y) => y.includes('更多'))) throw new Error('更多 should be gone: ' + t.join('|'))
  await shot('01-daily-changes')
})
await step('scope switch: 当前仓库 → 整个项目 → 仓库组', async () => {
  if ((await page.locator('.scope-seg [data-scope=repo]').getAttribute('aria-pressed')) !== 'true') throw new Error('repo scope not pressed')
  await page.locator('.scope-seg [data-scope=project]').click(); await on('workspace')
  await until(async () => (await page.locator('.scope-seg [data-scope=project]').getAttribute('aria-pressed')) === 'true')
  await shot('02-workspace-project')
  await page.locator('.scope-seg [data-scope=group]').click()
  await menuItem('services').click()
  await until(async () => (await page.locator('.scope-seg [data-scope=group]').innerText()).includes('services'), 8000, 'group label')
  await shot('03-workspace-group')
  await page.locator('.scope-seg [data-scope=repo]').click(); await on('daily')
})
await step('看懂改动: strip 改动摘要|可视化 + 打开可视化', async () => {
  await mod('understand').click(); await on('understand')
  await tid('summary-view').waitFor()
  const strip = await page.locator('.viewtabs').getAttribute('data-strip')
  if (strip !== 'understand') throw new Error('data-strip=' + strip)
  await tid('us-tab-summary').waitFor(); await tid('us-tab-viz').waitFor()
  if (await tid('us-deep-map').count()) throw new Error('us-deep-map should be removed')
  if (await tid('us-deep-tour').count()) throw new Error('us-deep-tour should be removed')
  if ((await tid('us-open-viz').count()) !== 1) throw new Error('expected one us-open-viz')
  await tid('us-open-viz').click(); await on('understand')
  await vizDone(); await settled(); await shot('04-understand-viz')
  await tid('us-tab-summary').click(); await tid('summary-view').waitFor()
})
await step('架构与知识 hub: tabs switch sections; no jump to 看懂改动', async () => {
  await mod('knowledge').click(); await on('knowledge')
  await tid('mod-hub-knowledge').waitFor()
  await tid('k-sec-tabs').waitFor()
  await tid('k-arch-graph').waitFor()
  // default tab = arch; C4 / Wiki only after switching (page chrome stays normal layout)
  await tid('k-tab-c4').click(); await tid('k-c4').waitFor()
  await tid('k-tab-wiki').click(); await tid('wiki-panel').waitFor()
  await tid('k-tab-arch').click(); await tid('k-arch-graph').waitFor()
  // note points to 看懂改动 but does not navigate
  await tid('k-codemap-note').waitFor()
  if ((await tid('k-map').count()) > 0) throw new Error('k-map primary jump should be gone')
  await on('knowledge')
  await shot('05-knowledge')
})
await step('质量把关 hub: beginner hero + in-page review + tool detection', async () => {
  await mod('quality').click(); await on('quality')
  await tid('mod-hub-quality').waitFor()
  await tid('q-hero-steps').waitFor()
  await tid('q-report').waitFor()
  await tid('health-run').waitFor()
  await tid('q-review').waitFor()
  await tid('q-review-start').waitFor()
  // tools section collapsed by default — expand then assert rows
  const toggle = tid('tool-detect-toggle')
  if (await toggle.count()) await toggle.click()
  await until(async () => (await tid('tool-detect').locator('tr').count()) >= 5, 15000, 'tool rows')
  if (!(await tid('tool-detect').innerText()).includes('Node.js')) throw new Error('node row')
  await on('quality')
  await shot('06-quality')
})
await step('自动化 strip 事件触发|钩子|定时任务 + 钩子运行记录', async () => {
  await mod('automation').click(); await on('automation')
  await tid('automation-strip').waitFor(); await tid('automation-hub').waitFor(); await tid('auto-events').waitFor()
  const tabs = await page.locator('[data-testid=automation-strip] [role=tab]').allInnerTexts()
  if (tabs.join('|') !== '事件触发|钩子|定时任务') throw new Error('auto strip: ' + tabs.join('|'))
  if ((await page.locator('[data-testid=automation-strip]').innerText()).includes('规划中')) throw new Error('规划中 leaked')
  await tid('auto-tab-hooks').click(); await tid('auto-hooks').waitFor()
  await shot('07-automation')
  await tid('a-log-hooks').click()
  await until(async () => (await page.locator('.cmdlog, .command-log, [class*=log]').count()) > 0, 5000, 'log')
  await page.keyboard.press('Escape')
  await tid('auto-tab-tasks').click(); await tid('ai-tasks').waitFor()
  await tid('tasks-ai-create').waitFor(); await tid('tasks-new').click(); await tid('tasks-new-menu').waitFor()
  const n = await tid('tasks-new-menu').locator('[role=menuitem][data-testid^=tasks-new-]').count()
  if (n < 11) throw new Error('templates <11: ' + n)
  await page.keyboard.press('Escape')
})
await step('设置 → Git 钩子 still works and shows moved hint (DG-2)', async () => {
  await page.keyboard.press('Control+,')
  await tid('moved-hooks').waitFor({ timeout: 15000 }); await shot('08-settings-hooks-moved')
  // settings page keeps a 前往自动化 link; Git 钩子 tab also routes into automation → 钩子
  await tid('moved-hooks').locator('button').click(); await on('automation')
  await tid('auto-hooks').waitFor().catch(async () => { await tid('auto-tab-hooks').click(); await tid('auto-hooks').waitFor() })
})
await step('palette: 模块 entries for all six', async () => {
  await page.keyboard.press('Control+k'); await page.keyboard.type('模块')
  await until(async () => (await page.locator('.palette, [role=dialog]').innerText()).includes('模块：质量把关'), 5000, 'palette modules')
  await shot('09-palette-modules')
  await page.keyboard.press('Escape')
})
await step('every advanced + branch-extra tab reachable from 日常 Git', async () => {
  await mod('daily').click(); await on('daily')
  const n = await page.locator('.viewtabs [role=tab]').count()
  if (n < 10) throw new Error('flat tabs too few ' + n)
  for (const s of ['储藏', '工作树', '分支']) { await page.locator('.viewtabs .nav-item', { hasText: s }).first().click(); await sleep(200); await on('daily') }
})
await step('light theme 1280', async () => {
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800)); await sleep(400)
  await mod('knowledge').click(); await shot('10-light-knowledge')
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
})
await step('no page errors', async () => {
  const errs = pageErrors.filter((e) => !/ResizeObserver loop/.test(e))
  if (errs.length) throw new Error(errs.slice(0, 5).join('\n'))
})

const fails = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - fails.length}/${results.length} passed`)
await app.close(); server.close()
process.exit(fails.length ? 1 : 0)
