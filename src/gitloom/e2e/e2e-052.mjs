// e2e for GitLoom 0.5.2 可视化深度优化: routed (orthogonal / bundled) edges, change-centric clustering with click-to-expand,
// readable initial view + 改动 i/N navigator, keyboard navigation, semantic zoom, synced hover across panes, path between two
// nodes, overlay 前/后/播放, minimap toggle, whole-diagram PNG/SVG export (+ 当前画面), per-view summary, label tidying,
// 1024px light toolbar on one row. Run: xvfb-run -a node e2e/e2e-052.mjs   (SHOTS_DIR=screenshots/v10 for release shots)
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { makeHub, makeBig, makeTsService } from '../scripts/viz-fixtures.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e052'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = process.env.SHOTS_DIR || join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [DATA, SAVE, shots]) mkdirSync(d, { recursive: true })
const PROJ = join(ROOT, 'proj')
const SHOP = makeHub(join(PROJ, 'web-shop'))
const TS = makeTsService(join(PROJ, 'ts-service'))
const BIG = makeBig(join(PROJ, 'big-mono'), 1500, 60)
// ---- mock AI (OpenAI-compatible, streaming): answers 「AI 解读本图」 with names taken from the prompt (+ one invented name)
const reqs = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-pro' }] })); return }
    const all = (JSON.parse(body || '{}').messages ?? []).map((m) => m.content).join('\n')
    reqs.push(all)
    const names = [...new Set([...all.matchAll(/「([^」]+)」/g)].map((m) => m[1]))]
    const answer = all.includes('解读这张图') ? `- 新增了「${names[0]}」，并让它调用「${names[1] ?? names[0]}」。\n- 「不存在的函数」只是噪声。\n建议先看：「${names[0]}」` : '好的'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunks = answer.match(/[\s\S]{1,20}/g) ?? ['']
    let i = 0
    const tick = () => { if (res.destroyed) return; if (i < chunks.length) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`); setTimeout(tick, 5) } else { res.write('data: [DONE]\n\n'); res.end() } }
    tick()
  })
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const base = `http://127.0.0.1:${server.address().port}/v1`
const AI = { baseUrl: base, apiKey: 'sk-good', model: 'mock-pro', temperature: 0.2, language: 'zh', commitStyle: 'conventional', profiles: [{ id: 'p-mock', name: 'Mock', preset: 'custom', protocol: 'openai', baseUrl: base, apiKey: 'sk-good', model: 'mock-pro' }], activeProfile: 'p-mock', tasks: {}, fallback: [] }
const repoEntry = (p, rel) => ({ path: p, rel, kind: 'normal', initialized: true })
writeFileSync(join(DATA, 'gitloom.json'), JSON.stringify({
  settings: { theme: 'dark', diffMode: 'split', graphLimit: 200, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 2, aiEnvForHooks: false, fontSize: 13, concurrency: 4, ai: AI },
  workspace: { repos: [TS, SHOP, BIG], active: TS, projects: [{ id: 'p', name: 'viz052', root: PROJ, repos: [repoEntry(TS, 'ts-service'), repoEntry(SHOP, 'web-shop'), repoEntry(BIG, 'big-mono')], hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
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
const toastHas = (t) => until(async () => (await page.locator('.toast').allInnerTexts()).some((x) => x.includes(t)), 20000, `toast ${t}`)
const menuItem = (t) => page.locator('.ctx-menu .ctx-item', { hasText: t })
const zoomPct = async () => Number((await page.locator('.vz-zoom-pct').innerText()).replace('%', ''))
const mode = async (m) => { await tid(`viz-mode-${m}`).click(); await sleep(300); await settled() }
/** visible changed nodes in the after / overlay pane */
const changedInView = () => page.evaluate(() => {
  const pane = document.querySelector('.pane-after, .pane-both'); const pr = pane.getBoundingClientRect()
  return [...pane.querySelectorAll('.vn:not(.st-unchanged)')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.left >= pr.left - 2 && b.right <= pr.right + 2 && b.top >= pr.top - 2 && b.bottom <= pr.bottom + 2 }).length
})
const pngSize = (f) => { const b = readFileSync(f); if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png'); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } }

await step('open 变更可视化 on ts-service (HEAD) → 调用图 has routed edges and a per-view summary', async () => {
  await sleep(2500)
  await openViz()
  await page.locator('.view-intro button', { hasText: '知道了' }).click({ timeout: 4000 }).catch(() => {})
  await vizDone()
  // the fixture has an uncommitted file → the app starts on 工作区; compare the last commit instead
  await tid('viz-scope-commit').click(); await tid('viz-sha').fill('HEAD'); await tid('viz-run').click(); await sleep(300); await vizDone()
  await mode('side'); await tab('calls')
  const sum = await tid('viz-view-summary').innerText()
  if (!/新增 \d+ 个函数/.test(sum) || !/修改 \d+ 个/.test(sum)) throw new Error('summary: ' + sum)
  if (!(await tid('viz-view-summary').getAttribute('title')).startsWith('这张图里')) throw new Error('summary tooltip')
  // ELK orthogonal routes: every segment is horizontal / vertical (rounded corners are quadratic arcs)
  const d = await page.locator('.pane-after path.react-flow__edge-path').evaluateAll((ps) => ps.map((p) => p.getAttribute('d')))
  if (d.length < 5) throw new Error('edges ' + d.length)
  // all coordinate pairs in order (M, L end points, Q control = the corner) form the orthogonal polyline
  const ortho = d.filter((x) => { const P = [...x.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]); return P.length >= 2 && P.every((q, i) => !i || Math.abs(q[0] - P[i - 1][0]) < 0.6 || Math.abs(q[1] - P[i - 1][1]) < 0.6) })
  if (ortho.length < d.length * 0.9) throw new Error(`routed ${ortho.length}/${d.length}: ${d.find((x) => !ortho.includes(x))}`)
  if (d.some((x) => / C/.test(x))) throw new Error('bezier fallback used on calls: ' + d.find((x) => / C/.test(x)))
})

await step('labels: no sub line repeating its file group; file:line becomes 第 N 行', async () => {
  const subs = await page.locator('.pane-after .vn-sub').allInnerTexts()
  if (subs.some((s) => /\.tsx?:\d+$/.test(s))) throw new Error('raw file:line left: ' + subs.join('|'))
  if (!subs.some((s) => /^第 \d+ 行$/.test(s))) throw new Error('no 第 N 行: ' + subs.join('|'))
  const trunc = await page.locator('.pane-after .vn-label').evaluateAll((es) => es.filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent))
  if (trunc.length > 1) throw new Error('truncated labels: ' + trunc.join(', '))
})

await step('initial view is readable and shows changes; F = whole picture, C = changes', async () => {
  const z = await zoomPct()
  if (z < 50) throw new Error('initial zoom ' + z)
  if ((await changedInView()) < 3) throw new Error('changes in view ' + (await changedInView()))
  await tid('viz-graph').focus()
  await page.keyboard.press('f'); await sleep(300)
  const zf = await zoomPct()
  if (!(await tid('viz-fit').getAttribute('class')).includes('on')) throw new Error('fit not marked on')
  const all = await page.evaluate(() => { const pane = document.querySelector('.pane-after'); const pr = pane.getBoundingClientRect(); const ns = [...pane.querySelectorAll('.react-flow__node')].filter((n) => n.getBoundingClientRect().width > 0); return ns.every((n) => { const b = n.getBoundingClientRect(); return b.left >= pr.left - 2 && b.right <= pr.right + 2 }) })
  if (!all) throw new Error('F did not fit everything; zoom ' + zf)
  await shot('01-calls-fit-all')
  await page.keyboard.press('c'); await sleep(300)
  if ((await zoomPct()) < 50) throw new Error('C zoom ' + (await zoomPct()))
  await shot('02-calls-frame-changes')
})

await step('改动 i/N navigator: next / prev buttons and N / [ ] keys, Enter opens the side panel', async () => {
  const txt0 = await tid('viz-changes').innerText()
  const N = Number(/(\d+) 处/.exec(txt0)?.[1] ?? /\/(\d+)/.exec(txt0)?.[1])
  if (!(N > 3)) throw new Error('nav text ' + txt0)
  await tid('viz-next').click(); await sleep(300)
  if (!(await tid('viz-changes').innerText()).includes(`改动 1/${N}`)) throw new Error('after next: ' + (await tid('viz-changes').innerText()))
  await tid('viz-graph').focus()
  await page.keyboard.press('n'); await sleep(300)
  if (!(await tid('viz-changes').innerText()).includes(`改动 2/${N}`)) throw new Error('after n')
  await page.keyboard.press('['); await sleep(300)
  if (!(await tid('viz-changes').innerText()).includes(`改动 1/${N}`)) throw new Error('after [')
  await tid('viz-prev').click(); await sleep(300)
  if (!(await tid('viz-changes').innerText()).includes(`改动 ${N}/${N}`)) throw new Error('prev wraps')
  // the target is highlighted and centred in the pane
  const c = await page.evaluate(() => { const pane = document.querySelector('.pane-after'); const pr = pane.getBoundingClientRect(); const n = pane.querySelector('.vn.nav'); if (!n) return null; const b = n.getBoundingClientRect(); return { dx: Math.abs((b.left + b.right) / 2 - (pr.left + pr.right) / 2), dy: Math.abs((b.top + b.bottom) / 2 - (pr.top + pr.bottom) / 2) } })
  if (!c || c.dx > 40 || c.dy > 60) throw new Error('nav target not centred: ' + JSON.stringify(c))
  await shot('03-calls-navigator')
  await tid('viz-graph').focus(); await page.keyboard.press('Enter')
  await until(() => tid('viz-panel').count(), 5000, 'panel')
  await page.keyboard.press('Escape'); await sleep(200)
})

await step('synced hover: hovering a node in 改动后 highlights the same node + its neighbours in 改动前', async () => {
  await tid('viz-graph').focus(); await page.keyboard.press('f'); await sleep(300)
  const id = await page.locator('.pane-after .vn.st-modified').first().getAttribute('data-id')
  await page.locator(`.pane-after .vn[data-id="${id}"]`).hover(); await sleep(250)
  const css = await page.evaluate(() => [...document.querySelectorAll('.vz-graph style')].map((s) => s.textContent).join(''))
  if (!css.replace(/\\(.)/g, '$1').includes(id)) throw new Error('no hover rule for ' + id + ': ' + css.slice(0, 200))
  const sh = await page.locator(`.pane-before .vn[data-id="${id}"]`).evaluate((e) => getComputedStyle(e).boxShadow)
  if (!sh || sh === 'none') throw new Error('before pane not highlighted')
  if (!/edge-path/.test(css)) throw new Error('edges not highlighted')
  await shot('04-calls-synced-hover')
  await page.mouse.move(700, 5); await sleep(200)
})

await step('Shift+click two nodes → path highlighted with a chip; Esc clears', async () => {
  // pick a node and one of its neighbours from the hover rule
  const id = await page.locator('.pane-after .vn.st-modified').first().getAttribute('data-id')
  await page.locator(`.pane-after .vn[data-id="${id}"]`).hover(); await sleep(200)
  const css = await page.evaluate(() => [...document.querySelectorAll('.vz-graph style')].map((s) => s.textContent).join(''))
  const ids = [...css.matchAll(/\.vn\[data-id="([^"]+)"\]/g)].map((m) => m[1].replace(/\\(.)/g, '$1')).filter((x) => x !== id)
  if (!ids.length) throw new Error('no neighbour')
  await page.locator(`.pane-after .vn[data-id="${id}"]`).click({ modifiers: ['Shift'] }); await sleep(200)
  if (!(await tid('viz-path').innerText()).includes('起点')) throw new Error('start chip: ' + (await tid('viz-path').innerText()))
  await page.locator(`.pane-after .vn[data-id="${ids[0]}"]`).click({ modifiers: ['Shift'] }); await sleep(300)
  const t = await tid('viz-path').innerText()
  if (!/1 步/.test(t)) throw new Error('path chip: ' + t)
  if ((await page.locator('.pane-after .vn.onpath').count()) !== 2) throw new Error('onpath nodes ' + (await page.locator('.pane-after .vn.onpath').count()))
  if ((await page.locator('.vz-graph path.ve.onpath').count()) < 1) throw new Error('onpath edge')
  if ((await page.locator('.pane-after .vn.dim').count()) < 3) throw new Error('others not dimmed')
  await shot('05-calls-path')
  await tid('viz-graph').focus(); await page.keyboard.press('Escape'); await sleep(200)
  if (await tid('viz-path').count()) throw new Error('chip not cleared')
  if (await tid('viz-panel').count()) throw new Error('shift+click opened the panel')
})

await step('semantic zoom: zoomed far out = blocks + big group names, no sub lines / edge labels', async () => {
  for (let i = 0; i < 9; i++) await page.locator('.vz-zoom button[aria-label=缩小]').click()
  await sleep(300)
  if (!(await tid('viz-graph').getAttribute('class')).includes('z-far')) throw new Error('not z-far at ' + (await zoomPct()))
  const vis = await page.locator('.pane-after .vn-sub').first().evaluate((e) => getComputedStyle(e).visibility)
  if (vis !== 'hidden') throw new Error('sub visible when far')
  const sc = await page.locator('.pane-after .vg-label').first().evaluate((e) => getComputedStyle(e).transform)
  if (!sc || sc === 'none') throw new Error('group label not counter-scaled')
  await shot('06-calls-semantic-far')
  await page.keyboard.press('f')
})

await step('minimap: hidden when everything fits, toggle button shows / hides it', async () => {
  await tid('viz-graph').focus(); await page.keyboard.press('f'); await sleep(300)
  const before = await page.locator('.react-flow__minimap').count()
  await tid('viz-minimap').click(); await sleep(200)
  const after = await page.locator('.react-flow__minimap').count()
  if (before === after) throw new Error(`toggle did nothing ${before}`)
  await tid('viz-minimap').click(); await sleep(200)
  if ((await page.locator('.react-flow__minimap').count()) !== before) throw new Error('toggle back')
})

await step('叠加: 前 fades added, 后 fades removed, 播放 alternates; mode switch resets', async () => {
  await mode('overlay')
  await tid('viz-ov-before').click(); await sleep(600)
  const gAdd = await page.locator('.pane-both .vn.st-added.gone').count(); const gRm = await page.locator('.pane-both .vn.st-removed.gone').count()
  if (!gAdd || gRm) throw new Error(`before: added gone ${gAdd}, removed gone ${gRm}`)
  await shot('07-overlay-before-faded')
  await tid('viz-ov-after').click(); await sleep(600)
  if (!(await page.locator('.pane-both .vn.st-removed.gone').count()) || (await page.locator('.pane-both .vn.st-added.gone').count())) throw new Error('after side wrong')
  await tid('viz-ov-play').click(); await sleep(200)
  const a = await tid('viz-ov-play').innerText(); await sleep(1700); const b = await tid('viz-ov-play').innerText()
  if (a === b) throw new Error(`play did not alternate: ${a} ${b}`)
  await tid('viz-ov-play').click(); await sleep(200)
  if (await page.locator('.pane-both .gone').count()) throw new Error('stop did not restore')
  await mode('side')
})

await step('导出: whole diagram PNG (hi-res) + SVG, plus 当前画面 screenshot', async () => {
  await tid('viz-export').click()
  const items = await page.locator('.ctx-menu .ctx-item').allInnerTexts()
  for (const w of ['整张图，高清', 'SVG 矢量图（整张图）', '当前画面']) if (!items.some((x) => x.includes(w))) throw new Error('menu: ' + items.join('|'))
  await menuItem('整张图，高清').click(); await toastHas('已导出')
  const png = readdirSync(SAVE).find((f) => /^gitloom-calls-.*\.png$/.test(f) && !f.includes('-view-'))
  const { w, h } = pngSize(join(SAVE, png))
  const paneW = await tid('viz-pane-after').evaluate((e) => e.clientWidth)
  if (w < paneW * 2) throw new Error(`png ${w}x${h} not hi-res (pane ${paneW})`)
  await tid('viz-export').click(); await menuItem('SVG 矢量图（整张图）').click(); await toastHas('.svg')
  const svg = readFileSync(join(SAVE, readdirSync(SAVE).find((f) => /^gitloom-calls-.*\.svg$/.test(f))), 'utf8')
  for (const w2 of ['<svg', '改动前', '改动后', '新增', 'GitLoom']) if (!svg.includes(w2)) throw new Error('svg lacks ' + w2)
  if ((svg.match(/<path /g) ?? []).length < 10) throw new Error('svg has no edges')
  await tid('viz-export').click(); await menuItem('当前画面').click(); await sleep(1500)
  if (!readdirSync(SAVE).some((f) => /^gitloom-calls-view-.*\.png$/.test(f))) throw new Error('view png missing: ' + readdirSync(SAVE))
})

await step('AI 解读本图: grounded prompt, streamed bullets, 「name」 chips jump to the box; invented names stay text', async () => {
  await tid('viz-explain-btn').click()
  await until(async () => (await tid('viz-explain').innerText()).includes('建议先看'), 20000, 'explain text')
  const prompt = reqs.find((r) => r.includes('解读这张图'))
  if (!prompt || !prompt.includes('调用图') || !/\[新增\] 函数 「/.test(prompt)) throw new Error('prompt: ' + (prompt ?? '').slice(0, 300))
  const refs = page.locator('[data-testid=viz-explain] .vz-ref')
  if ((await refs.count()) < 2) throw new Error('refs ' + (await refs.count()))
  if ((await tid('viz-explain').innerText()).includes('不存在的函数') && (await page.locator('[data-testid=viz-explain] .vz-ref', { hasText: '不存在的函数' }).count())) throw new Error('invented name linked')
  const name = await refs.first().innerText()
  await refs.first().click(); await sleep(400)
  const t = await page.locator('.pane-after .vn.nav .vn-label').first().innerText().catch(() => '')
  if (t !== name) throw new Error(`jumped to ${t}, wanted ${name}`)
  await shot('08-calls-ai-explain')
  const n0 = reqs.length
  await tid('viz-explain-btn').click(); await tid('viz-explain-btn').click(); await sleep(400)
  if (reqs.length !== n0) throw new Error('not cached')
  await tid('viz-explain-btn').click()
})

await step('1500-file repo: 模块依赖 folds unchanged context into clusters, click to expand, 收起 to fold back', async () => {
  await setActive(BIG); await openViz(); await vizDone()
  await mode('side'); await tab('modules')
  // 只看变更 is on by default for big graphs; turn it off to see the clustering of the whole repo
  if ((await tid('viz-focus').getAttribute('aria-pressed')) === 'true') { await tid('viz-focus').click(); await settled() }
  const leaves = await page.locator('.pane-after .react-flow__node .vn').count()
  const changedN = await page.locator('.pane-after .react-flow__node .vn:not(.st-unchanged):not(.k-cluster)').count()
  if (leaves > changedN + 24) throw new Error(`too many boxes ${leaves} (changed ${changedN})`)
  const clusters = page.locator('.pane-after .vn.k-cluster')
  if ((await clusters.count()) < 2) throw new Error('clusters ' + (await clusters.count()))
  if ((await zoomPct()) < 50) throw new Error('zoom ' + (await zoomPct()))
  await shot('10-big-modules-clustered')
  await tid('viz-graph').focus(); await page.keyboard.press('f'); await sleep(400)
  await shot('11-big-modules-overview')
  const cid = await clusters.first().getAttribute('data-id')
  await page.locator(`.pane-after .vn.k-cluster[data-id="${cid}"]`).click(); await settled()
  await until(async () => (await page.locator('.pane-after .react-flow__node .vn').count()) > leaves, 10000, 'expanded')
  if (!(await tid('viz-collapse').innerText()).includes('收起 1 组')) throw new Error('collapse button')
  if (await tid('viz-panel').count()) throw new Error('cluster click opened the panel')
  await shot('12-big-modules-expanded')
  await tid('viz-collapse').click(); await settled()
  if (await tid('viz-collapse').count()) throw new Error('collapse button still there')
  if ((await page.locator('.pane-after .react-flow__node .vn').count()) !== leaves) throw new Error('not folded back')
})

await step('web-shop 影响面 + 类: readable start, no edges through boxes', async () => {
  await setActive(SHOP); await openViz(); await vizDone()
  await tid('viz-presets').click(); await menuItem('当前分支 feature/coupons').click(); await sleep(300); await vizDone()
  for (const v of ['impact', 'modules', 'classes', 'arch', 'flow', 'state']) {
    await tab(v)
    if (v !== 'state' && v !== 'flow' && (await zoomPct()) < 45) throw new Error(`${v} zoom ${await zoomPct()}`)
    await shot(`2${['impact', 'modules', 'classes', 'arch', 'flow', 'state'].indexOf(v)}-shop-${v}`)
  }
})

await step('slider mode: 改动前/对半/改动后 switch is clickable and overlaps no floating bar', async () => {
  await tab('modules'); await tid('viz-mode-slider').click(); await settled()
  const r = await page.evaluate(() => {
    const f = document.querySelector('.vz-slider-flip').getBoundingClientRect()
    const hit = [...document.querySelectorAll('.vz-gbar, .vz-zoom, .vz-pathchip, .vz-ov-switch, .react-flow__minimap')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && !(b.right <= f.left || b.left >= f.right || b.bottom <= f.top || b.top >= f.bottom) }).map((e) => e.className)
    return { hit }
  })
  if (r.hit.length) throw new Error('flip overlaps ' + r.hit.join(','))
  await page.locator('.vz-slider-flip button', { hasText: '改动后' }).click({ timeout: 3000 }); await sleep(200)
  if (!(await page.locator('.vz-slider-flip button.on', { hasText: '改动后' }).count())) throw new Error('flip did not switch')
  await page.locator('.vz-slider-flip button', { hasText: '对半' }).click({ timeout: 3000 })
  await tid('viz-mode-side').click(); await settled()
})

await step('light theme + 1024px: scope bar, toolbar and export button on one row; nothing overflows', async () => {
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 720)); await sleep(900)
  for (const v of ['calls', 'modules', 'impact', 'classes', 'map', 'tour']) {
    await page.locator(`[data-testid=viz-tab-${v}]`).click(); await sleep(900)
    const r = await page.evaluate(() => {
      const row = (sel) => { const el = document.querySelector(sel); if (!el) return null; const br = el.getBoundingClientRect(); const kids = [...el.children].map((c) => c.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 4); const cy = (b) => (b.top + b.bottom) / 2; return { wrap: kids.some((b) => Math.abs(cy(b) - cy(kids[0])) > 10), over: el.scrollWidth > el.clientWidth + 1 || kids.some((b) => b.right > br.right + 1) } }
      const ex = document.querySelector('[data-testid=viz-export]').getBoundingClientRect(); const tb = document.querySelector('.vz-toolbar').getBoundingClientRect()
      const tbe = document.querySelector('.vz-toolbar'); const tr = tbe.getBoundingClientRect()
      const bad = [...tbe.children].filter((c) => { const b = c.getBoundingClientRect(); return b.width > 0 && b.height > 4 && (b.top > tr.top + 14 || b.right > tr.right + 1) }).map((c) => `${c.className}@${Math.round(c.getBoundingClientRect().top - tr.top)},${Math.round(c.getBoundingClientRect().right - tr.right)}`)
      return { bad, scope: row('.vz-scope'), toolbar: row('.vz-toolbar'), exportOk: ex.top < tb.top + 14 && ex.right <= tb.right + 1 && ex.width > 0 }
    })
    if (r.scope.wrap || r.scope.over || r.toolbar.wrap || r.toolbar.over || !r.exportOk) throw new Error(`${v}: ${JSON.stringify(r)}`)
    if (['calls', 'modules'].includes(v)) await shot(`30-1024-light-${v}`)
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900)); await sleep(500)
})

await step('no page errors', async () => {
  const errs = pageErrors.filter((e) => !/ResizeObserver loop/.test(e))
  if (errs.length) throw new Error(errs.slice(0, 5).join('\n'))
})

const fails = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - fails.length}/${results.length} passed`)
await app.close(); server.close()
process.exit(fails.length ? 1 : 0)
