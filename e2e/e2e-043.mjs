// e2e for GitLoom 0.4.3: AI requests are single-flight, cancellable, cached and flicker-free.
// Reproduces the 0.4.2 bug (rapid clicks on 历史 → AI 解释 started N overlapping streams and the panel flickered)
// against a slow mock streaming server, then checks every other AI entry point + rapid-click git buttons.
// Run: xvfb-run -a node e2e/e2e-043.mjs     (REPRO_ONLY=1 runs just the bug reproduction)
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e043'
const REPO = join(ROOT, 'repo'), REM = join(ROOT, 'remote.git'), DATA = join(ROOT, 'data'), shots = process.env.SHOTS_DIR || join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [REPO, DATA, shots]) mkdirSync(d, { recursive: true })
const sh = (c, cwd = REPO) => { const r = spawnSync('bash', ['-c', c], { cwd, encoding: 'utf8' }); if (r.status) throw new Error(`${c}\n${r.stderr}`); return r.stdout.trim() }
sh(`git init -q --bare -b main ${REM}`, ROOT)
sh('git init -q -b main && git config user.email e@e.com && git config user.name E')
sh('printf "a\\n" > a.txt && git add . && git commit -qm "c1-alpha: 初始化"')
sh('printf "b\\n" >> a.txt && git add . && git commit -qm "c2-beta: 增加 b"')
sh('printf "c\\n" >> a.txt && printf "x\\n" > x.txt && git add . && git commit -qm "c3-gamma: 增加 c 和 x"')
sh(`git remote add origin ${REM} && git push -q -u origin main`)
sh('printf "work\\n" >> a.txt && printf "s\\n" > s.txt && git add s.txt')   // one unstaged, one staged change

// ---- slow streaming mock (OpenAI-compatible). Every request gets a distinct marker so overlapping streams are visible.
const reqs = []          // { n, kind, aborted, done }
let failNext = 0
const kindOf = (body) => {
  const all = JSON.stringify(body.messages ?? [])
  for (const k of ['c1-alpha', 'c2-beta', 'c3-gamma']) if (all.includes(k)) return k
  if (all.includes('只回复两个字')) return 'test'
  if (all.includes('s.txt')) return 'staged'
  return 'other'
}
const server = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
    if (req.url.endsWith('/models')) { setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-pro' }] })) }, 300); reqs.push({ n: reqs.length + 1, kind: 'models' }); return }
    const body = JSON.parse(d)
    const r = { n: reqs.length + 1, kind: kindOf(body), aborted: false, done: false }
    reqs.push(r)
    if (failNext > 0) { failNext--; r.done = true; res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } })) }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.on('close', () => { if (!r.done) r.aborted = true })
    const chunks = r.kind === 'test' ? ['你', '好'] : Array.from({ length: 24 }, (_, i) => i === 0 ? `## 请求 #${r.n}\n\n` : `第 ${i} 段：这次提交调整了 a.txt 的内容（#${r.n}）。\n\n`)
    let i = 0
    const tick = () => {
      if (r.aborted) return
      if (i >= chunks.length) { r.done = true; res.write('data: [DONE]\n\n'); return res.end() }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`)
      setTimeout(tick, 45)
    }
    setTimeout(tick, 250)
  })
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const base = `http://127.0.0.1:${server.address().port}/v1`
const count = (kind) => reqs.filter((r) => r.kind === kind).length

writeFileSync(join(DATA, 'gitloom.json'), JSON.stringify({
  settings: {
    theme: 'dark', diffMode: 'split', graphLimit: 200, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 2, aiEnvForHooks: false, fontSize: 13, concurrency: 4,
    ai: { baseUrl: base, apiKey: 'sk-good', model: 'mock-pro', temperature: 0.2, language: 'zh', commitStyle: 'conventional', profiles: [{ id: 'p-mock', name: 'Mock', preset: 'custom', protocol: 'openai', baseUrl: base, apiKey: 'sk-good', model: 'mock-pro' }], activeProfile: 'p-mock', tasks: {}, fallback: [] }
  },
  workspace: { repos: [REPO], active: REPO, projects: [{ id: 'p', name: 'r', root: REPO, repos: [{ path: REPO, rel: '', kind: 'normal', initialized: true }], hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
}))

const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox', '--disable-gpu'], env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_NO_WATCH: '1' }, timeout: 120000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeout = 15000, what = '') => { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await fn()) return } catch {} await sleep(100) } throw new Error('timeout ' + (what || fn.toString().slice(0, 120))) }
const results = []
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); console.log('✔', name) }
  catch (e) { results.push(['FAIL', name]); console.log('✘', name, (e.message || String(e)).slice(0, 400)); await page.screenshot({ path: join(shots, `fail-${results.length}.png`) }).catch(() => {}) }
}
// per-frame probe: is an AI result surface mounted, its text length, and the top of the files list / diff pane
const probeStart = () => page.evaluate(() => {
  const w = window; w.__probe = []; w.__probeOn = true
  const loop = () => {
    if (!w.__probeOn) return
    const surf = document.querySelector('[data-testid=hx-ai-panel]') || document.querySelector('.history .drawer')
    const txt = document.querySelector('[data-testid=hx-ai-text]') || document.querySelector('.history .drawer-body')
    const files = document.querySelector('.cd-files'), diff = document.querySelector('.cd-diff')
    w.__probe.push({ on: !!surf, len: txt ? txt.textContent.length : -1, filesTop: files ? Math.round(files.getBoundingClientRect().top) : -1, diffTop: diff ? Math.round(diff.getBoundingClientRect().top) : -1, h: surf ? Math.round(surf.getBoundingClientRect().height) : -1 })
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
})
const probeStop = () => page.evaluate(() => { const w = window; w.__probeOn = false; return w.__probe })
const analyse = (p) => {
  let toggles = 0, shrinks = 0
  for (let i = 1; i < p.length; i++) {
    if (p[i].on !== p[i - 1].on) toggles++
    if (p[i].len >= 0 && p[i - 1].len > 0 && p[i].len < p[i - 1].len) shrinks++
  }
  const open = p.filter((x) => x.on)
  return { frames: p.length, toggles, shrinks, filesTops: [...new Set(open.map((x) => x.filesTop))], diffTops: [...new Set(open.map((x) => x.diffTop))], heights: [...new Set(open.map((x) => x.h))] }
}
const commitRow = (s) => page.locator('.commit-row', { hasText: s }).first()
const aiBtn = () => page.locator('.cd-actions button', { hasText: /AI 解释|生成中/ }).first()

await page.locator('.viewtabs .nav-item', { hasText: '历史' }).click({ timeout: 30000 })
await commitRow('c2-beta').click()
await page.locator('.cd-actions').waitFor()

await step('REPRO: 5 rapid clicks on 历史 → AI 解释 start exactly 1 request, no flicker, no layout jump', async () => {
  const box = await aiBtn().boundingBox()
  await probeStart()
  for (let i = 0; i < 5; i++) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(70) }
  await until(() => reqs.filter((r) => r.kind === 'c2-beta').every((r) => r.done || r.aborted), 20000, 'streams finished')
  await sleep(400)
  const a = analyse(await probeStop())
  const n = count('c2-beta')
  console.log('   requests:', n, 'probe:', JSON.stringify(a))
  const errs = []
  if (n !== 1) errs.push(`${n} overlapping requests for one commit`)
  if (a.toggles > 1) errs.push(`result surface mounted/unmounted ${a.toggles} times (flicker)`)
  if (a.shrinks > 0) errs.push(`text went backwards ${a.shrinks} times (streams fighting)`)
  if (a.filesTops.length > 1 || a.diffTops.length > 1) errs.push(`layout moved while streaming: files ${a.filesTops} diff ${a.diffTops}`)
  if (errs.length) throw new Error(errs.join('; '))
})
if (process.env.REPRO_ONLY) { await app.close().catch(() => {}); server.close(); process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0) }

await step('history: done state shows the explanation inline with 重新生成, button is a toggle', async () => {
  const panel = page.locator('[data-testid=hx-ai-panel]')
  await until(async () => (await panel.getAttribute('data-status')) === 'done')
  if (!(await page.locator('[data-testid=hx-ai-text]').textContent()).includes('请求 #')) throw new Error('no text')
  await page.locator('[data-testid=hx-ai-regen]').waitFor()
  await page.screenshot({ path: join(shots, 'history-ai-explain-done.png') })
  await aiBtn().click()                                   // toggle closed
  await panel.waitFor({ state: 'detached' })
  const before = reqs.length
  await aiBtn().click()                                   // reopen → cached, instant
  await until(async () => (await panel.getAttribute('data-status')) === 'done', 1000, 'instant reopen')
  if (reqs.length !== before) throw new Error('reopen re-requested')
})

await step('history: 停止 aborts the stream (server sees the disconnect) and keeps the partial text', async () => {
  await commitRow('c3-gamma').click()
  await until(async () => (await page.locator('[data-testid=hx-ai-panel]').getAttribute('data-status')) === 'idle', 5000, 'idle for uncached commit')
  await page.locator('[data-testid=hx-ai-generate]').click()
  await until(() => count('c3-gamma') === 1)
  await until(async () => ((await page.locator('[data-testid=hx-ai-text]').textContent()) || '').includes('第 2 段'), 8000, 'some text streamed')
  await page.screenshot({ path: join(shots, 'history-ai-explain-loading.png') })
  if (!(await aiBtn().textContent()).includes('生成中')) throw new Error('button not showing 生成中…')
  await page.locator('[data-testid=hx-ai-stop]').click()
  await until(() => reqs.find((r) => r.kind === 'c3-gamma').aborted, 5000, 'server saw abort')
  await until(async () => (await page.locator('[data-testid=hx-ai-panel]').getAttribute('data-status')) === 'stopped', 3000)
  const t1 = await page.locator('[data-testid=hx-ai-text]').textContent()
  await sleep(600)
  if ((await page.locator('[data-testid=hx-ai-text]').textContent()) !== t1) throw new Error('text kept changing after stop')
  if (!t1.includes('第')) throw new Error('partial text lost')
})

await step('history: switching commits cancels the running request; cache hits when coming back', async () => {
  await page.locator('[data-testid=hx-ai-regen]').click()
  await until(() => count('c3-gamma') === 2)
  await commitRow('c1-alpha').click()
  await until(() => reqs.filter((r) => r.kind === 'c3-gamma')[1].aborted, 5000, 'switch aborted the stream')
  // c2-beta is cached from the first step
  const before = reqs.length
  await commitRow('c2-beta').click()
  await until(async () => (await page.locator('[data-testid=hx-ai-panel]').getAttribute('data-status')) === 'done', 2000, 'cache hit')
  await page.locator('[data-testid=hx-ai-cached]').waitFor()
  if (reqs.length !== before) throw new Error('cache miss')
})

await step('history: errors show inline in Chinese with 重试', async () => {
  await commitRow('c1-alpha').click()
  failNext = 1
  await page.locator('[data-testid=hx-ai-generate]').click()
  await until(async () => (await page.locator('[data-testid=hx-ai-panel]').getAttribute('data-status')) === 'error')
  const err = await page.locator('[data-testid=hx-ai-error]').textContent()
  if (!/Key|密钥/.test(err)) throw new Error('error text: ' + err)
  await page.locator('[data-testid=hx-ai-retry]').click()
  await until(async () => (await page.locator('[data-testid=hx-ai-panel]').getAttribute('data-status')) === 'done', 10000)
  if (await page.locator('.toast', { hasText: 'Key' }).count()) throw new Error('error also popped a toast')
})

await step('changes: AI 解释 (diff toolbar) 5x → 1 request, 停止 works', async () => {
  await page.locator('.viewtabs .nav-item', { hasText: '变更' }).click()
  await page.locator('.file-row', { hasText: 'a.txt' }).first().click()
  const before = reqs.length
  const b = page.locator('[data-testid=chg-ai-explain]')
  const box = await b.boundingBox()
  for (let i = 0; i < 5; i++) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(60) }
  await sleep(600)
  if (reqs.length - before !== 1) throw new Error(`${reqs.length - before} requests`)
  await page.locator('[data-testid=ai-drawer-stop]').click()
  await until(() => reqs[reqs.length - 1].aborted, 5000, 'aborted')
  await page.locator('[data-testid=ai-drawer] [aria-label=关闭]').click()
})

await step('commit box: AI 生成 / AI 审查 5x → 1 request each; switching away cancels', async () => {
  let before = reqs.length
  const gen = page.locator('.commit-head button', { hasText: /AI 生成|生成中/ })
  const box = await gen.boundingBox()
  for (let i = 0; i < 5; i++) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(60) }
  await until(() => reqs.length > before)
  await sleep(500)
  if (reqs.length - before !== 1) throw new Error(`AI 生成 sent ${reqs.length - before} requests`)
  await until(async () => (await page.locator('.commit-summary').inputValue()).length > 0, 10000, 'message filled')
  await page.locator('.commit-summary').fill('')
  before = reqs.length
  const rev = page.locator('.commit-head button', { hasText: /AI 审查|审查中/ })
  const rb = await rev.boundingBox()
  for (let i = 0; i < 5; i++) { await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2); await sleep(60) }
  await sleep(500)
  if (reqs.length - before !== 1) throw new Error(`AI 审查 sent ${reqs.length - before} requests`)
  // the drawer stays open while generating (backdrop clicks are ignored); Esc closes it and cancels
  if (!(await page.locator('[data-testid=ai-drawer][data-status=running]').count())) throw new Error('review drawer closed by the repeated clicks')
  await page.keyboard.press('Escape')
  await until(() => reqs[reqs.length - 1].aborted, 5000, 'Esc aborted review')
  // leave the view while AI 生成 is streaming → request is cancelled (unmount)
  before = reqs.length
  await page.locator('[data-testid=cb-ai-gen]').click()
  await until(() => reqs.length > before)
  await page.locator('.viewtabs .nav-item', { hasText: '历史' }).click()
  await until(() => reqs[reqs.length - 1].aborted, 5000, 'unmount aborted AI 生成')
})

await step('AI 助手 chat: Ctrl+Enter 5x → 1 request, 停止 aborts', async () => {
  await page.locator('.viewtabs [role=tab]', { hasText: 'AI 助手' }).first().click()
  const box = page.locator('.ai-chat-input textarea')
  await box.fill('解释一下')
  const before = reqs.length
  for (let i = 0; i < 5; i++) { await box.press('Control+Enter'); await sleep(40) }
  await sleep(500)
  if (reqs.length - before !== 1) throw new Error(`${reqs.length - before} chat requests`)
  await page.locator('[data-testid=ai-chat-stop]').click()
  await until(() => reqs[reqs.length - 1].aborted, 5000, 'chat aborted')
  await until(async () => !(await page.locator('[data-testid=ai-streaming]').count()), 3000)
})

await step('settings: 测试连接 / 获取模型 5x → 1 request each', async () => {
  await page.keyboard.press('Control+,')
  await page.locator('[data-testid=ai-settings]').scrollIntoViewIfNeeded()
  let before = reqs.length
  const t = page.locator('[data-testid=ai-test]'); const tb = await t.boundingBox()
  for (let i = 0; i < 5; i++) { await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2); await sleep(40) }
  await page.locator('[data-testid=ai-test-result].ok').waitFor()
  if (reqs.length - before !== 1) throw new Error(`测试连接 sent ${reqs.length - before}`)
  before = reqs.length
  const m = page.locator('[data-testid=ai-fetch-models]'); const mb = await m.boundingBox()
  for (let i = 0; i < 5; i++) { await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2); await sleep(40) }
  await page.locator('[data-testid=ai-models-info]').waitFor()
  await sleep(400)
  if (reqs.length - before !== 1) throw new Error(`获取模型 sent ${reqs.length - before}`)
})

await step('git: 抓取 5x → 1 fetch; Ctrl+Enter 5x → exactly 1 commit', async () => {
  await page.keyboard.press('Escape')
  if (!(await page.locator('.viewtabs .nav-item', { hasText: '变更' }).count())) await page.locator('.tree [data-row]').first().click()
  await page.locator('.viewtabs .nav-item', { hasText: '变更' }).click()
  const fetchLog = async () => (await page.evaluate(() => window.api.commandLog())).filter((e) => e.args.includes('fetch'))
  const seen = new Set((await fetchLog()).map((e) => e.id))
  const fb = await page.locator('.topbar .sync-group button', { hasText: '抓取' }).boundingBox()
  for (let i = 0; i < 5; i++) await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2)
  await sleep(1500)
  const runs = (await fetchLog()).filter((e) => !seen.has(e.id)).sort((a, b) => a.at - b.at)
  if (!runs.length) throw new Error('no fetch ran')
  for (let i = 1; i < runs.length; i++) if (runs[i].at < runs[i - 1].at + runs[i - 1].ms) throw new Error(`overlapping git fetch runs: ${JSON.stringify(runs.map((r) => [r.at, r.ms]))}`)
  console.log(`   抓取 x5 → ${runs.length} fetch run(s), none overlapping`)
  const c0 = Number(sh('git rev-list --count HEAD'))
  await page.locator('.commit-summary').fill('test: 只提交一次')
  for (let i = 0; i < 5; i++) { await page.locator('.commit-summary').press('Control+Enter'); await sleep(20) }
  await until(() => Number(sh('git rev-list --count HEAD')) > c0)
  await sleep(1200)
  const c1 = Number(sh('git rev-list --count HEAD'))
  if (c1 - c0 !== 1) throw new Error(`${c1 - c0} commits created`)
})

await app.close().catch(() => {})
server.close()
const failed = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - failed.length}/${results.length} 0.4.3 e2e steps passed`)
process.exit(failed.length ? 1 : 0)
