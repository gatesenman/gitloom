// 0.6.2.1 hotfix: knowledge/quality/automation homes only → screenshots/v14/hotfix
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { makeHub, makeTsService, makePy } from '../scripts/viz-fixtures.mjs'
import { makeTaskDemo } from '../scripts/tasks-fixture.mjs'
const require = createRequire(import.meta.url)
const ROOT = '/tmp/gitloom-shots0621'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = process.env.OUT || 'screenshots/v14/hotfix'
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
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => page.locator(`[data-testid=${id}]`)
const mod = (id) => page.locator(`.modbar [data-module=${id}]`)
const shot = async (name) => { await page.mouse.move(700, 5); await sleep(400); await page.addStyleTag({ content: '.toast-wrap,.toasts,.toast{visibility:hidden!important}' }).then((h) => h.evaluate((el) => { el.id = 'shot-hide' })); await page.screenshot({ path: join(shots, `${name}.png`) }); await page.evaluate(() => document.getElementById('shot-hide')?.remove()) }
const theme = async (t) => { await page.evaluate((x) => { document.documentElement.dataset.theme = x }, t); await sleep(250) }
await sleep(2500)
const results = []
const step = async (name, fn) => { try { await fn(); results.push(['ok', name]); console.log('✔', name) } catch (e) { results.push(['FAIL', name]); console.log('✘', name, (e.message||'').slice(0,400)) } }
for (const th of ['light', 'dark']) {
  await step(th, async () => {
    await theme(th)
    await mod('knowledge').click(); await tid('mod-hub-knowledge').waitFor(); await sleep(400); await shot(`1440-${th}-knowledge-home`)
    // sample bg pixel of mod-hub to assert not pink
    const bg = await page.evaluate(() => {
      const el = document.querySelector('.mod-hub')
      const c = getComputedStyle(el).backgroundColor
      return c
    })
    console.log('  mod-hub bg', bg)
    if (/245,\s*220,\s*221|rgb\(245/.test(bg)) throw new Error('pink bg still: ' + bg)
    await mod('quality').click(); await tid('mod-hub-quality').waitFor(); await sleep(400); await shot(`1440-${th}-quality-home`)
    await mod('automation').click(); await tid('mod-hub-automation').waitFor(); await sleep(500); await shot(`1440-${th}-automation-home`)
  })
}
const fails = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - fails.length}/${results.length} passed`)
await app.close(); server.close()
process.exit(fails.length ? 1 : 0)
