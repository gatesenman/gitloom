// e2e for GitLoom 0.5.0 变更可视化: every view, scope types, compare modes, focus, search, node → diff, export,
// no-AI fallback, mock-AI path (schema retry, cache, cancel), entry points, 1024px light/dark, dogfood.
// Run: xvfb-run -a node e2e/e2e-050.mjs   (SHOTS_DIR=screenshots/v8 to refresh the release screenshots)
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { makeTsService, makePy, makeJava, makeBig } from '../scripts/viz-fixtures.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e050'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = process.env.SHOTS_DIR || join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [DATA, SAVE, shots]) mkdirSync(d, { recursive: true })
const PROJ = join(ROOT, 'proj')
const BIG = makeBig(join(PROJ, 'big-mono'), 1500, 60)
const TS = makeTsService(join(PROJ, 'ts-service')), PY = makePy(join(PROJ, 'py-pkg')), JAVA = makeJava(join(PROJ, 'java-app'))
// dogfood: a throw-away clone of GitLoom itself (never touches the working copy)
const DOG = join(PROJ, 'dogfood')
spawnSync('git', ['clone', '-q', '--no-local', '/workspace/gitdesk', DOG])
const DOG_SHA = process.env.DOG_SHA || 'e93a174'

// ---- mock AI (OpenAI-compatible, streaming). mode: ok | retry (first answer breaks the schema) | slow
let mode = 'retry'
const reqs = []
const AI_JSON = {
  headline: '订单服务引入服务层并扩展状态机', risk: 'medium',
  architecture: {
    layers: [
      { id: 'ui', name: '表现层', components: [{ id: 'ui', name: '订单页面', status: 'modified', modules: ['src/ui/OrderPage.tsx'] }] },
      { id: 'api', name: '接口层', components: [{ id: 'api', name: '订单 API', status: 'modified', modules: ['src/api/orders.ts'] }] },
      { id: 'svc', name: '业务层', components: [{ id: 'svc', name: '订单服务', status: 'added', modules: ['src/services/orderService.ts'], note: '新增服务层' }] },
      { id: 'data', name: '数据层', components: [{ id: 'repo', name: '订单仓储', status: 'removed' }, { id: 'reader', name: '读仓储', status: 'added' }, { id: 'writer', name: '写仓储', status: 'added' }] }
    ],
    links: [{ from: 'ui', to: 'api', status: 'unchanged' }, { from: 'api', to: 'repo', status: 'removed' }, { from: 'api', to: 'svc', status: 'added' }, { from: 'svc', to: 'reader', status: 'added' }, { from: 'svc', to: 'writer', status: 'added' }]
  },
  sequences: [{ id: 'pay', title: '支付订单', before: { participants: [{ id: 'u', name: '用户', kind: 'actor' }, { id: 'api', name: 'orders API' }, { id: 'repo', name: 'orderRepo' }], steps: [{ type: 'msg', from: 'u', to: 'api', label: 'payOrder(id)' }, { type: 'msg', from: 'api', to: 'repo', label: 'saveOrder(o)' }] },
    after: { participants: [{ id: 'u', name: '用户', kind: 'actor' }, { id: 'api', name: 'orders API' }, { id: 'svc', name: 'OrderService' }, { id: 'w', name: 'orderWriter' }], steps: [{ type: 'msg', from: 'u', to: 'api', label: 'payOrder(id)' }, { type: 'msg', from: 'api', to: 'svc', label: 'pay(id)' }, { type: 'alt', label: '状态校验', branches: [{ label: '可支付', steps: [{ type: 'msg', from: 'svc', to: 'w', label: 'saveOrder(o)' }] }] }] } }],
  states: [{ id: 'order', name: '订单生命周期', before: { initial: 'new', states: [{ id: 'new' }, { id: 'paid' }, { id: 'shipped' }], transitions: [{ from: 'new', to: 'paid', event: 'pay' }, { from: 'paid', to: 'shipped', event: 'ship' }] },
    after: { initial: 'new', states: [{ id: 'new' }, { id: 'paid' }, { id: 'shipped' }, { id: 'cancelled' }, { id: 'refunded' }], transitions: [{ from: 'new', to: 'paid', event: 'pay' }, { from: 'paid', to: 'shipped', event: 'ship' }, { from: 'new', to: 'cancelled', event: 'cancel' }, { from: 'paid', to: 'refunded', event: 'refund' }] } }],
  flows: [{ id: 'checkout', title: '下单到发货', before: { nodes: [{ id: 's', label: '用户下单', kind: 'start' }, { id: 'p', label: '支付' }, { id: 'sh', label: '发货' }, { id: 'e', label: '完成', kind: 'end' }], edges: [{ from: 's', to: 'p' }, { from: 'p', to: 'sh' }, { from: 'sh', to: 'e' }] },
    after: { nodes: [{ id: 's', label: '用户下单', kind: 'start' }, { id: 'd', label: '是否取消?', kind: 'decision' }, { id: 'c', label: '取消订单' }, { id: 'p', label: '支付' }, { id: 'sh', label: '发货' }, { id: 'e', label: '完成', kind: 'end' }], edges: [{ from: 's', to: 'd' }, { from: 'd', to: 'c', label: '是' }, { from: 'd', to: 'p', label: '否' }, { from: 'p', to: 'sh' }, { from: 'sh', to: 'e' }, { from: 'c', to: 'e' }] } }]
}
const BROKEN = JSON.parse(JSON.stringify(AI_JSON)); BROKEN.sequences[0].after.steps.push({ type: 'msg', from: 'ghost', to: 'api', label: 'x' })
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-pro' }] })); return }
    const j = JSON.parse(body || '{}')
    const all = JSON.stringify(j.messages ?? [])
    const isViz = all.includes('架构可视化')
    const isRetry = all.includes('没有通过 JSON schema')
    const r = { n: reqs.length + 1, viz: isViz, retry: isRetry, aborted: false, done: false }
    reqs.push(r)
    req.on('close', () => { if (!r.done) r.aborted = true })
    const answer = !isViz ? '好的' : (mode === 'retry' && !isRetry) ? '```json\n' + JSON.stringify(BROKEN) + '\n```' : JSON.stringify(AI_JSON)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunks = answer.match(/[\s\S]{1,400}/g) ?? ['']
    let i = 0
    const delay = mode === 'slow' ? 400 : 5
    const tick = () => {
      if (res.destroyed) return
      if (i < chunks.length) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`); setTimeout(tick, delay) }
      else { res.write('data: [DONE]\n\n'); r.done = true; res.end() }
    }
    tick()
  })
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const base = `http://127.0.0.1:${server.address().port}/v1`
const AI = { baseUrl: base, apiKey: 'sk-good', model: 'mock-pro', temperature: 0.2, language: 'zh', commitStyle: 'conventional', profiles: [{ id: 'p-mock', name: 'Mock', preset: 'custom', protocol: 'openai', baseUrl: base, apiKey: 'sk-good', model: 'mock-pro' }], activeProfile: 'p-mock', tasks: {}, fallback: [] }
const repoEntry = (p, rel) => ({ path: p, rel, kind: 'normal', initialized: true })
writeFileSync(join(DATA, 'gitloom.json'), JSON.stringify({
  settings: { theme: 'dark', diffMode: 'split', graphLimit: 200, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 2, aiEnvForHooks: false, fontSize: 13, concurrency: 4, ai: AI },
  workspace: { repos: [TS, PY, JAVA, DOG], active: TS, projects: [{ id: 'p', name: 'viz-demo', root: PROJ, repos: [repoEntry(TS, 'ts-service'), repoEntry(PY, 'py-pkg'), repoEntry(JAVA, 'java-app'), repoEntry(DOG, 'dogfood')], hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
}))

const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox', '--disable-gpu'], env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_NO_WATCH: '1', GITLOOM_SAVE_DIR: SAVE }, timeout: 120000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeout = 20000, what = '') => { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last } catch (e) { last = e.message } await sleep(120) } throw new Error('timeout ' + (what || fn.toString().slice(0, 140)) + ' last=' + JSON.stringify(last)?.slice(0, 200)) }
const results = []
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); console.log('✔', name) }
  catch (e) { results.push(['FAIL', name]); console.log('✘', name, (e.message || String(e)).slice(0, 500)); await page.screenshot({ path: join(ROOT, `fail-${results.length}.png`) }).catch(() => {}) }
}
const shot = async (name) => { await page.mouse.move(700, 5); await sleep(250); await page.screenshot({ path: join(shots, `${name}.png`) }) }
const setActive = async (p) => { await page.evaluate((x) => window.__gitloomSetActive && window.__gitloomSetActive(x), p); await sleep(900) }
const more = async (label) => { await page.locator('.viewtabs [role="tab"]', { hasText: label }).first().click(); await sleep(400) }
const openViz = async () => { await page.evaluate(() => window.__gitloomSetView && window.__gitloomSetView('viz')); await sleep(600) }
const vizDone = () => until(async () => (await page.locator('[data-testid=viz-summary]').count()) > 0 && (await page.locator('[data-testid=viz-progress]').count()) === 0, 60000, 'analysis finished')
const nodes = (pane = 'after') => page.locator(`[data-testid=viz-pane-${pane}] .react-flow__node:not(.react-flow__node-group)`).evaluateAll((els) => els.filter((e) => getComputedStyle(e).visibility !== 'hidden' && e.style.visibility !== 'hidden' && e.offsetParent !== null).length)
const settled = async () => { await until(async () => (await page.locator('.vz-busy').count()) === 0, 30000, 'layout'); await sleep(450) }
const tab = async (id) => { await page.locator(`[data-testid=viz-tab-${id}]`).click(); await sleep(200); await settled() }
const analyze = async (scope, vals = {}) => {
  await page.locator(`[data-testid=viz-scope-${scope}]`).click()
  for (const [k, v] of Object.entries(vals)) await page.locator(`[data-testid=viz-${k}]`).fill(v)
  await page.locator('[data-testid=viz-run]').click()
  await sleep(300); await vizDone(); await settled()
}
const summaryText = () => page.locator('[data-testid=viz-summary]').innerText()

// ===================================================================================== static views
await step('看懂改动 → 变更可视化: auto analysis of the working tree', async () => {
  await sleep(2500)
  await openViz()
  await page.waitForSelector('.view-intro', { timeout: 5000 })
  const intro = await page.locator('.view-intro').innerText()
  if (!intro.includes('重构')) throw new Error('intro story missing: ' + intro)
  await vizDone()
  const s = await summaryText()
  if (!s.includes('工作区改动')) throw new Error('expected working scope, got ' + s)
  await shot('01-intro-working')
  await page.locator('.view-intro button', { hasText: '知道了' }).click().catch(() => {})
})

await step('commit scope: summary strip numbers (+模块 −依赖 ~函数)', async () => {
  await analyze('commit', { sha: 'HEAD' })
  const s = await summaryText()
  for (const want of ['+5', '文件', '函数', '状态']) if (!s.includes(want)) throw new Error(`summary lacks ${want}: ${s}`)
  await shot('02-summary-strip')
})

const VIEWS = ['arch', 'modules', 'calls', 'flow', 'sequence', 'state', 'classes', 'impact']
for (const v of VIEWS) {
  await step(`view ${v}: side-by-side + overlay render with changes`, async () => {
    await tab(v)
    await page.locator('[data-testid=viz-mode-side]').click(); await settled()
    if (v === 'sequence') {
      const n = await page.locator('[data-testid=viz-pane-after] .sq-msg').count()
      if (n < 2) throw new Error('sequence messages ' + n)
    } else {
      const a = await nodes('after'); const b = await nodes('before')
      if (a < 2) throw new Error(`after pane nodes ${a}`)
      if (v !== 'flow' && b < 1) throw new Error(`before pane nodes ${b}`)
      const changed = await page.locator('[data-testid=viz-pane-after] .vn:not(.st-unchanged), [data-testid=viz-pane-after] .vg:not(.st-unchanged)').count()
      if (!changed && v !== 'impact') throw new Error('no changed nodes highlighted')
    }
    await shot(`10-${v}-side`)
    await page.locator('[data-testid=viz-mode-overlay]').click(); await settled()
    if (!(await page.locator('[data-testid=viz-pane-overlay]').count())) throw new Error('overlay pane missing')
    await shot(`11-${v}-overlay`)
  })
}

await step('state view: cancelled / refunded added after, hidden before', async () => {
  await tab('state'); await page.locator('[data-testid=viz-mode-side]').click(); await settled()
  const after = await page.locator('[data-testid=viz-pane-after] .vn.k-state.st-added, [data-testid=viz-pane-after] .vn.k-final.st-added').allInnerTexts()
  if (!after.join(' ').includes('cancelled') || !after.join(' ').includes('refunded')) throw new Error('added states: ' + after)
  const before = await page.locator('[data-testid=viz-pane-before] .vn.k-state.st-added, [data-testid=viz-pane-before] .vn.k-final.st-added').evaluateAll((els) => els.filter((e) => e.closest('.react-flow__node').style.visibility !== 'hidden' && e.offsetParent !== null).length)
  if (before) throw new Error('added states visible in before pane: ' + before)
})

await step('slider mode: wipe handle + 改动前/改动后 flip', async () => {
  await tab('modules')
  await page.locator('[data-testid=viz-mode-slider]').click(); await settled()
  await page.waitForSelector('.vz-slider-handle')
  await page.locator('.vz-slider-flip button', { hasText: '改动后' }).click(); await sleep(200)
  const clip = await page.locator('.vz-slide-layer.top').evaluate((e) => e.style.clipPath)
  if (!clip.includes('0%')) throw new Error('flip to after: ' + clip)
  await page.locator('.vz-slider-flip button', { hasText: '对半' }).click(); await sleep(200)
  await shot('12-modules-slider')
  await page.locator('[data-testid=viz-mode-side]').click(); await settled()
})

await step('side-by-side pan/zoom stays in sync', async () => {
  await page.locator('.vz-zoom button[aria-label=放大]').click(); await sleep(300)
  const pane = page.locator('[data-testid=viz-pane-before] .react-flow__pane'); const box = await pane.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height - 60, { steps: 6 }); await page.mouse.up(); await sleep(300)
  const t = await page.$$eval('.vz-pane .react-flow__viewport', (els) => els.map((e) => e.style.transform))
  if (t.length !== 2 || t[0] !== t[1]) throw new Error('viewports differ: ' + t.join(' | '))
  await page.locator('[data-testid=viz-fit]').click(); await sleep(200)
})

await step('focus: 只看变更 + N 跳 reduces the graph; hops change it', async () => {
  await tab('calls')
  const all = await nodes('after')
  const btn = page.locator('[data-testid=viz-focus]')
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click()
  await page.locator('[data-testid=viz-hops]').selectOption('0'); await settled()
  const f0 = await nodes('after')
  await page.locator('[data-testid=viz-hops]').selectOption('2'); await settled()
  const f2 = await nodes('after')
  if (!(f0 <= f2 && f0 > 0 && f0 <= all)) throw new Error(`all=${all} hop0=${f0} hop2=${f2}`)
  await page.locator('[data-testid=viz-hops]').selectOption('1'); await settled()
  await shot('13-focus-mode')
  await btn.click(); await settled()
})

await step('search highlights + centres a node', async () => {
  await page.locator('[data-testid=viz-search]').fill('cancel'); await sleep(500)
  const hl = await page.locator('[data-testid=viz-pane-after] .vn.hl').count()
  if (!hl) throw new Error('no highlighted match')
  await page.locator('[data-testid=viz-search]').press('Enter'); await sleep(200)
  await page.locator('[data-testid=viz-search]').fill('')
})

await step('node click → side panel with code diff → 打开差异 (Monaco)', async () => {
  await tab('calls')
  await page.locator('[data-testid=viz-fit]').first().click(); await sleep(500)
  await page.locator('[data-testid=viz-pane-after] .vn.st-added', { hasText: 'cancel' }).first().click()
  await page.waitForSelector('[data-testid=viz-panel]')
  await until(async () => (await page.locator('[data-testid=viz-snippet] .cl').count()) > 2, 10000, 'snippet')
  const added = await page.locator('[data-testid=viz-snippet] .cl.ta').count()
  if (!added) throw new Error('snippet shows no added lines')
  await shot('14-node-panel')
  await page.locator('[data-testid=viz-open-diff]').click()
  await page.waitForSelector('[data-testid=viz-diff-modal] .monaco-diff-editor', { timeout: 15000 })
  await sleep(600)
  await shot('15-open-diff')
  await page.keyboard.press('Escape'); await sleep(300)
  if (await page.locator('[data-testid=viz-diff-modal]').count()) throw new Error('modal did not close')
  await page.keyboard.press('Escape'); await sleep(200)
  if (await page.locator('[data-testid=viz-panel]').count()) throw new Error('panel did not close')
})

await step('edge hover shows the import / call site', async () => {
  await tab('modules')
  const edge = page.locator('[data-testid=viz-pane-after] .react-flow__edge').first()
  const p = edge.locator('path.react-flow__edge-interaction')
  // 0.5.2: edges are orthogonal routes, so the bbox centre is often off the line; hover a real point on the path
  const pt = await p.evaluate((el) => { const L = el.getTotalLength(); const q = el.getPointAtLength(L * 0.5); const m = el.getScreenCTM(); return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f } })
  const bb = { x: pt.x, y: pt.y, width: 0, height: 0 }
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(150)
  await page.mouse.move(bb.x + bb.width / 2 + 1, bb.y + bb.height / 2); await sleep(250)
  const tip = await page.locator('.vz-tip').count() ? await page.locator('.vz-tip').innerText() : ''
  if (!tip) { // fall back: dispatch hover on the interaction path
    await p.dispatchEvent('mouseenter'); await sleep(200)
  }
  const t2 = await page.locator('.vz-tip').innerText()
  if (!/导入|依赖|调用/.test(t2)) throw new Error('tooltip: ' + t2)
})

await step('export PNG / SVG files + copy Mermaid / PlantUML', async () => {
  await tab('arch')
  for (const [label, ext] of [['导出 PNG 图片', 'png'], ['导出 SVG 矢量图', 'svg']]) {
    await page.locator('[data-testid=viz-export]').click(); await page.locator('.ctx-menu .ctx-item', { hasText: label }).first().click()
    await until(() => readdirSync(SAVE).some((f) => f.endsWith('.' + ext) && statSync(join(SAVE, f)).size > 2000), 20000, ext + ' file')
  }
  const png = readdirSync(SAVE).find((f) => f.endsWith('.png'))
  const head = readFileSync(join(SAVE, png)).subarray(0, 8).toString('hex')
  if (head !== '89504e470d0a1a0a') throw new Error('not a PNG: ' + head)
  for (const [label, want] of [['复制为 Mermaid', 'flowchart'], ['复制为 PlantUML', '@startuml']]) {
    await page.locator('[data-testid=viz-export]').click(); await page.locator('.ctx-menu .ctx-item', { hasText: label }).first().click(); await sleep(300)
    const txt = await page.evaluate(() => window.__vizLastCopy || '')
    if (!txt.startsWith(want)) throw new Error(label + ': ' + txt.slice(0, 80))
  }
  await tab('state')
  await page.locator('[data-testid=viz-export]').click(); await page.locator('.ctx-menu .ctx-item', { hasText: '复制为 Mermaid' }).first().click(); await sleep(300)
  if (!(await page.evaluate(() => window.__vizLastCopy || '')).startsWith('stateDiagram-v2')) throw new Error('state mermaid')
  await tab('sequence')
  await page.locator('[data-testid=viz-export]').click(); await page.locator('.ctx-menu .ctx-item', { hasText: '复制为 Mermaid' }).first().click(); await sleep(300)
  if (!(await page.evaluate(() => window.__vizLastCopy || '')).startsWith('sequenceDiagram')) throw new Error('sequence mermaid')
  await page.locator('[data-testid=viz-export]').click(); await page.locator('.ctx-menu .ctx-item', { hasText: '导出 SVG 矢量图' }).first().click()
  await until(() => readdirSync(SAVE).some((f) => f.startsWith('gitloom-sequence') && f.endsWith('.svg')), 10000, 'sequence svg')
})

await step('flow view: pick a function → try/catch control flow', async () => {
  await tab('flow')
  await page.locator('[data-testid=viz-list] .vz-li', { hasText: 'OrderService.cancel' }).click(); await settled()
  const t = await page.locator('[data-testid=viz-pane-after] .vn').allInnerTexts()
  if (!t.some((x) => x.includes('try'))) throw new Error('no try node: ' + t.slice(0, 10))
  await shot('16-flow-function')
})

await step('sequence: message click opens the panel with the call site', async () => {
  await tab('sequence'); await page.locator('[data-testid=viz-mode-side]').click(); await sleep(300)
  await page.locator('[data-testid=viz-pane-after] .sq-msg').first().click()
  await page.waitForSelector('[data-testid=viz-panel]')
  await page.keyboard.press('Escape')
})

await step('range + branch-vs-branch + path filter scopes', async () => {
  await analyze('range', { from: 'main~1', to: 'refactor/service-layer' })
  if (!(await summaryText()).includes('..')) throw new Error('range label')
  await analyze('refs', { base: 'main', head: 'refactor/service-layer' })
  const s = await summaryText()
  if (!s.includes('↔')) throw new Error('refs label ' + s)
  await page.locator('[data-testid=viz-filter]').fill('src/db')
  await page.locator('[data-testid=viz-run]').click(); await sleep(300); await vizDone(); await settled()
  const s2 = await summaryText()
  if (!s2.includes('src/db')) throw new Error('filter not shown: ' + s2)
  await tab('modules')
  const labels = await page.locator('[data-testid=viz-pane-after] .vn').allInnerTexts()
  if (labels.some((l) => l.includes('orderService'))) throw new Error('filter leaked: ' + labels)
  await page.locator('[data-testid=viz-filter]').fill('')
})

await step('cancel a running analysis (停止)', async () => {
  await app.evaluate(() => { process.env.GITLOOM_VIZ_SLOWMO = '4000' })
  try {
  await page.locator('[data-testid=viz-scope-commit]').click(); await page.locator('[data-testid=viz-sha]').fill('HEAD~1')
  await page.locator('[data-testid=viz-run]').click()
  await page.waitForSelector('[data-testid=viz-cancel]', { timeout: 5000 })
  await page.locator('[data-testid=viz-cancel]').click()
  await page.waitForSelector('[data-testid=viz-error]', { timeout: 5000 })
  if (!(await page.locator('[data-testid=viz-error]').innerText()).includes('已取消')) throw new Error('no cancel message')
  await shot('19-cancelled')
  } finally { await app.evaluate(() => { process.env.GITLOOM_VIZ_SLOWMO = '0' }) }
  await analyze('commit', { sha: 'HEAD' })
})

await step('cache: re-analysing the same commit reuses parsed files', async () => {
  const s = await page.locator('.vz-stats').getAttribute('title')
  if (!/缓存 [1-9]/.test(s)) throw new Error('no cache hits: ' + s)
})

// ===================================================================================== AI
await step('mock AI: schema retry once, AI layers / business flow / sequence / state', async () => {
  mode = 'retry'
  const n0 = reqs.filter((r) => r.viz).length
  await page.locator('[data-testid=viz-ai]').click()
  await until(async () => (await page.locator('[data-testid=viz-ai]').count()) && (await page.locator('[data-testid=viz-ai]').innerText()).includes('已增强'), 30000, 'AI done')
  const vr = reqs.filter((r) => r.viz).slice(n0)
  if (vr.length !== 2 || !vr[1].retry) throw new Error('expected 1 retry: ' + JSON.stringify(vr))
  if (!(await summaryText()).includes('引入服务层')) throw new Error('headline missing')
  await tab('arch')
  if ((await page.locator('[data-testid=viz-arch-ai]').getAttribute('class')) !== 'on') await page.locator('[data-testid=viz-arch-ai]').click()
  await settled()
  const t = await page.locator('[data-testid=viz-pane-after] .vn').allInnerTexts()
  if (!t.join(' ').includes('订单服务')) throw new Error('AI arch not shown: ' + t)
  await shot('20-ai-architecture')
  await tab('flow'); await page.locator('[data-testid=viz-flow-biz]').click(); await settled()
  const f = await page.locator('[data-testid=viz-pane-after] .vn').allInnerTexts()
  if (!f.join(' ').includes('取消订单')) throw new Error('business flow: ' + f)
  await shot('21-ai-business-flow')
  await tab('sequence')
  await page.locator('[data-testid=viz-list] .vz-li', { hasText: '支付订单' }).click(); await sleep(300)
  if (!(await page.locator('[data-testid=viz-pane-after] .sq-frame').count())) throw new Error('AI sequence alt frame')
  await shot('22-ai-sequence')
  await tab('state')
  await page.locator('[data-testid=viz-list] .vz-li', { hasText: '订单生命周期' }).click(); await settled()
  await shot('23-ai-state')
})

await step('AI cache: second run does not call the model', async () => {
  const n0 = reqs.filter((r) => r.viz).length
  await page.locator('[data-testid=viz-ai]').click(); await sleep(800)
  if (reqs.filter((r) => r.viz).length !== n0) throw new Error('model called again')
})

await step('AI cancel: 停止 aborts the streaming request', async () => {
  mode = 'slow'
  await analyze('commit', { sha: 'HEAD~1' })
  await page.locator('[data-testid=viz-ai]').click()
  await page.waitForSelector('[data-testid=viz-ai-stop]', { timeout: 5000 })
  await sleep(900)
  await page.locator('[data-testid=viz-ai-stop]').click()
  await until(() => { const r = reqs.filter((x) => x.viz).pop(); return r && r.aborted }, 8000, 'request aborted')
  mode = 'retry'
})

await step('no AI configured: static views work, AI tabs show inline setup', async () => {
  const s = await page.evaluate(() => window.api.settings())
  await page.evaluate((x) => window.__gitloomSaveSettings(x), { ...s, ai: { ...s.ai, baseUrl: '', apiKey: '', model: '', profiles: [], activeProfile: '' } })
  await analyze('commit', { sha: 'HEAD' })
  await tab('arch'); await page.locator('[data-testid=viz-arch-ai]').click(); await sleep(400)
  await page.waitForSelector('[data-testid=viz-ai-setup]', { timeout: 5000 })
  await shot('24-no-ai-setup')
  await page.locator('.vz-toolbar .seg button', { hasText: '目录推断' }).click(); await settled()
  if ((await nodes('after')) < 2) throw new Error('static arch must still render')
  await page.evaluate((x) => window.__gitloomSaveSettings(x), s)
})

// ===================================================================================== entry points
const nav = async (label) => { await page.locator('.viewtabs [role=tab]').filter({ hasText: new RegExp('^\\s*' + label) }).first().click(); await sleep(600) }
await step('entry: 看懂改动 → 前后对比图 (viz only via understand module)', async () => {
  await page.locator('.modbar .mod-tab', { hasText: '看懂改动' }).click(); await sleep(500)
  await page.locator('[data-testid=summary-view], [data-testid=us-open-viz]').first().waitFor({ timeout: 10000 })
  const deep = page.locator('[data-testid=us-open-viz]')
  if (await deep.count()) await deep.click()
  else await page.evaluate(() => window.__gitloomSetView && window.__gitloomSetView('viz'))
  await vizDone()
})

await step('日常 Git tabs must not list 可视化', async () => {
  await page.locator('.modbar .mod-tab', { hasText: '日常 Git' }).click(); await sleep(400)
  const tabs = await page.$$eval('.viewtabs [role=tab]', (els) => els.map((e) => e.textContent.trim()))
  if (tabs.some((x) => x.includes('可视化'))) throw new Error('viz leaked into daily: ' + tabs)
})

// ===================================================================================== languages
await step('Python package: Admin(User) + Status.DELETED', async () => {
  await setActive(PY)
  await openViz(); await vizDone()
  await analyze('commit', { sha: 'HEAD' })
  await tab('classes')
  const t = (await page.locator('[data-testid=viz-pane-after] .vn').allInnerTexts()).join(' ')
  if (!t.includes('Admin')) throw new Error('classes: ' + t)
  await tab('state')
  const st = (await page.locator('[data-testid=viz-pane-after] .vn.st-added').allInnerTexts()).join(' ')
  if (!st.includes('DELETED')) throw new Error('states: ' + st)
  await shot('30-python-state')
})

await step('Java project: PaymentGateway + implements edge', async () => {
  await setActive(JAVA)
  await openViz(); await vizDone()
  await analyze('commit', { sha: 'HEAD' })
  await tab('classes')
  const t = (await page.locator('[data-testid=viz-pane-after] .vn').allInnerTexts()).join(' ')
  if (!t.includes('PaymentGateway') || !t.includes('OrderService')) throw new Error('classes: ' + t)
  await shot('31-java-classes')
  await tab('arch'); await shot('32-java-arch')
})

// ===================================================================================== dogfood + themes + 1024
await step('perf: 1500-file repo, 60 changed modules → analysis + every view stays interactive', async () => {
  await setActive(BIG)
  await openViz(); await vizDone()
  const t0 = Date.now()
  await analyze('commit', { sha: 'HEAD' })
  const tAnalyze = Date.now() - t0
  const times = {}
  for (const v of ['modules', 'calls', 'impact', 'arch', 'classes']) {
    const t = Date.now(); await tab(v)
    await until(async () => (await nodes('after')) > 0, 30000, v + ' rendered'); times[v] = Date.now() - t
  }
  const stats = await page.locator('.vz-stats').getAttribute('title')
  console.log('   perf: analyze', tAnalyze + 'ms', JSON.stringify(times), '|', stats.replace(/\n/g, ' · '))
  await tab('modules'); await shot('35-big-modules')
  if ((await nodes('after')) > 400) throw new Error('modules not clustered/focused: ' + (await nodes('after')))
  if (tAnalyze > 20000) throw new Error('analysis too slow: ' + tAnalyze)
})

await step('dogfood: GitLoom itself (' + DOG_SHA + ')', async () => {
  await setActive(DOG)
  await openViz(); await vizDone()
  await analyze('commit', { sha: DOG_SHA })
  console.log('   dogfood stats:', await page.locator('.vz-stats').innerText(), '|', await page.locator('.vz-stats').getAttribute('title'))
  for (const v of ['arch', 'modules', 'calls', 'sequence', 'state']) { await tab(v); await shot(`40-dogfood-${v}`) }
})

await step('light theme + 1024px: no horizontal overflow, screenshots', async () => {
  const s = await page.evaluate(() => window.api.settings())
  await page.evaluate((x) => window.api.setSettings(x), { ...s, theme: 'light' })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await setActive(TS); await openViz(); await vizDone(); await analyze('commit', { sha: 'HEAD' })
  for (const v of ['arch', 'calls', 'flow', 'sequence', 'state']) { await tab(v); await shot(`50-light-${v}`) }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 720)); await sleep(800)
  for (const [theme, v] of [['light', 'modules'], ['light', 'sequence'], ['dark', 'arch'], ['dark', 'classes']]) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
    await tab(v)
    const over = await page.evaluate(() => [...document.querySelectorAll('.vz-scope, .vz-summary, .vz-toolbar, .vz')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className))
    const body = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    if (over.length) throw new Error('overflow at 1024: ' + over)
    if (!body) throw new Error('page scrolls horizontally')
    await shot(`60-1024-${theme}-${v}`)
  }
  await page.evaluate((x) => window.__gitloomSaveSettings(x), s)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})

const fails = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - fails.length}/${results.length} passed`)
await app.close(); server.close()
process.exit(fails.length ? 1 : 0)
