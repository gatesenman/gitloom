// 0.6.2 UI polish screenshot matrix: 1440/1024 × dark/light over every 0.6.x surface. OUT=screenshots/v14/before|after
// Run: xvfb-run -a node e2e/e2e-061.mjs   (SHOTS_DIR=screenshots/v13 for release shots)
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { makeHub, makeTsService, makePy } from '../scripts/viz-fixtures.mjs'
import { makeTaskDemo } from '../scripts/tasks-fixture.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-shots062'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = process.env.OUT || join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [DATA, SAVE, shots]) mkdirSync(d, { recursive: true })
const PROJ = join(ROOT, 'proj')
const SHOP = makeHub(join(PROJ, 'apps', 'web-shop'))
const TS = makeTsService(join(PROJ, 'services', 'ts-service'))
const PY = makePy(join(PROJ, 'services', 'py-worker'))
const DEMO = makeTaskDemo(join(PROJ, 'apps', 'demo-shop'))

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-pro' }] })); return }
    if (!/"stream":\s*true/.test(body)) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); return }
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
  workspace: { repos: [TS, PY, SHOP, DEMO], active: SHOP, projects: [{ id: 'p', name: 'gitloom-demo', root: PROJ, repos: [repoEntry(TS, 'services/ts-service'), repoEntry(PY, 'services/py-worker'), repoEntry(SHOP, 'apps/web-shop'), repoEntry(DEMO, 'apps/demo-shop')], hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
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
await sleep(2500)
const theme = async (t) => { await page.evaluate((x) => { document.documentElement.dataset.theme = x }, t); await sleep(250) }
const size = async (w, h) => { await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]); await sleep(500) }
const pickScope = async (label) => { const v = await tid('te-scope').locator('option', { hasText: label }).first().getAttribute('value'); await tid('te-scope').selectOption(v) }
const close = async () => { await page.keyboard.press('Escape'); await sleep(200); if (await page.locator('.modal-backdrop').count()) await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } }); await sleep(200) }
await step('seed tasks', async () => {
  await mod('automation').click(); await tid('ai-tasks').waitFor()
  await tid('ai-tasks').scrollIntoViewIfNeeded(); await shot('t0-tasks-empty')
  for (const id of ['security', 'branches', 'issues']) { await tid('tasks-new').click(); await tid(`tasks-new-${id}`).click(); await pickScope('demo-shop'); await tid('te-save').click(); await sleep(400) }
  for (const i of [0, 1]) { const r = tid('task-row').nth(i); await r.locator('[data-testid=task-run]').click(); await until(async () => /已完成|出错|未运行/.test(await r.locator('[data-testid=task-last]').first().innerText()), 90000, 'run') }
})
for (const [w, h] of [[1440, 900], [1024, 720]]) for (const th of ['dark', 'light']) {
  const k = `${w}-${th}`
  await step(`matrix ${k}`, async () => {
    await size(w, h); await theme(th)
    await mod('understand').click(); await tid('summary-view').waitFor(); await tid('us-scope-refs').click()
    await until(async () => (await tid('us-mod').count()) > 0, 60000, 'summary'); await shot(`${k}-01-summary`)
    await tid('us-files').scrollIntoViewIfNeeded(); await shot(`${k}-02-summary-files`)
    await mod('knowledge').click(); await sleep(400); await shot(`${k}-03-knowledge-home`)
    await tid('k-tab-c4').click(); await tid('k-c4').waitFor(); await tid('arch-view').waitFor(); await until(async () => (await tid('c4-container').count()) > 0, 60000, 'c4'); await shot(`${k}-04-c4-l2`)
    await tid('c4-level-3').click(); await sleep(600); await shot(`${k}-05-c4-l3`)
    await mod('quality').click(); await sleep(500); await shot(`${k}-06-quality-home`)
    await mod('workspace').click(); await sleep(1200); await shot(`${k}-07-workspace-health`)
    await mod('automation').click(); await tid('ai-tasks').scrollIntoViewIfNeeded(); await sleep(300)
    await tid('task-row').nth(0).click(); await sleep(400); await tid('ai-tasks').scrollIntoViewIfNeeded(); await shot(`${k}-08-tasks-security`)
    await tid('task-row').nth(1).click(); await sleep(400); await tid('ai-tasks').scrollIntoViewIfNeeded(); await shot(`${k}-09-tasks-branches`)
    await tid('task-edit').nth(0).click(); await tid('task-editor').waitFor(); await shot(`${k}-10-editor`); await close()
    await tid('tasks-new').click(); await sleep(250); await shot(`${k}-11-new-menu`); await tid('tasks-new').click(); await sleep(200)
  })
}
const fails = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - fails.length}/${results.length} passed`)
await app.close(); server.close()
process.exit(fails.length ? 1 : 0)
