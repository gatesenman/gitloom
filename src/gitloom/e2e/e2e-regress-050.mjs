// 0.5.0 full-app regression for the parts the other suites only touch lightly: every tab and every 更多 item renders
// without page errors, sync against a real (bare) remote (fetch / pull / commit / push), interactive rebase that
// actually squashes, bisect to the first bad commit, file trace blame contents, submodules update, every settings
// section, multi-repo switching, and the 变更可视化 entry after all of that.
// Run: xvfb-run -a node e2e/e2e-regress-050.mjs
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-reg050'
rmSync(ROOT, { recursive: true, force: true })
const DATA = join(ROOT, 'data'), PROJ = join(ROOT, 'proj'), shots = join(ROOT, 'shots')
for (const d of [DATA, PROJ, shots]) mkdirSync(d, { recursive: true })
const sh = (cwd, c) => { const r = spawnSync('bash', ['-c', c], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' } }); if (r.status) throw new Error(`${c}\n${r.stderr}`); return r.stdout.trim() }
const cfg = 'git config user.email r@gitloom.dev && git config user.name Reg && git config commit.gpgsign false && git config protocol.file.allow always'

// library used as a submodule
const LIB = join(ROOT, 'lib'); mkdirSync(LIB)
sh(LIB, `git init -q -b main && ${cfg} && echo 'export const v = 1' > index.ts && git add -A && git commit -qm lib1`)
// bare remote + app with 6 commits; bug introduced in c4
const BARE = join(ROOT, 'remote.git'); sh(ROOT, `git init -q --bare -b main ${BARE}`)
const APP = join(PROJ, 'app'); mkdirSync(APP)
sh(APP, `git init -q -b main && ${cfg} && git remote add origin ${BARE}`)
for (let i = 1; i <= 6; i++) sh(APP, `echo "line ${i}${i >= 4 ? ' bug' : ''}" >> calc.txt && echo "step ${i}" > step.txt && git add -A && git commit -qm "c${i}: 第 ${i} 步"`)
sh(APP, `git submodule add -q ${LIB} vendor/lib && git commit -qm "chore: add lib submodule"`)
sh(APP, 'git push -q -u origin main')
// a teammate pushes one commit we have to pull
const MATE = join(ROOT, 'mate'); sh(ROOT, `git clone -q ${BARE} mate`); sh(MATE, `${cfg} && echo teammate > mate.txt && git add -A && git commit -qm "feat: 同事的提交" && git push -q`)
// a second repo for multi-repo switching
const SVC = join(PROJ, 'svc'); mkdirSync(SVC); sh(SVC, `git init -q -b main && ${cfg} && echo a > a.txt && git add -A && git commit -qm s1 && echo b >> a.txt`)
// lib in the submodule itself gets a new commit so 'update --remote' style checks have something to show
sh(LIB, 'echo "export const w = 2" >> index.ts && git commit -qam lib2')

writeFileSync(join(DATA, 'gitloom.json'), JSON.stringify({
  settings: { theme: 'dark', diffMode: 'split', graphLimit: 200, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 2, aiEnvForHooks: false, fontSize: 13, concurrency: 4, ai: { baseUrl: '', apiKey: '', model: '', temperature: 0.2, language: 'zh', commitStyle: 'conventional', profiles: [], tasks: {}, fallback: [] } },
  workspace: { repos: [APP, SVC], active: APP, projects: [{ id: 'p', name: 'reg', root: PROJ, repos: [{ path: APP, rel: 'app', kind: 'normal', initialized: true }, { path: SVC, rel: 'svc', kind: 'normal', initialized: true }], hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
}))

const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox', '--disable-gpu'], env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_NO_WATCH: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' }, timeout: 120000 })
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|DevTools|Autofill/.test(m.text())) pageErrors.push('console: ' + m.text().slice(0, 300)) })
await page.waitForTimeout(3500)

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 15000, what = 'condition') => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await sleep(150) } throw new Error('timeout: ' + what) }
const step = async (name, fn) => {
  const e0 = pageErrors.length
  try { await fn(); if (pageErrors.length > e0) throw new Error('page errors: ' + pageErrors.slice(e0).join(' | ').slice(0, 400)); results.push(['ok', name]); console.log('✔', name) }
  catch (e) { results.push(['FAIL', name]); console.log('✘', name, String(e.message || e).slice(0, 600)); await page.screenshot({ path: join(shots, `fail-${results.length}.png`) }).catch(() => {}); await page.keyboard.press('Escape').catch(() => {}) }
}
const tab = async (label) => { await page.locator('.viewtabs [role=tab]').filter({ hasText: new RegExp('^\\s*' + label) }).first().click(); await sleep(500) }
const more = async (label) => { await page.locator('.viewtabs [role="tab"]', { hasText: label }).first().click(); await sleep(500) }
const crashed = async () => (await page.locator('[data-testid=view-crash]').count()) > 0
const setActive = async (p) => { await page.evaluate((x) => window.__gitloomSetActive(x), p); await sleep(900) }
const log = (cwd, n = 1) => sh(cwd, `git log -${n} --format=%s`)
const dismissIntro = async () => { const b = page.locator('.view-intro button', { hasText: '知道了' }); if (await b.count()) await b.first().click() }

await step('every primary tab renders (no crash, no page error)', async () => {
  await page.locator('.viewtabs').waitFor({ timeout: 20000 })
  const tabs = await page.$$eval('.viewtabs [role=tab]', (els) => els.map((e) => e.textContent.trim().replace(/\d+$/, '')))
  for (const t of tabs.filter((x) => !x.includes('更多'))) { await tab(t.replace(/\s.*/, '')); if (await crashed()) throw new Error('crash in ' + t) }
})

await step('every flat advanced tab renders, incl. 子模块 (repo has one); no 可视化 in 日常', async () => {
  const items = await page.$$eval('.viewtabs [role=tab]', (els) => els.map((e) => e.textContent.trim()))
  for (const want of ['整理提交', '二分查错', '文件追溯', '子模块', 'PR 与 Issue', 'AI 助手']) if (!items.some((x) => x.includes(want))) throw new Error('missing ' + want + ' in ' + items)
  if (items.some((x) => x.includes('可视化'))) throw new Error('可视化 must not be in 日常 Git: ' + items)
  for (const want of ['整理提交', '二分查错', '文件追溯', '子模块', 'PR 与 Issue', 'AI 助手']) { await more(want); await sleep(400); if (await crashed()) throw new Error('crash in ' + want) }
})

await step('sync: 抓取 → 拉取 brings the teammate commit (fast-forward)', async () => {
  await tab('变更')
  await page.locator('.sync-group button', { hasText: '抓取' }).click()
  await until(async () => (await page.locator('.sync-group button', { hasText: '拉取' }).innerText()).match(/1/), 15000, 'behind badge')
  await page.locator('.sync-group button', { hasText: '拉取' }).click()
  await until(() => log(APP) === 'feat: 同事的提交', 15000, 'pulled')
})

await step('commit via the commit box, then 推送 reaches the remote', async () => {
  writeFileSync(join(APP, 'feature.txt'), 'new feature\n')
  await page.locator('.sync-group button', { hasText: '抓取' }).click(); await sleep(800)
  await tab('变更')
  await page.locator('.file-row', { hasText: 'feature.txt' }).first().dblclick()
  await page.locator('.commit-summary').fill('feat: 新功能')
  await page.locator('.commit-actions .btn-primary').click()
  await until(() => log(APP) === 'feat: 新功能', 15000, 'committed')
  await page.locator('.sync-group button', { hasText: '推送' }).click()
  await until(() => sh(BARE, 'git log -1 --format=%s main') === 'feat: 新功能', 15000, 'pushed')
})

await step('rebase: squash c5 into c4 really rewrites history', async () => {
  // work on a throw-away branch so main stays in sync with the remote
  sh(APP, 'git checkout -q -b tidy HEAD~3'); await sleep(300)
  await more('整理提交'); await dismissIntro()
  await page.locator('input[placeholder*="main"]').fill('HEAD~3')
  await page.locator('button', { hasText: '生成计划' }).click()
  await page.waitForSelector('.rebase-row', { timeout: 15000 })
  const rows = page.locator('.rebase-row')
  if ((await rows.count()) !== 3) throw new Error('rows ' + (await rows.count()))
  await rows.nth(1).locator('select').selectOption('fixup')
  await page.locator('button', { hasText: '开始变基' }).click()
  const ok = page.locator('.dialog button.btn-primary, .modal button.btn-primary'); await sleep(500); if (await ok.count()) await ok.first().click()
  // tidy = main~3 = c6 (6 commits); fixup c5 into c4 → 5
  await until(() => sh(APP, 'git rev-list --count HEAD') === '5', 20000, 'history rewritten')
  if (sh(APP, 'git log --format=%s -3').includes('c5')) throw new Error('c5 still present')
})

await step('bisect: finds c4 as the first bad commit', async () => {
  sh(APP, 'git checkout -q main'); await sleep(300)
  await more('二分查错'); await dismissIntro()
  const c1 = sh(APP, 'git log --format=%H --grep "^c1:"')
  await page.locator('input[placeholder="HEAD / SHA"]').fill(sh(APP, 'git log --format=%H --grep "^c6:"'))
  await page.locator('input[placeholder*="已知好的"]').fill(c1)
  await page.locator('.view-body button', { hasText: '开始' }).click()
  for (let i = 0; i < 6; i++) {
    await sleep(700)
    const body = await page.locator('.view-body').innerText()
    if (/c4: 第 4 步/.test(body) && /(第一个坏|罪魁|is the first bad|找到)/.test(body)) break
    const bad = readFileSync(join(APP, 'calc.txt'), 'utf8').includes('bug')
    await page.locator('.view-body button', { hasText: bad ? '坏的' : '好的' }).click()
  }
  const body = await page.locator('.view-body').innerText()
  if (!/c4: 第 4 步/.test(body)) throw new Error('bisect result: ' + body.slice(0, 300))
  await page.locator('.view-body button', { hasText: '重置' }).click()
  await page.locator('.modal button[type=submit]').click(); await sleep(1000)
  if (sh(APP, 'git rev-parse --abbrev-ref HEAD') !== 'main') throw new Error('not back on main')
})

await step('file trace: blame shows the author and each line', async () => {
  await more('文件追溯'); await dismissIntro()
  await page.locator('input[placeholder*="文件路径"]').fill('calc.txt')
  await page.locator('button', { hasText: '查看' }).click()
  await page.waitForSelector('.blame-view, .file-hist-row', { timeout: 15000 })
  const t = await page.locator('.view-body').innerText()
  if (!t.includes('Reg') || !t.includes('line 6 bug')) throw new Error('blame: ' + t.slice(0, 200))
})

await step('submodules: listed, update runs without error', async () => {
  await more('子模块'); await dismissIntro()
  await page.locator('.view-body', { hasText: 'vendor/lib' }).waitFor({ timeout: 10000 })
  await page.locator('.view-body button', { hasText: 'Update' }).click(); await sleep(1500)
  const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.textContent))
  if (toasts.some((x) => /失败|error|fatal/i.test(x))) throw new Error('toast: ' + toasts)
})

await step('PR 与 Issue: inline token setup; AI 助手 without AI shows setup', async () => {
  // origin is a local bare repo here → the view explains that it needs a GitHub / GitLab remote (no crash, no toast)
  await more('PR 与 Issue'); await page.locator('.view-body', { hasText: '未识别到 GitHub / GitLab 远程' }).waitFor({ timeout: 10000 })
  await more('AI 助手'); await sleep(500)
  if (await crashed()) throw new Error('AI view crashed')
})

await step('settings: every section opens (通用 / AI 模型 / Git 钩子)', async () => {
  await page.keyboard.press('Control+,'); await sleep(500)
  const tabs = await page.$$eval('.settings-tabs [role=tab]', (els) => els.map((e) => e.textContent.trim()))
  if (tabs.length < 2) throw new Error('settings tabs ' + tabs)
  for (const t of tabs) { await page.locator('.settings-tabs [role=tab]', { hasText: t }).click(); await sleep(400); if (await crashed()) throw new Error('crash in ' + t) }
  await page.locator('.settings-tabs [role=tab]', { hasText: 'Git 钩子' }).click()
  await page.locator('text=commit-msg').first().waitFor({ timeout: 8000 })
  await page.keyboard.press('Control+1'); await sleep(400)
})

await step('multi-repo: switch to svc, its change shows, back to app', async () => {
  await setActive(SVC); await tab('变更')
  await page.locator('.file-row', { hasText: 'a.txt' }).first().waitFor({ timeout: 10000 })
  await setActive(APP); await tab('历史')
  await page.locator('.commit-row', { hasText: 'feat: 新功能' }).first().waitFor({ timeout: 10000 })
})

await step('branches / stash / worktrees sections still work', async () => {
  await tab('分支')
  for (const s of ['储藏', '工作树', '分支与标签']) { await page.locator('.subnav button', { hasText: s }).click(); await sleep(300); if (await crashed()) throw new Error(s) }
  await page.locator('.view-body', { hasText: 'tidy' }).first().waitFor({ timeout: 8000 })
})

await step('变更可视化 via 看懂改动 (not 日常): commit scope renders a diagram (no AI → setup card)', async () => {
  await page.locator('.modbar .mod-tab', { hasText: '看懂改动' }).click(); await sleep(500)
  const deep = page.locator('[data-testid=us-open-viz]')
  if (await deep.count()) await deep.click()
  else await page.evaluate(() => { window.__gitloomSetView && window.__gitloomSetView('viz') })
  await sleep(400)
  await until(async () => (await page.locator('[data-testid=viz-summary]').count()) > 0, 30000, 'viz summary')
  await page.locator('[data-testid=viz-tab-modules]').click(); await sleep(800)
  if (await crashed()) throw new Error('viz crashed')
  await page.locator('[data-testid=viz-ai]').click(); await sleep(400)
  await page.locator('[data-testid=viz-ai-setup]').waitFor({ timeout: 5000 })
  await page.screenshot({ path: join(shots, 'viz-on-regress-repo.png') })
})

await step('no uncaught page errors during the whole run', async () => { if (pageErrors.length) throw new Error(pageErrors.join(' | ').slice(0, 600)) })

const fails = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - fails.length}/${results.length} regression steps passed`)
await app.close()
process.exit(fails.length ? 1 : 0)
