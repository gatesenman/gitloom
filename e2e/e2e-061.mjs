// e2e for GitLoom 0.6.1: 看懂改动 summary, 当前架构 C4, 体检 column, AI 定时任务 (list/editor/templates 2+3/missed/connector).
// Run: xvfb-run -a node e2e/e2e-061.mjs   (SHOTS_DIR=screenshots/v13 for release shots)
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { makeHub, makeTsService, makePy } from '../scripts/viz-fixtures.mjs'
import { makeTaskDemo } from '../scripts/tasks-fixture.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e061'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = process.env.SHOTS_DIR || join(ROOT, 'shots')
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

await step('看懂改动: 全局摘要 → 影响模块 → 逐文件 (分支对比)', async () => {
  await mod('understand').click(); await tid('summary-view').waitFor()
  await tid('us-scope-refs').click()
  await until(async () => (await tid('us-headline').count()) > 0 && (await tid('us-mod').count()) > 0, 60000, 'summary built')
  if (!(await tid('ev-link').count())) throw new Error('no evidence links')
  if (!(await tid('us-file').count())) throw new Error('no files')
  await shot('01-summary')
})
await step('看懂改动: 风险提示 + 逐文件预览', async () => {
  await tid('us-file').first().click(); await sleep(800)
  await shot('02-summary-file')
})
await step('当前架构 C4: embedded in 架构与知识 (module stays knowledge)', async () => {
  await mod('knowledge').click(); await on('knowledge')
  await tid('k-tab-c4').click()
  await tid('k-c4').waitFor()
  await tid('arch-view').waitFor()
  await until(async () => (await tid('c4-container').count()) > 0, 60000, 'c4')
  await on('knowledge')
  await shot('03-c4-l2')
  await tid('c4-level-3').click(); await until(async () => (await tid('c4-comp').count()) > 0, 20000, 'l3')
  if (!(await page.locator('[data-testid=c4-l3] [data-testid=ev-link]').count()) && !(await tid('ev-link').count())) throw new Error('no evidence')
  await on('knowledge')
  await shot('04-c4-l3')
})
await step('工作区体检列', async () => {
  await mod('workspace').click(); await sleep(1500)
  await until(async () => (await tid('health').count()) >= 3, 30000, 'health cells')
  await shot('05-health')
})
await step('AI 定时任务: 空列表 + 模板入口', async () => {
  await mod('automation').click(); await on('automation')
  await tid('auto-tab-tasks').click()
  await tid('ai-tasks').waitFor(); await tid('tasks-empty').waitFor()
  await tid('ai-tasks').scrollIntoViewIfNeeded()
})
const pickScope = async (label) => { const v = await tid('te-scope').locator('option', { hasText: label }).first().getAttribute('value'); await tid('te-scope').selectOption(v) }
await step('新建任务 from 模板 2/3 + 空白任务 editor', async () => {
  await tid('tasks-new').click(); await tid('tasks-new-menu').waitFor(); await shot('06-tasks-new-menu')
  await tid('tasks-new-security').click(); await tid('task-editor').waitFor()
  await pickScope('demo-shop'); await tid('te-kind').selectOption('weekly')
  await shot('07-task-editor'); await tid('te-save').click(); await sleep(500)
  await tid('tasks-new').click(); await tid('tasks-new-branches').click(); await pickScope('demo-shop'); await tid('te-save').click(); await sleep(500)
  await tid('tasks-new').click(); await tid('tasks-new-issues').click(); await pickScope('demo-shop'); await tid('te-save').click(); await sleep(500)
  if ((await tid('task-row').count()) !== 3) throw new Error('rows')
})
const runRow = async (i) => { const r = tid('task-row').nth(i); await r.locator('[data-testid=task-run]').click(); await until(async () => /已完成|出错|未运行/.test(await r.locator('.tr-last').innerText()), 90000, 'run done') }
await step('模板 3 陈旧分支：结果', async () => {
  await runRow(1); const t = await tid('run-result').innerText()
  if (!/3 个分支超过 30 天没动，其中 2 个建议删除/.test(t) || !/spike\/payment-retry/.test(t)) throw new Error(t.slice(0, 300))
  await tid('run-history').scrollIntoViewIfNeeded(); await shot('09-run-branches')
})
await step('模板 2 安全扫描：结果带文件+行号', async () => {
  await runRow(0); const t = await tid('run-result').innerText()
  if (!/本次 \d+ 条，其中高危 \d+ 条/.test(t) || !/src\/db\/users\.js:3/.test(t)) throw new Error(t.slice(0, 300))
  if (/9f8e7d6c5b4a3928/.test(t)) throw new Error('secret leaked')
  await tid('run-history').scrollIntoViewIfNeeded(); await shot('08-run-security')
})
await step('模板 1 未接入平台 → 不运行', async () => {
  await runRow(2); const t = await tid('run-result').innerText()
  if (!/需先接入问题上报平台/.test(t)) throw new Error(t.slice(0, 200))
})
await step('任务列表', async () => { await tid('task-row').nth(0).click(); await tid('ai-tasks').scrollIntoViewIfNeeded(); await shot('10-task-list') })
await step('问题平台接入: token 不回显', async () => {
  await tid('tasks-connector').click(); await tid('cn-url').fill('https://issues.example.com/api/tickets'); await tid('cn-token').fill('tok-E2E-SECRET'); await tid('cn-save').click(); await sleep(500)
  await tid('tasks-connector').click(); if (await tid('cn-token').inputValue()) throw new Error('token echoed'); await page.keyboard.press('Escape'); await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } }).catch(() => {})
  const raw = require('fs').readFileSync(join(DATA, 'ai-tasks.json'), 'utf8'); if (raw.includes('tok-E2E-SECRET')) throw new Error('token on disk')
})
await step('git 钩子 + 运行记录仍在自动化页', async () => {
  await tid('auto-tab-hooks').click(); await tid('auto-hooks').waitFor(); await tid('a-log-hooks').waitFor()
})
await step('no page errors', async () => {
  const errs = pageErrors.filter((e) => !/ResizeObserver loop/.test(e))
  if (errs.length) throw new Error(errs.slice(0, 5).join('\n'))
})

const fails = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - fails.length}/${results.length} passed`)
await app.close(); server.close()
process.exit(fails.length ? 1 : 0)
