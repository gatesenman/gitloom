// End-to-end UI test for multi-repo projects: drives the real Electron app against the complex
// nested fixture (≥25 repos). Run: xvfb-run -a node e2e/e2e-multi.mjs
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { createRequire } from 'module'
import path from 'path'

const require = createRequire(import.meta.url)
const ROOT = '/tmp/gitloom-e2e-multi'
const P = `${ROOT}/mono`
const shots = process.env.E2E_SHOTS ?? path.join(ROOT, 'shots')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
const results = []
let page
const step = async (name, fn) => {
  const t = Date.now()
  try { await fn(); results.push(['PASS', name, Date.now() - t]); console.log('✔', name) }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('✘', name, e.message); await page?.screenshot({ path: path.join(shots, `multi-fail-${results.length}.png`) }).catch(() => {}) }
}

// ---- mock AI
const server = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'chore(billing): 记录进行中的改动' } }] }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/v1`

// ---- fixture
rmSync(ROOT, { recursive: true, force: true })
execFileSync('bash', ['scripts/make-complex-fixture.sh', ROOT], { stdio: 'ignore' })
mkdirSync(shots, { recursive: true })
const data = `${ROOT}/data`; mkdirSync(data, { recursive: true })
writeFileSync(`${data}/gitloom.json`, JSON.stringify({
  settings: { theme: 'dark', ai: { baseUrl: base, apiKey: 'sk-e2e', model: 'mock-model', temperature: 0.2, language: 'zh', commitStyle: 'conventional' }, diffMode: 'split', graphLimit: 800, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 6, aiEnvForHooks: true, fontSize: 13, concurrency: 6, watch: true },
  workspace: { repos: [], active: null, projects: [{ id: 'p-mono', name: 'mono', root: P, repos: [], hidden: [] }], activeProject: 'p-mono', pinned: [], recent: [] }
}))

const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox'], env: { ...process.env, GITLOOM_DATA_DIR: data } })
page = await app.firstWindow()
page.setDefaultTimeout(20000)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960))
const waitFn = async (fn, timeout = 20000, arg) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await page.evaluate(fn, arg).catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)) }
  throw new Error('timeout waiting for ' + fn.toString().slice(0, 140))
}
const row = (text) => page.locator('.tree [data-row]', { hasText: text }).first()
const rowTexts = () => page.evaluate(() => [...document.querySelectorAll('.tree [data-row]')].map((e) => e.textContent))

await step('background scan populates the project tree (≥25 repos)', async () => {
  await waitFn(() => document.querySelectorAll('.tree .tree-row').length > 15, 30000)
  await waitFn(() => /2[5-9] 个仓库|[3-9]\d 个仓库/.test(document.querySelector('.side-foot')?.textContent ?? ''))
})
await step('tree mirrors folders, compacts chains, hides ignored repos', async () => {
  const t = (await rowTexts()).join('\n')
  if (!t.includes('experiments/2024/q3/')) throw new Error('compact chain missing')
  if (t.includes('left-pad')) throw new Error('node_modules repo must be skipped')
  if (!(await page.locator('.tree .tree-row.uninit', { hasText: 'extra' }).count())) throw new Error('uninitialized submodule not shown')
  if (!t.includes('web-hotfix')) throw new Error('outside worktree missing (should hang under apps/web)')
})
await step('rolled-up badges on folders (conflict under libs, detached under services)', async () => {
  await waitFn(() => [...document.querySelectorAll('.tree .folder-item')].some((e) => e.textContent.includes('libs') && e.querySelector('.bdg-conf')), 20000)
  await waitFn(() => [...document.querySelectorAll('.tree .folder-item')].some((e) => e.textContent.includes('services') && e.querySelector('.bdg-det')))
})
await step('keyboard navigation: arrows + type-ahead + Enter opens folder dashboard', async () => {
  await page.locator('.tree').focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('serv')
  await waitFn(() => document.querySelector('.tree .cursor')?.textContent.includes('services'))
  await page.keyboard.press('Enter')
  await waitFn(() => document.querySelector('.dash-title h2')?.textContent === 'services')
  const n = await page.locator('.dt-row').count()
  if (n !== 4) throw new Error(`services dashboard should list 4 repos, got ${n}`)
})
await step('filter box: fuzzy filter by name keeps ancestors', async () => {
  await page.locator('.sidebar .side-search input').fill('billing')
  await waitFn(() => { const r = [...document.querySelectorAll('.tree .repo-item')].map((e) => e.textContent); return r.length >= 1 && r.every((x) => x.includes('billing') || x.includes('mono')) })
  await page.locator('.sidebar .side-search input').fill('hotfix/outside')
  await waitFn(() => [...document.querySelectorAll('.tree .repo-item')].some((e) => e.textContent.includes('web-hotfix')))
  await page.locator('.sidebar .side-search input').fill('')
})
await step('view modes: grouped by status + flat list', async () => {
  await page.locator('.side-tools .seg button', { hasText: '状态' }).click()
  for (const g of ['冲突', '有改动', '需要推送', '需要拉取', '干净']) await waitFn((g) => [...document.querySelectorAll('.tree-section')].some((e) => e.textContent.includes(g)), 8000, g)
  await page.screenshot({ path: path.join(shots, 'multi-status.png') })
  await page.locator('.side-tools .seg button', { hasText: '列表' }).click()
  await waitFn(() => [...document.querySelectorAll('.tree-section')].some((e) => e.textContent.includes('全部仓库')))
  await page.locator('.side-tools .seg button', { hasText: '树' }).click()
  await waitFn(() => document.querySelectorAll('.tree .folder-item').length > 3)
})
await step('dashboard: bulk fetch all repos concurrently with per-repo results', async () => {
  await page.locator('.modbar [data-module=workspace]').click().catch(async () => { await page.locator('.ws-tab', { hasText: '概览' }).click() })
  await page.locator('.crumbs .crumb-proj').click()
  await page.locator('.ctx-item', { hasText: '项目概览' }).click()
  await waitFn(() => document.querySelector('.dash-title h2')?.textContent === 'mono')
  await page.locator('.bulk-bar button', { hasText: '抓取' }).click()
  await page.waitForSelector('.bulk-log')
  await waitFn(() => /2[4-9]\/2[4-9]/.test(document.querySelector('.bl-head')?.textContent ?? ''), 60000)
  const ok = await page.locator('.bl-line.r-ok').count()
  if (ok < 20) throw new Error(`expected ≥20 successful fetches, got ${ok}`)
  await page.screenshot({ path: path.join(shots, 'multi-dashboard-fetch.png') })
})
await step('dashboard: status filter chip (冲突) narrows to the conflicted repo', async () => {
  await page.locator('.stat-chip', { hasText: '冲突' }).click()
  await waitFn(() => document.querySelectorAll('.dt-row').length === 1 && document.querySelector('.dt-row').textContent.includes('components'))
  await page.locator('.stat-chip', { hasText: '全部' }).click()
})
await step('dashboard: create branch across selected repos, then undo via toast', async () => {
  await page.locator('.dash-search input').fill('utils')
  await waitFn(() => document.querySelectorAll('.dt-row').length === 1)
  await page.locator('.dt-row').first().click()
  await page.locator('.dash-search input').fill('core')
  await waitFn(() => document.querySelectorAll('.dt-row').length >= 1)
  await page.locator('.dt-row', { hasText: 'libs/core' }).first().click()
  await page.locator('.dash-search input').fill('')
  await waitFn(() => /已选\s*2/.test(document.querySelector('.bulk-target')?.textContent ?? ''))
  await page.locator('.bulk-bar button', { hasText: '新建分支' }).click()
  await page.locator('.modal input').first().fill('feature/e2e-multi')
  await page.locator('.modal button[type=submit]').click()
  await waitFn(() => /2\/2/.test(document.querySelector('.bl-head')?.textContent ?? '') && !!document.querySelector('.toast-action'))
  for (const r of ['libs/utils', 'libs/core']) if (git(`${P}/${r}`, 'branch', '--show-current') !== 'feature/e2e-multi') throw new Error(`${r} not switched`)
  await page.locator('.toast-action', { hasText: '撤销' }).first().click()
  await waitFn(() => true)
  const end = Date.now() + 10000
  while (Date.now() < end && git(`${P}/libs/core`, 'branch', '--show-current') !== 'main') await new Promise((r) => setTimeout(r, 200))
  for (const r of ['libs/utils', 'libs/core']) if (git(`${P}/${r}`, 'branch', '--show-current') !== 'main') throw new Error(`${r} undo failed`)
})
await step('cross-repo changes: grouped by repo, stage, AI message per repo, commit + undo', async () => {
  await page.locator('.ws-tab', { hasText: '跨仓变更' }).click()
  await waitFn(() => document.querySelectorAll('.xg').length >= 3, 20000)
  const g = page.locator('.xg', { hasText: 'billing' })
  await g.locator('.xg-head button[aria-label="暂存全部"]').click()
  await waitFn(() => [...document.querySelectorAll('.xg')].some((e) => e.textContent.includes('billing') && e.querySelector('.xg-count')?.textContent === '2/2'))
  await g.getByRole('button', { name: 'AI 生成' }).click()
  await waitFn(() => [...document.querySelectorAll('.xg textarea')].some((t) => t.value.includes('chore(billing)')))
  await page.screenshot({ path: path.join(shots, 'multi-cross.png') })
  await g.getByRole('button', { name: /提交到/ }).click()
  await waitFn(() => !!document.querySelector('.toast-action'))
  if (!git(`${P}/services/billing`, 'log', '-1', '--format=%s').includes('chore(billing)')) throw new Error('commit missing')
  await page.locator('.toast-action', { hasText: '撤销提交' }).first().click()
  const end = Date.now() + 8000
  while (Date.now() < end && git(`${P}/services/billing`, 'log', '-1', '--format=%s').includes('chore(billing)')) await new Promise((r) => setTimeout(r, 200))
  if (git(`${P}/services/billing`, 'log', '-1', '--format=%s').includes('chore(billing)')) throw new Error('undo commit failed')
})
await step('quick open (Ctrl+P) jumps to a deep repo and reveals it in the tree', async () => {
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.palette-repos')
  await page.keyboard.type('native')
  await page.keyboard.press('Enter')
  await waitFn(() => document.querySelector('.crumbs .top-repo-name')?.textContent === 'native')
  await waitFn(() => document.querySelector('.tree .tree-row.active')?.textContent.includes('native'))
})
await step('command palette: collapse all / expand all', async () => {
  await page.keyboard.press('Control+k')
  await page.keyboard.type('全部折叠')
  await page.keyboard.press('Enter')
  await waitFn(() => document.querySelectorAll('.tree .folder-item').length <= 12)
  await page.keyboard.press('Control+k')
  await page.keyboard.type('全部展开')
  await page.keyboard.press('Enter')
  await waitFn(() => document.querySelectorAll('.tree .tree-row').length > 20)
})
await step('fs watcher picks up a newly created repo (debounced incremental rescan)', async () => {
  execFileSync('git', ['init', '-q', `${P}/apps/new-e2e`])
  await waitFn(() => [...document.querySelectorAll('.tree .repo-item')].some((e) => e.textContent.includes('new-e2e')), 15000)
})
await step('hide repo from context menu + undo toast; pin repo', async () => {
  await row('admin').click({ button: 'right' })
  await page.locator('.ctx-item', { hasText: '在树中隐藏' }).click()
  await waitFn(() => ![...document.querySelectorAll('.tree .repo-item')].some((e) => e.textContent.includes('admin')))
  await page.locator('.toast-action', { hasText: '撤销' }).first().click()
  await waitFn(() => [...document.querySelectorAll('.tree .repo-item')].some((e) => e.textContent.includes('admin')))
  await row('api').click({ button: 'right' })
  await page.locator('.ctx-item', { hasText: '固定到顶部' }).click()
  await waitFn(() => [...document.querySelectorAll('.tree-section')].some((e) => e.textContent.includes('已固定')))
})
await step('density toggle → compact', async () => {
  await page.locator('.topbar button[aria-label="更多操作"]').click()
  await page.locator('.ctx-item', { hasText: /切换为(紧凑|舒适)密度/ }).click()
  await waitFn(() => document.documentElement.dataset.density === 'compact')
})
await page.screenshot({ path: path.join(shots, 'multi-final.png') })
await app.close()
server.close()
const failed = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - failed.length}/${results.length} multi-repo e2e steps passed`)
writeFileSync(path.join(ROOT, 'e2e-results.json'), JSON.stringify(results, null, 2))
process.exit(failed.length ? 1 : 0)
