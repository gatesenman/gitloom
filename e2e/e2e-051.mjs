// e2e for GitLoom 0.5.1 代码地图对比: quick-compare presets, tags + swap, 代码地图 (tree / treemap, before ↔ after,
// colouring, scope, search, hub warning, side panel, exports), hub flame on graph nodes, 改动导览 (static reading order,
// 已看过 progress, graph, export), AI 路径 (mock: schema retry with a bad ref, cache), no-AI setup card, 1500-file perf,
// light + 1024 px. Run: xvfb-run -a node e2e/e2e-051.mjs   (SHOTS_DIR=screenshots/v9 to refresh the release screenshots)
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { makeHub, makeBig, makeTsService } from '../scripts/viz-fixtures.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e051'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = process.env.SHOTS_DIR || join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [DATA, SAVE, shots]) mkdirSync(d, { recursive: true })
const PROJ = join(ROOT, 'proj')
const SHOP = makeHub(join(PROJ, 'web-shop'))
const TS = makeTsService(join(PROJ, 'ts-service'))
const BIG = makeBig(join(PROJ, 'big-mono'), 1500, 60)

// ---- mock AI (OpenAI-compatible, streaming): answers the 代码路径图 prompt by picking real candidate ids
let mode = 'retry'
const reqs = []
const tourAnswer = (all, bad) => {
  const ids = {}
  for (const m of all.matchAll(/(C\d+) \[(\w+)\] (?:文件|函数|类) (\S+)/g)) ids[m[3]] = ids[m[3]] ?? m[1]
  const pick = (t) => ids[t] ?? Object.values(ids)[0]
  return JSON.stringify({ title: '优惠券怎么生效', summary: '改动后结账页先判断开关，再调用优惠券服务扣减金额；改动前走旧的 promo 折扣。', groups: [
    { title: '结账入口', guide: '从页面渲染开始，看新加的优惠券分支', steps: [{ ref: pick('checkoutView.ts'), title: '渲染结账页', note: '新增 flag 判断' }, { ref: pick('renderCheckout()'), title: '计算总价', note: '改为调用 applyCoupons' }] },
    { title: '优惠券服务', guide: '新增模块：校验数量后逐张扣减', steps: [{ ref: bad ? 'C999' : pick('applyCoupons()'), title: '应用优惠券' }, { ref: pick('valid()'), title: '最多两张' }] },
    { title: '配置', steps: [{ ref: pick('config.ts'), title: '优惠券开关', note: '热点文件：被很多模块引用' }] }] })
}
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-pro' }] })); return }
    const j = JSON.parse(body || '{}')
    const all = (j.messages ?? []).map((m) => m.content).join('\n')
    const isTour = all.includes('代码路径图')
    const isRetry = all.includes('没有通过校验')
    reqs.push({ tour: isTour, retry: isRetry })
    const answer = isTour ? tourAnswer(all, mode === 'retry' && !isRetry) : '好的'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunks = answer.match(/[\s\S]{1,300}/g) ?? ['']
    let i = 0
    const tick = () => {
      if (res.destroyed) return
      if (i < chunks.length) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`); setTimeout(tick, 5) }
      else { res.write('data: [DONE]\n\n'); res.end() }
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
  workspace: { repos: [SHOP, TS, BIG], active: SHOP, projects: [{ id: 'p', name: 'map-demo', root: PROJ, repos: [repoEntry(SHOP, 'web-shop'), repoEntry(TS, 'ts-service'), repoEntry(BIG, 'big-mono')], hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
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
const shot = async (name) => { await page.mouse.move(700, 5); await sleep(300); await page.screenshot({ path: join(shots, `${name}.png`) }) }
const setActive = async (p) => { await page.evaluate((x) => window.__gitloomSetActive && window.__gitloomSetActive(x), p); await sleep(900) }
const more = async (label) => { await page.locator('.viewtabs [role="tab"]', { hasText: label }).first().click(); await sleep(400) }
const openViz = async () => { await page.evaluate(() => window.__gitloomSetView && window.__gitloomSetView('viz')); await sleep(600) }
const vizDone = () => until(async () => (await page.locator('[data-testid=viz-summary]').count()) > 0 && (await page.locator('[data-testid=viz-progress]').count()) === 0, 60000, 'analysis finished')
const settled = async () => { await until(async () => (await page.locator('.vz-busy').count()) === 0, 30000, 'layout'); await sleep(400) }
const tab = async (id) => { await page.locator(`[data-testid=viz-tab-${id}]`).click(); await sleep(250); await settled() }
const tid = (id) => page.locator(`[data-testid=${id}]`)
const toastHas = (t) => until(async () => (await page.locator('.toast').allInnerTexts()).some((x) => x.includes(t)), 15000, `toast ${t}`)
const menuItem = (t) => page.locator('.ctx-menu .ctx-item', { hasText: t })
const savedFile = (re) => readdirSync(SAVE).find((f) => re.test(f))

await step('open 变更可视化 on web-shop; new tabs 代码地图 / 改动导览 are first', async () => {
  await sleep(2500)
  await openViz()
  await page.locator('.view-intro button', { hasText: '知道了' }).click({ timeout: 4000 }).catch(() => {})
  await vizDone()
  const tabs = await page.locator('.vz-tab').allInnerTexts()
  if (!tabs[0].includes('代码地图') || !tabs[1].includes('改动导览')) throw new Error('tabs: ' + tabs.join('|'))
  const tip = await tid('viz-tab-map').getAttribute('title')
  if (!tip.includes('codemap')) throw new Error('tooltip: ' + tip)
})

await step('快捷对比 menu: tags, current branch ↔ main → refs analysis', async () => {
  await tid('viz-presets').click()
  const items = await page.locator('.ctx-menu .ctx-item').allInnerTexts()
  for (const want of ['最新标签 v1.1', '两个标签之间：v1.0 → v1.1', '当前分支 feature/coupons ↔ main']) if (!items.some((x) => x.includes(want))) throw new Error(`missing ${want}: ${items.join(' | ')}`)
  await shot('70-quick-compare-menu')
  await menuItem('当前分支 feature/coupons').click()
  await sleep(300); await vizDone()
  const s = await tid('viz-summary').innerText()
  if (!s.includes('main ↔ feature/coupons')) throw new Error('summary: ' + s)
  if ((await tid('viz-base').inputValue()) !== 'main') throw new Error('base input not synced')
})

await step('代码地图 · 树状清单: totals, coverage, hub warning, rows with before → after', async () => {
  await tab('map')
  await tid('cm-display-tree').click(); await tid('cm-scope-changed').click()
  const totals = await tid('cm-totals').innerText()
  for (const want of ['文件', '→', '依赖覆盖：完整', '可能受影响']) if (!totals.includes(want)) throw new Error(`totals lacks ${want}: ${totals}`)
  const warn = await tid('cm-hubwarn').innerText()
  if (!warn.includes('config.ts') || !warn.includes('热点文件')) throw new Error('hub warn: ' + warn)
  const rows = await page.locator('[data-testid=cm-file]').count()
  if (rows < 12) throw new Error('rows ' + rows)
  const cfg = page.locator('[data-testid=cm-file][data-path="src/config.ts"]')
  const t = await cfg.innerText()
  if (!t.includes('热点') || !t.includes('修改')) throw new Error('config row: ' + t)
  if (!(await page.locator('[data-testid=cm-file][data-path="src/ui/App.tsx"]').innerText()).includes('受影响')) throw new Error('App.tsx not affected')
  if (!(await page.locator('[data-testid=cm-file][data-path="src/lib/format.ts"]').innerText()).includes('fmt.ts')) throw new Error('rename not shown')
  if (await page.locator('[data-testid=cm-file][data-path="assets/logo.svg"]').count()) throw new Error('unchanged asset shown in 只看改动')
  await shot('71-map-tree')
})

await step('代码地图: click a file → side panel with patch; hub chip selects config.ts', async () => {
  await page.locator('[data-testid=cm-file][data-path="src/features/checkout/checkoutView.ts"]').click()
  await until(async () => (await tid('viz-panel').count()) && (await page.locator('[data-testid=viz-panel] .vz-code .ln, [data-testid=viz-panel] .vz-snip > *').count()) > 0, 10000, 'panel lines').catch(async () => { await until(async () => (await tid('viz-panel').innerText()).includes('applyCoupons'), 8000, 'panel text') })
  const txt = await tid('viz-panel').innerText()
  if (!txt.includes('checkoutView.ts')) throw new Error('panel: ' + txt.slice(0, 200))
  await shot('72-map-panel')
  await page.locator('.cm-hubchip', { hasText: 'config.ts' }).click(); await sleep(400)
  if (!(await tid('viz-panel').innerText()).includes('config.ts')) throw new Error('hub chip did not select')
  await page.keyboard.press('Escape'); await sleep(200)
})

await step('代码地图 · 方块图: after ↔ before sizing (added / removed files appear / disappear)', async () => {
  await tid('cm-display-treemap').click(); await sleep(500)
  await tid('cm-size-after').click(); await sleep(600)
  const cells = await page.locator('[data-testid=cm-cell]').count()
  if (cells < 10) throw new Error('cells ' + cells)
  const has = (p) => page.locator(`[data-testid=cm-cell][data-path="${p}"]`).count()
  if (!(await has('src/features/coupons/coupon.ts')) || (await has('src/features/legacy/oldPromo.ts'))) throw new Error('after side wrong')
  await shot('73-treemap-after')
  await tid('cm-size-before').click(); await sleep(700)
  if ((await has('src/features/coupons/coupon.ts')) || !(await has('src/features/legacy/oldPromo.ts'))) throw new Error('before side wrong')
  await shot('74-treemap-before')
  await tid('cm-size-after').click(); await sleep(500)
})

await step('代码地图: colour by heat / growth, legend follows; scope 全部文件 + search', async () => {
  await tid('cm-color').selectOption('heat'); await sleep(300)
  const cls = await page.locator('[data-testid=cm-cell][data-path="src/config.ts"]').getAttribute('class')
  if (!cls.includes('cm-hot3')) throw new Error('heat class ' + cls)
  if (!(await page.locator('.cm-legend').innerText()).includes('热点')) throw new Error('legend')
  await shot('75-treemap-heat')
  await tid('cm-color').selectOption('growth'); await sleep(300)
  if (!(await page.locator('[data-testid=cm-cell][data-path="src/features/coupons/coupon.ts"]').getAttribute('class')).includes('cm-grnew')) throw new Error('growth class')
  await tid('cm-color').selectOption('status')
  await tid('cm-scope-all').click(); await sleep(400)
  if (!(await page.locator('[data-testid=cm-cell][data-path="assets/logo.svg"]').count())) throw new Error('全部文件 lacks logo.svg')
  await shot('76-treemap-all')
  await tid('cm-display-tree').click(); await sleep(300)
  await tid('cm-search').fill('coupon'); await sleep(300)
  const paths = await page.locator('[data-testid=cm-file]').evaluateAll((els) => els.map((e) => e.dataset.path))
  if (!paths.length || paths.some((p) => !p.toLowerCase().includes('coupon'))) throw new Error('search: ' + paths)
  await tid('cm-search').fill(''); await tid('cm-scope-changed').click(); await sleep(300)
})

await step('代码地图 exports: Markdown review bundle, copy, JSON, PNG', async () => {
  await tid('viz-export').click(); await menuItem('导出 Markdown 评审包').click()
  await until(() => savedFile(/codemap.*\.md$/), 8000, 'md saved')
  const md = readFileSync(join(SAVE, savedFile(/codemap.*\.md$/)), 'utf8')
  if (!md.includes('⚠ 改动了热点文件') || !md.includes('src/config.ts') || !md.includes('| 文件 | 状态 |')) throw new Error('md: ' + md.slice(0, 300))
  await tid('viz-export').click(); await menuItem('复制 Markdown').click()
  await until(async () => ((await page.evaluate(() => window.__vizLastCopy)) ?? '').includes('代码地图对比'), 5000, 'copy')
  await tid('viz-export').click(); await menuItem('导出 JSON').click()
  await until(() => savedFile(/codemap.*\.json$/), 8000, 'json saved')
  if (JSON.parse(readFileSync(join(SAVE, savedFile(/codemap.*\.json$/)), 'utf8')).schema_version !== 'gitloom.codemap/v1') throw new Error('json schema')
  await tid('viz-export').click(); await menuItem('导出 PNG 图片').click()
  await until(() => savedFile(/codemap.*\.png$/), 15000, 'png saved')
})

await step('模块依赖 / 影响范围: hub flame on config.ts node', async () => {
  await tab('modules')
  await until(async () => (await page.locator('[data-testid=viz-pane-after] .vn-hub').count()) > 0, 10000, 'flame')
  await shot('77-modules-hub')
  await tab('impact')
  await until(async () => (await page.locator('.vn-hub').count()) > 0, 10000, 'impact flame')
})

await step('改动导览 · 阅读路线: numbered steps, graph, click → code, 已看过 progress persists', async () => {
  await tab('tour')
  await tid('tour-src-static').click(); await settled()
  const ns = await page.locator('[data-testid=tour-step]').evaluateAll((els) => els.map((e) => e.dataset.n))
  if (ns[0] !== '1' || !ns.some((n) => /^\d+a$/.test(n))) throw new Error('numbers ' + ns)
  const titles = await page.locator('[data-testid=tour-step] .tour-t').allInnerTexts()
  const iv = titles.indexOf('checkoutView.ts'), ic = titles.indexOf('coupon.ts'), icfg = titles.indexOf('config.ts')
  if (!(iv >= 0 && iv < ic && ic < icfg)) throw new Error('order ' + titles.join(','))
  const n = await page.locator('[data-testid=viz-pane-after] .react-flow__node').count()
  if (n < 8) throw new Error('graph nodes ' + n)
  await page.locator('[data-testid=tour-step] .tour-step-b', { hasText: 'applyCoupons' }).first().click()
  await until(async () => (await tid('viz-panel').innerText()).includes('applyCoupons'), 10000, 'panel')
  await page.locator('[data-testid=tour-step] input[type=checkbox]').first().check()
  await page.locator('[data-testid=tour-step] input[type=checkbox]').nth(1).check()
  if (!(await tid('tour-progress').innerText()).includes('已看过 2/')) throw new Error('progress')
  await shot('78-tour-static')
  await tab('map'); await tab('tour')
  if (!(await tid('tour-progress').innerText()).includes('已看过 2/')) throw new Error('progress lost after tab switch')
  await page.keyboard.press('Escape')
})

await step('改动导览: overlay mode + Markdown export', async () => {
  await tid('viz-mode-overlay').click(); await settled()
  await shot('79-tour-overlay')
  await tid('viz-mode-side').click(); await settled()
  await tid('viz-export').click(); await menuItem('导出 Markdown 阅读清单').click()
  await until(() => savedFile(/tour.*\.md$/), 8000, 'tour md')
  const md = readFileSync(join(SAVE, savedFile(/tour.*\.md$/)), 'utf8')
  if (!md.includes('**1. ') || !/`src\/[^`]+:\d+`/.test(md)) throw new Error('tour md: ' + md.slice(0, 300))
})

await step('AI 路径 (mock): question → bad ref → one retry → grouped 1a/1b steps linked to code; cached on rerun', async () => {
  await tid('tour-src-ai').click(); await sleep(300)
  await tid('tour-question').fill('优惠券是怎么生效的？')
  const before = reqs.length
  await tid('tour-ai-run').click()
  await toastHas('AI 路径已生成')
  const mine = reqs.slice(before)
  if (mine.length !== 2 || !mine[1].retry) throw new Error('expected 1 retry, got ' + JSON.stringify(mine))
  await settled()
  const ns = await page.locator('[data-testid=tour-step]').evaluateAll((els) => els.map((e) => e.dataset.n))
  if (ns.join(',') !== '1a,1b,2a,2b,3a') throw new Error('ai numbers ' + ns)
  const list = await tid('viz-tour-list').innerText()
  if (!list.includes('结账入口') || !list.includes('从页面渲染开始')) throw new Error('groups/guide missing')
  await page.locator('[data-testid=tour-step] .tour-step-b', { hasText: '应用优惠券' }).click()
  await until(async () => (await tid('viz-panel').innerText()).includes('couponService.ts'), 10000, 'ai step → code')
  await shot('80-tour-ai')
  await page.keyboard.press('Escape')
  const n0 = reqs.length
  await tid('tour-ai-run').click(); await toastHas('已使用缓存的 AI 路径')
  if (reqs.length !== n0) throw new Error('cache miss')
})

await step('no AI configured: AI 路径 shows 去配置 AI, static tour still works', async () => {
  const s = await page.evaluate(() => window.api.settings())
  await page.evaluate((x) => window.__gitloomSaveSettings(x), { ...s, ai: { ...s.ai, baseUrl: '', apiKey: '', model: '', profiles: [], activeProfile: '' } })
  await sleep(800)
  await until(async () => (await tid('tour-ai-setup').count()) > 0, 8000, 'setup button')
  await shot('81-tour-no-ai')
  await tid('tour-src-static').click(); await settled()
  if ((await page.locator('[data-testid=tour-step]').count()) < 5) throw new Error('static tour gone')
  await page.evaluate((x) => window.__gitloomSaveSettings(x), s); await sleep(500)
})

await step('tags as compare points + ⇄ swap: v1.0 → v1.1 only touched docs', async () => {
  await page.locator('[data-testid=viz-scope-range]').click()
  await tid('viz-from').fill('v1.1'); await tid('viz-to').fill('v1.0')
  await tid('viz-swap').click()
  if ((await tid('viz-from').inputValue()) !== 'v1.0' || (await tid('viz-to').inputValue()) !== 'v1.1') throw new Error('swap failed')
  const opts = await page.locator('#vz-commits option').evaluateAll((els) => els.map((e) => e.value))
  if (!opts.includes('v1.0') || !opts.includes('v1.1')) throw new Error('tags not offered: ' + opts.slice(0, 5))
  await tid('viz-run').click(); await sleep(300); await vizDone()
  await tab('map')
  const paths = await page.locator('[data-testid=cm-file]').evaluateAll((els) => els.map((e) => e.dataset.path))
  if (paths.join() !== 'docs/README.md') throw new Error('tag range files: ' + paths)
  await shot('82-map-tags')
})

await step('1500-file repo: map tree + treemap render fast', async () => {
  await setActive(BIG); await openViz(); await vizDone()
  await page.locator('[data-testid=viz-scope-commit]').click(); await tid('viz-sha').fill('HEAD'); await tid('viz-run').click(); await sleep(300); await vizDone()
  const t0 = Date.now()
  await tab('map'); await tid('cm-display-tree').click()
  await until(async () => (await page.locator('[data-testid=cm-file]').count()) >= 60, 15000, 'big rows')
  const tTree = Date.now() - t0
  const t1 = Date.now()
  await tid('cm-display-treemap').click(); await tid('cm-scope-all').click()
  await until(async () => (await page.locator('[data-testid=cm-cell]').count()) > 400, 15000, 'big cells')
  const tMap = Date.now() - t1
  console.log(`   big: tree ${tTree}ms, treemap(all 1500) ${tMap}ms, cells ${await page.locator('[data-testid=cm-cell]').count()}`)
  if (tTree > 4000 || tMap > 5000) throw new Error('too slow')
  await shot('83-big-treemap')
  await tid('cm-scope-changed').click(); await tid('cm-display-tree').click()
  await tab('tour'); await settled()
  await shot('84-big-tour')
})

await step('light theme + 1024px: map / tour without overflow', async () => {
  const s = await page.evaluate(() => window.api.settings())
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await setActive(SHOP); await openViz(); await vizDone()
  await tid('viz-presets').click(); await menuItem('当前分支 feature/coupons').click(); await sleep(300); await vizDone()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 720)); await sleep(800)
  for (const [v, disp] of [['map', 'tree'], ['map', 'treemap'], ['tour', '']]) {
    await tab(v)
    if (disp) await tid(`cm-display-${disp}`).click()
    await sleep(500)
    const over = await page.evaluate(() => [...document.querySelectorAll('.vz-scope, .vz-summary, .vz-toolbar, .vz')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className))
    if (over.length) throw new Error('overflow at 1024: ' + over)
    await shot(`85-1024-light-${v}${disp ? '-' + disp : ''}`)
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900)); await sleep(500)
  await tab('map'); await tid('cm-display-treemap').click(); await shot('86-dark-treemap-1440')
  await page.evaluate((x) => window.__gitloomSaveSettings(x), s)
})

await step('no page errors', async () => {
  const errs = pageErrors.filter((e) => !/ResizeObserver loop/.test(e))
  if (errs.length) throw new Error(errs.slice(0, 5).join('\n'))
})

const fails = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - fails.length}/${results.length} passed`)
await app.close(); server.close()
process.exit(fails.length ? 1 : 0)
