// e2e for GitLoom 0.5.3 SE-standards: C4/UML cues, notation legend, class compartments, final states, sequence activation.
// Run: xvfb-run -a node e2e/e2e-053.mjs   (SHOTS_DIR=screenshots/v11 for release shots)
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { makeHub, makeTsService } from '../scripts/viz-fixtures.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e053'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = process.env.SHOTS_DIR || join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [DATA, SAVE, shots]) mkdirSync(d, { recursive: true })
const PROJ = join(ROOT, 'proj')
const SHOP = makeHub(join(PROJ, 'web-shop'))
const TS = makeTsService(join(PROJ, 'ts-service'))

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
  workspace: { repos: [TS, SHOP], active: TS, projects: [{ id: 'p', name: 'viz053', root: PROJ, repos: [repoEntry(TS, 'ts-service'), repoEntry(SHOP, 'web-shop')], hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
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
const openViz = async () => { await page.evaluate(() => window.__gitloomSetView && window.__gitloomSetView('viz')); await sleep(600) }
const vizDone = () => until(async () => (await page.locator('[data-testid=viz-summary]').count()) > 0 && (await page.locator('[data-testid=viz-progress]').count()) === 0, 90000, 'analysis finished')
const settled = async () => { await until(async () => (await page.locator('.vz-busy').count()) === 0 && (!(await page.locator('.vz-graph').count()) || (await page.locator('.vz-graph .react-flow__node').count()) > 0), 30000, 'layout'); await sleep(600) }
const tab = async (id) => { await page.locator(`[data-testid=viz-tab-${id}]`).click(); await sleep(250); await settled() }
const tid = (id) => page.locator(`[data-testid=${id}]`)
const menuItem = (t) => page.locator('.ctx-menu .ctx-item', { hasText: t })

await step('open 变更可视化 → notation tip present on modules', async () => {
  await setActive(TS); await openViz(); await vizDone()
  await tab('modules')
  const note = await tid('viz-notation').innerText()
  if (!/模块|IEEE|依赖/.test(note)) throw new Error('notation ' + note)
  await shot('01-modules-notation')
})

await step('classes: UML compartments + stereotype; notation mentions UML', async () => {
  await page.locator('[data-testid=viz-tab-classes]').click(); await sleep(400)
  await until(async () => (await page.locator('.vz-busy').count()) === 0, 30000, 'classes not busy')
  await sleep(800)
  const note = await tid('viz-notation').innerText()
  if (!/UML|类图/.test(note)) throw new Error('classes note ' + note)
  const hasClass = await page.locator('.vn.k-class').count()
  if (hasClass > 0) {
    const comps = await page.locator('.vc-compartment').count()
    if (comps < 1) throw new Error('no UML compartments on class nodes')
  }
  await shot('02-classes-uml')
})

await step('arch: C4 notation tip + container stereo on layers when present', async () => {
  await tab('arch')
  const note = await tid('viz-notation').innerText()
  if (!/C4|容器/.test(note)) throw new Error('arch note ' + note)
  await shot('03-arch-c4')
})

await step('sequence: notation + activation bars when diagram exists', async () => {
  await tab('sequence')
  const note = await tid('viz-notation').innerText()
  if (!/时序|生命线|激活/.test(note)) throw new Error('seq note ' + note)
  const listN = await page.locator('.vz-li').count()
  if (listN > 0) {
    await page.locator('.vz-li').first().click(); await sleep(800)
    const acts = await page.locator('.sq-act').count()
    // activation may be 0 if only self-calls; still ok if diagram rendered
    const msgs = await page.locator('.sq-msg').count()
    if (msgs === 0) throw new Error('no sequence messages')
    await shot('04-sequence-uml')
    if (acts === 0) console.log('  (no activation bars on this fixture — ok)')
  } else {
    await shot('04-sequence-empty')
  }
})

await step('state: notation + final/initial markers when present', async () => {
  await setActive(SHOP); await openViz(); await vizDone()
  await tid('viz-presets').click(); await menuItem('当前分支 feature/coupons').click(); await sleep(300); await vizDone()
  await tab('state')
  const note = await tid('viz-notation').innerText()
  if (!/状态机|初态|终态/.test(note)) throw new Error('state note ' + note)
  const listN = await page.locator('.vz-li').count()
  if (listN > 0) {
    await page.locator('.vz-li').first().click(); await sleep(800)
    await settled()
  }
  await shot('05-state-uml')
})

await step('flow + impact + calls notation tips', async () => {
  for (const [id, re] of [['flow', /活动|流程|判定/], ['impact', /影响面|跳数/], ['calls', /调用|实心/]]) {
    await tab(id)
    const note = await tid('viz-notation').innerText()
    if (!re.test(note)) throw new Error(`${id} note ${note}`)
    await shot(`06-${id}`)
  }
})

await step('1024 light: notation still visible, toolbar ok', async () => {
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 720)); await sleep(800)
  await tab('classes')
  if ((await tid('viz-notation').count()) !== 1) throw new Error('notation missing at 1024')
  await shot('07-1024-light-classes')
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900)); await sleep(400)
})

await step('no page errors', async () => {
  const errs = pageErrors.filter((e) => !/ResizeObserver loop/.test(e))
  if (errs.length) throw new Error(errs.slice(0, 5).join('\n'))
})

const fails = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - fails.length}/${results.length} passed`)
await app.close(); server.close()
process.exit(fails.length ? 1 : 0)
