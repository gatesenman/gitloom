// e2e 0.6.5: 架构与知识 — canvas only in graph pane; no 前/叠加/后; Wiki/KG smoke; stay on knowledge.
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { makeHub, makeTsService, makePy } from '../scripts/viz-fixtures.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e065'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = join(ROOT, 'shots')
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
page.setDefaultTimeout(20000)
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|DevTools|Autofill/.test(m.text())) pageErrors.push('console: ' + m.text().slice(0, 300)) })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeout = 20000, what = '') => { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last } catch (e) { last = e.message } await sleep(120) } throw new Error('timeout ' + (what || fn.toString().slice(0, 140)) + ' last=' + JSON.stringify(last)?.slice(0, 200)) }
const results = []
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); console.log('✔', name) }
  catch (e) { results.push(['FAIL', name]); console.log('✘', name, (e.message || String(e)).slice(0, 600)); await page.screenshot({ path: join(ROOT, `fail-${results.length}.png`) }).catch(() => {}) }
}
const tid = (id) => page.locator(`[data-testid=${id}]`)
const mod = (id) => page.locator(`.modbar [data-module=${id}]`)
const on = async (id) => until(async () => (await mod(id).getAttribute('aria-selected')) === 'true', 8000, `module ${id} active`)
await sleep(1500)

await step('open 架构与知识 hub', async () => {
  await mod('knowledge').click(); await on('knowledge')
  await tid('mod-hub-knowledge').waitFor()
  await tid('k-sec-tabs').waitFor()
})

await step('default tab is arch; no 前/叠加/后/播放 compare chrome', async () => {
  await tid('k-arch-graph').waitFor()
  if ((await tid('k-c4').count()) > 0) throw new Error('c4 should be hidden until tab switch')
  if ((await tid('wiki-panel').count()) > 0) throw new Error('wiki should be hidden until tab switch')
  // wait for analysis or empty; either way overlay compare controls must not appear
  await sleep(2000)
  for (const id of ['viz-ov-before', 'viz-ov-both', 'viz-ov-after', 'viz-ov-play']) {
    if ((await tid(id).count()) > 0) throw new Error('diff overlay control leaked: ' + id)
  }
  // tip only on graph pane when graph rendered
  const tip = tid('k-arch-canvas-tip')
  if ((await tip.count()) > 0) {
    const t = await tip.innerText()
    if (!t.includes('可拖动画布缩放')) throw new Error('tip text: ' + t)
  }
})

await step('canvas scoped: react-flow only inside k-arch-embed / k-graph-canvas', async () => {
  // page chrome (hub title / cards / tabs) must not be inside a react-flow viewport
  const hub = tid('mod-hub-knowledge')
  await hub.waitFor()
  const rfInHubChrome = await page.evaluate(() => {
    const hub = document.querySelector('[data-testid=mod-hub-knowledge]')
    if (!hub) return 'no hub'
    const title = hub.querySelector('.mod-hub-h, .mod-hub-title, h1, h2')
    const cards = hub.querySelector('[data-testid=k-arch]') || hub.querySelector('.mod-hub-card')
    const tabs = hub.querySelector('[data-testid=k-sec-tabs]')
    for (const el of [title, cards, tabs]) {
      if (!el) continue
      if (el.closest('.react-flow')) return 'chrome inside react-flow'
    }
    return 'ok'
  })
  if (rfInHubChrome !== 'ok') throw new Error(rfInHubChrome)
})

await step('switch cards/tabs: C4 + Wiki smoke', async () => {
  await tid('k-tab-c4').click()
  await tid('k-c4').waitFor()
  await tid('arch-view').waitFor({ timeout: 90000 }).catch(() => {})
  await on('knowledge')
  await tid('k-tab-wiki').click()
  await tid('wiki-panel').waitFor()
  const wikiBtns = await tid('wiki-panel').locator('button').count()
  if (wikiBtns < 1) throw new Error('wiki panel empty')
  // card button also switches section
  await tid('k-c4-card').locator('button').click()
  await tid('k-c4').waitFor()
  await on('knowledge')
})

await step('knowledge graph tab: no primary jump to 看懂改动', async () => {
  await tid('k-tab-graph').click()
  await tid('knowledge-graph').waitFor()
  if ((await tid('k-map').count()) > 0) throw new Error('k-map should not exist')
  await on('knowledge')
  // build button exists (may fail without parsers — just presence)
  await tid('graph-build').waitFor()
})

await step('note says 看懂改动 owns diffs; module stays knowledge', async () => {
  const note = await tid('k-codemap-note').innerText()
  if (!note.includes('看懂改动')) throw new Error(note)
  await on('knowledge')
})

const fails = results.filter((r) => r[0] === 'FAIL')
console.log('\n' + results.map((r) => r.join('\t')).join('\n'))
console.log(fails.length ? `\n${fails.length} FAIL` : `\n${results.length} ok`)
if (pageErrors.length) console.log('pageErrors', pageErrors.slice(0, 5))
await app.close().catch(() => {})
server.close()
process.exit(fails.length ? 1 : 0)
