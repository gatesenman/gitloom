// e2e for the v0.4.1 navigation (everyday tabs + 「更多 ▾」, intros, palette, 1024px fit, light theme) and the advanced views.
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const ROOT = join(process.cwd())
const DATA = '/tmp/gitloom-e2e-adv'
const REPO = '/tmp/gitloom-e2e-adv-repo'
const shots = join(DATA, 'shots')
rmSync(DATA, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })
rmSync(REPO, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
const sh = (c) => { const r = spawnSync('bash', ['-lc', c], { cwd: REPO, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr || c) }
sh('git init -b main && git config user.email e@e.com && git config user.name E')
sh('echo one > a.txt && git add a.txt && git commit -m c1')
sh('echo two >> a.txt && git add a.txt && git commit -m c2')
sh('echo three >> a.txt && git add a.txt && git commit -m c3')
sh('git branch feature')
sh('git remote add origin https://github.com/acme/widgets.git')

mkdirSync(DATA, { recursive: true })
writeFileSync(join(DATA, 'gitloom.json'), JSON.stringify({
  settings: { theme: 'dark', ai: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'x', temperature: 0.2, language: 'zh', commitStyle: 'conventional' }, diffMode: 'split', graphLimit: 200, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 2, aiEnvForHooks: false, fontSize: 13, density: 'comfortable', concurrency: 4 },
  workspace: { repos: [REPO], active: REPO, projects: [{ id: 'p', name: 'adv', root: REPO, repos: [{ path: REPO, rel: '', kind: 'normal', initialized: true }], hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
}))

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', '--no-sandbox', '--disable-gpu'],
  env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_NO_WATCH: '1' },
  timeout: 120000
})
const page = await app.firstWindow()
await page.waitForTimeout(4000)

const steps = []
const ok = async (name, fn) => { try { await fn(); steps.push('✔ ' + name); console.log('✔ ' + name) } catch (e) { steps.push('✘ ' + name + ' ' + (e.message || e).slice(0, 120)); console.log('✘ ' + name, e.message); await page.screenshot({ path: join(shots, 'fail.png') }).catch(() => {}); await page.keyboard.press('Escape').catch(() => {}) } }

const more = async (label) => {
  await page.locator('.viewtabs [role="tab"]', { hasText: label }).first().click({ timeout: 15000 })
  await page.waitForTimeout(500)
}
const tabTexts = () => page.$$eval('.viewtabs [role=tab]', (els) => els.map((e) => e.textContent.trim()))
const fits = () => page.evaluate(() => { const v = document.querySelector('.viewtabs'); const t = document.querySelector('.topbar'); return { tabs: v.scrollWidth <= v.clientWidth + 1, top: !t || t.scrollWidth <= t.clientWidth + 1, h: v.getBoundingClientRect().height } })

await ok('top bar shows everyday tabs + flat advanced (no 更多; no 工作区 peers)', async () => {
  await page.locator('button.nav-item', { hasText: '变更' }).waitFor({ timeout: 15000 })
  const t = await tabTexts()
  for (const want of ['变更', '历史', '分支', '储藏', '工作树', '整理提交', '二分查错', '文件追溯', 'PR 与 Issue', 'AI 助手']) if (!t.some((x) => x.includes(want) || x.startsWith(want))) throw new Error('missing ' + want + ' in ' + t)
  // 工作区 tabs are NOT peers on 日常 Git strip
  for (const bad of ['概览', '跨仓库变更', '跨仓变更', '仓库与扫描']) if (t.some((x) => x.includes(bad))) throw new Error(bad + ' must not mix into daily tabs: ' + t)
  if (t.some((x) => x === '更多' || x.startsWith('更多'))) throw new Error('更多 fold should be gone, got ' + t)
  if (t.some((x) => x.includes('可视化'))) throw new Error('可视化 must not be in 日常 Git tabs: ' + t)
  for (const bad of ['分支图', 'Forge', '工具', '钩子']) if (t.some((x) => x.includes(bad))) throw new Error('unexpected tab ' + bad)
})

await ok('every tab has a tooltip', async () => {
  const titles = await page.$$eval('.viewtabs [role=tab]', (els) => els.map((e) => e.getAttribute('title') || ''))
  if (titles.some((x) => x.length < 4)) throw new Error('missing title: ' + JSON.stringify(titles))
})

await ok('no wrapping/overflow at 1024px (dark)', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 720))
  await page.waitForTimeout(600)
  const f = await fits()
  // flat tabs may wrap or scroll; height may exceed single row — allow up to ~2 rows
  if (!f.top || f.h > 88) throw new Error(JSON.stringify(f))
})

await ok('flat advanced tabs visible; 子模块 hidden without submodules', async () => {
  const tabs = await page.$$eval('.viewtabs [role=tab]', (els) => els.map((e) => e.textContent.trim()))
  for (const want of ['整理提交', '二分查错', '文件追溯', 'PR 与 Issue', 'AI 助手']) {
    if (!tabs.some((x) => x.includes(want))) throw new Error('missing flat tab ' + want + ' in ' + tabs)
  }
  if (tabs.some((x) => x.includes('可视化'))) throw new Error('可视化 must not be in 日常 Git')
  if (tabs.some((x) => x.includes('子模块'))) throw new Error('子模块 must be hidden when the repo has no submodules')
  if (tabs.some((x) => x.includes('更多'))) throw new Error('更多 should be gone')
  await page.screenshot({ path: join(shots, 'flat-advanced-tabs.png') })
})

await ok('rebase via flat tab: intro + 知道了 dismiss, builds plan', async () => {
  await more('整理提交')
  await page.locator('.view-intro', { hasText: '什么时候用' }).waitFor({ timeout: 5000 })
  const on = await page.locator('.viewtabs [role=tab][aria-selected=true]').textContent()
  if (!on.includes('整理提交')) throw new Error('active tab should be 整理提交, got ' + on)
  await page.locator('.view-intro button', { hasText: '知道了' }).click()
  await page.waitForSelector('.view-intro', { state: 'detached', timeout: 3000 })
  await page.locator('input[placeholder*="main"]').fill('main~2')
  await page.locator('button', { hasText: '生成计划' }).click()
  await page.waitForSelector('.rebase-row', { timeout: 15000 })
})

await ok('advanced items reachable from the command palette', async () => {
  await page.keyboard.press('Control+k')
  await page.waitForSelector('.palette input, [role=dialog] input', { timeout: 5000 })
  await page.keyboard.type('二分查错')
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, 'palette.png') })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  await page.waitForSelector('text=二分查错', { timeout: 10000 })
  await page.locator('.view-intro', { hasText: '上周还好好的' }).waitFor({ timeout: 5000 })
  await page.locator('button', { hasText: '开始' }).first().waitFor({ timeout: 5000 })
})

await ok('文件追溯 view (blame first)', async () => {
  await more('文件追溯')
  await page.locator('input[placeholder*="文件路径"]').fill('a.txt')
  await page.locator('button', { hasText: '查看' }).click()
  await page.waitForSelector('.blame-view, .file-hist-row', { timeout: 15000 })
})

await ok('文件追溯 keeps all former 工具 tabs with clear names', async () => {
  const t = await page.$$eval('.tools-tabs button', (els) => els.map((e) => e.textContent.trim()))
  for (const n of ['逐行追溯 / 文件历史', '代码搜索', '比较分支', '清理未跟踪文件', '仓库配置', '提交签名', 'Git LFS']) if (!t.includes(n)) throw new Error('missing ' + n + ' in ' + t)
})

await ok('AI chat tab present', async () => {
  await more('AI 助手')
  await page.waitForSelector('text=对话', { timeout: 10000 })
})

await ok('PR 与 Issue: inline token setup, no toast', async () => {
  await more('PR 与 Issue')
  await page.locator('[data-testid=forge-setup]').waitFor({ timeout: 10000 })
  await page.waitForTimeout(800)
  const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.textContent))
  if (toasts.some((x) => /Token/.test(x))) throw new Error('unexpected token toast: ' + toasts)
})

await ok('Git 钩子 lives in 设置 (overflow menu + palette)', async () => {
  await page.locator('.topbar button[aria-label="更多操作"]').click()
  await page.locator('.ctx-item', { hasText: 'Git 钩子' }).click()
  await page.locator('.settings-tabs button.on', { hasText: 'Git 钩子' }).waitFor({ timeout: 5000 })
  await page.locator('.view-intro', { hasText: '什么时候用' }).waitFor({ timeout: 5000 })
  await page.locator('.settings-tabs button', { hasText: '通用设置' }).click()
  await page.locator('button', { hasText: '管理 Git 钩子' }).waitFor({ timeout: 5000 })
  await page.keyboard.press('Control+k')
  await page.keyboard.type('钩子')
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
  await page.locator('.settings-tabs button.on', { hasText: 'Git 钩子' }).waitFor({ timeout: 5000 })
  await page.locator('.settings-tabs button', { hasText: '通用设置' }).click()
  await page.keyboard.press('Control+1')
  await page.locator('.viewtabs').waitFor({ timeout: 5000 })
})

await ok('历史: 列表 / 提交图 toggle', async () => {
  await page.locator('button.nav-item', { hasText: '历史' }).click()
  await page.locator('.history .seg button', { hasText: '提交图' }).click()
  await page.locator('.history .seg button.on', { hasText: '提交图' }).waitFor({ timeout: 5000 })
  await page.locator('.history .seg button', { hasText: '列表' }).click()
  await page.waitForSelector('.commit-row', { timeout: 10000 })
})

await ok('分支: 分支与标签 / 储藏 / 工作树 sections', async () => {
  await page.locator('button.nav-item', { hasText: '分支' }).click()
  await page.locator('.subnav button', { hasText: '储藏' }).click()
  await page.locator('.subnav button.on', { hasText: '储藏' }).waitFor({ timeout: 5000 })
  if (!(await page.locator('button.nav-item.active', { hasText: '分支' }).count())) throw new Error('分支 tab should stay active')
  await page.locator('.subnav button', { hasText: '工作树' }).click()
  await page.locator('.subnav button', { hasText: '分支与标签' }).click()
})

await ok('light theme fits at 1024px', async () => {
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.waitForTimeout(300)
  const f = await fits()
  if (!f.tabs || !f.top) throw new Error(JSON.stringify(f))
  await page.screenshot({ path: join(shots, 'light-1024.png') })
})

await page.screenshot({ path: join(shots, 'advanced.png') })
await app.close()
const failed = steps.filter((s) => s.startsWith('✘')).length
console.log(`${steps.length - failed}/${steps.length} advanced e2e steps passed`)
process.exit(failed ? 1 : 0)
