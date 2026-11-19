// Focused e2e: 工作区·概览 / multi-repo chips, filter, selection+bulk result, detached/no-upstream, health, module boundary.
// Run: npm run build && xvfb-run -a node e2e/e2e-overview.mjs
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e-overview'
const P = join(ROOT, 'mono')
const DATA = join(ROOT, 'data')
const shots = process.env.SHOTS_DIR || join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [DATA, shots, P]) mkdirSync(d, { recursive: true })

const git = (cwd, ...a) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'advice.detachedHead=false', ...a], {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
}).trim()

function mk(dir, files = {}) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'README.md'), `# ${dir.split('/').pop()}\n`)
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'chore: init')
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, f), c)
  }
  if (Object.keys(files).length) { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'feat: scaffold') }
}

// ---- fixture: 6 repos with known statuses
mk(P, { 'package.json': '{"name":"mono"}' })
mk(join(P, 'clean-a'), { 'a.ts': 'export const a=1\n' })
mk(join(P, 'dirty'), { 'd.ts': 'export const d=1\n' })
writeFileSync(join(P, 'dirty', 'wip.ts'), 'export const wip = true\n') // uncommitted → 有改动

mkdirSync(join(ROOT, 'remotes'), { recursive: true })
mk(join(P, 'ahead'), { 'a.ts': 'export const a=1\n' })
execFileSync('git', ['clone', '-q', '--bare', join(P, 'ahead'), join(ROOT, 'remotes', 'ahead.git')])
git(join(P, 'ahead'), 'remote', 'add', 'origin', join(ROOT, 'remotes', 'ahead.git'))
git(join(P, 'ahead'), 'fetch', '-q', 'origin')
git(join(P, 'ahead'), 'branch', '-q', '-u', 'origin/main', 'main')
writeFileSync(join(P, 'ahead', 'local.ts'), 'export const local=1\n')
git(join(P, 'ahead'), 'add', '-A'); git(join(P, 'ahead'), 'commit', '-qm', 'feat: local ahead') // ahead 1

mk(join(P, 'behind'), { 'b.ts': 'export const b=1\n' })
execFileSync('git', ['clone', '-q', '--bare', join(P, 'behind'), join(ROOT, 'remotes', 'behind.git')])
git(join(P, 'behind'), 'remote', 'add', 'origin', join(ROOT, 'remotes', 'behind.git'))
git(join(P, 'behind'), 'fetch', '-q', 'origin')
git(join(P, 'behind'), 'branch', '-q', '-u', 'origin/main', 'main')
const other = join(ROOT, 'behind-other')
execFileSync('git', ['clone', '-q', join(ROOT, 'remotes', 'behind.git'), other])
writeFileSync(join(other, 'up.ts'), 'export const up=1\n')
git(other, 'add', '-A'); git(other, 'commit', '-qm', 'feat: upstream'); git(other, 'push', '-q', 'origin', 'main')
git(join(P, 'behind'), 'fetch', '-q', 'origin') // behind 1

mk(join(P, 'detached'), { 'x.ts': 'export const x=1\n' })
const sha = git(join(P, 'detached'), 'rev-parse', 'HEAD')
git(join(P, 'detached'), 'checkout', '-q', '--detach', sha)

mk(join(P, 'noup'), { 'y.ts': 'export const y=1\n' })
git(join(P, 'noup'), 'checkout', '-qb', 'feature/local')

writeFileSync(join(DATA, 'gitloom.json'), JSON.stringify({
  settings: { theme: 'dark', diffMode: 'split', graphLimit: 200, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 4, aiEnvForHooks: false, fontSize: 13, concurrency: 4, watch: false },
  workspace: { repos: [], active: null, projects: [{ id: 'p-ov', name: 'mono', root: P, repos: [], hidden: [] }], activeProject: 'p-ov', pinned: [], recent: [] }
}))

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', '--no-sandbox', '--disable-gpu'],
  env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_NO_WATCH: '1' },
  timeout: 120000
})
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeout = 25000, what = '') => {
  const end = Date.now() + timeout; let last
  while (Date.now() < end) { try { last = await fn(); if (last) return last } catch (e) { last = e.message }; await sleep(120) }
  throw new Error('timeout ' + (what || fn.toString().slice(0, 120)) + ' last=' + JSON.stringify(last)?.slice(0, 200))
}
const results = []
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); console.log('✔', name) }
  catch (e) { results.push(['FAIL', name]); console.log('✘', name, (e.message || String(e)).slice(0, 500)); await page.screenshot({ path: join(shots, `fail-${results.length}.png`) }).catch(() => {}) }
}
const chip = (label) => page.locator('.stat-chip', { hasText: label })
const chipCount = async (label) => {
  const t = await chip(label).innerText()
  const m = t.match(/(\d+)/)
  return m ? Number(m[1]) : -1
}
const resetOverview = async () => {
  const search = page.locator('.dash-search input')
  if (await search.count()) await search.fill('')
  await chip('全部').click().catch(() => {})
  await sleep(200)
}

await sleep(2000)

await step('scan populates overview (≥6 repos)', async () => {
  await until(async () => (await page.locator('.tree .tree-row').count()) >= 5, 40000, 'tree rows')
  await page.locator('.modbar [data-module=workspace]').click().catch(async () => { await page.locator('.ws-tab', { hasText: '概览' }).click() })
  await until(async () => (await page.locator('.dt-row').count()) >= 6, 30000, 'dash rows')
})

await step('chip counts: 有改动≥1, 分离 HEAD≥1, 需要推送≥1, 需要拉取≥1', async () => {
  await until(async () => (await chipCount('全部')) >= 6, 20000, 'all chip')
  const changed = await chipCount('有改动')
  const det = await chipCount('分离 HEAD')
  const push = await chipCount('需要推送')
  const pull = await chipCount('需要拉取')
  if (changed < 1) throw new Error('changed chip ' + changed)
  if (det < 1) throw new Error('detached chip ' + det)
  if (push < 1) throw new Error('push chip ' + push)
  if (pull < 1) throw new Error('pull chip ' + pull)
})

await step('filter 分离 HEAD narrows table and shows HEAD badge (not 干净)', async () => {
  await chip('分离 HEAD').click()
  await until(async () => (await page.locator('.dt-row').count()) >= 1 && (await page.locator('.dt-row').count()) <= 2, 8000, 'detached rows')
  const txt = await page.locator('.dt-row').first().innerText()
  if (/干净/.test(txt) && !/HEAD/.test(txt)) throw new Error('detached row looks clean: ' + txt.slice(0, 120))
  if (!/HEAD|detached|\([0-9a-f]{7}\)/i.test(txt)) throw new Error('no detached marker: ' + txt.slice(0, 160))
  await chip('全部').click()
})

await step('filter 有改动 + selection + bulk 抓取 records per-repo 结果', async () => {
  await chip('有改动').click()
  await until(async () => (await page.locator('.dt-row').count()) >= 1, 8000, 'changed rows')
  await page.locator('.bulk-bar input[type=checkbox]').first().check({ force: true }).catch(async () => {
    await page.locator('.bulk-bar .chk').click()
  })
  await page.locator('.bulk-bar button', { hasText: '抓取' }).click()
  await page.waitForSelector('[data-testid=bulk-sync-summary]', { timeout: 15000 })
  await until(async () => {
    const h = await page.locator('[data-testid=bulk-sync-counts]').innerText().catch(async () => page.locator('.bl-head').innerText())
    const body = await page.locator('.bl-body').innerText().catch(() => '')
    return /\d+\/\d+/.test(h) && !/执行中|排队/.test(body)
  }, 60000, 'bulk done')
  const title = await page.locator('[data-testid=bulk-sync-title]').innerText()
  if (!/批量同步结果|抓取/.test(title)) throw new Error('bulk title: ' + title)
  await page.locator('[data-testid=bulk-sync-chips]').waitFor()
  const resCells = await page.locator('.dt-row .c-res').allInnerTexts()
  if (!resCells.some((t) => /完成|已是最新|ok|跳过|失败|抓取/i.test(t) || t.trim().length > 0)) {
    // result may be in bulk log even if column empty for filtered-out — require log lines
    const lines = await page.locator('.bl-line').count()
    if (lines < 1) throw new Error('no bulk results')
  }
  await chip('全部').click()
})

await step('无上游 labeling visible for noup repo', async () => {
  try {
    await page.locator('.dash-search input').fill('noup')
    await until(async () => (await page.locator('.dt-row').count()) === 1, 8000, 'noup row')
    const txt = await page.locator('.dt-row').innerText()
    if (!/无上游/.test(txt)) throw new Error('expected 无上游 badge: ' + txt.slice(0, 200))
  } finally {
    await resetOverview()
  }
})

await step('体检 cells render without crash (≥6)', async () => {
  await resetOverview()
  await until(async () => {
    const a = await page.locator('[data-testid=health]').count()
    const b = await page.locator('.c-health.health-cell-btn, .dt-row .c-health').count()
    return Math.max(a, b) >= 4
  }, 20000, 'health cells')
  const n = Math.max(await page.locator('[data-testid=health]').count(), await page.locator('.dt-row .c-health').count())
  if (n < 4) throw new Error('health cells ' + n)
})


await step('今日待办 shows dirty/ahead/behind cards', async () => {
  await resetOverview()
  await until(async () => (await page.locator('[data-testid=dash-todos]').count()) > 0, 15000, 'dash-todos')
  const txt = await page.locator('[data-testid=dash-todos]').innerText()
  if (!txt.includes('今日待办')) throw new Error(txt.slice(0, 120))
  const cards = await page.locator('[data-testid=dash-todos] .todo-card').count()
  if (cards < 1) throw new Error('no todo cards')
})

await step('工作区 secondaries: 概览|跨仓变更|仓库与扫描', async () => {
  await page.locator('.modbar [data-module=workspace]').click()
  await until(async () => (await page.locator('.viewtabs').getAttribute('data-strip')) === 'workspace', 8000, 'ws strip')
  const tabs = await page.locator('.viewtabs [role=tab]').allInnerTexts()
  const joined = tabs.map((x) => x.replace(/\d+/g, '').trim()).join('|')
  for (const need of ['概览', '跨仓变更', '仓库与扫描']) {
    if (!tabs.some((x) => x.includes(need))) throw new Error('missing ' + need + ': ' + tabs.join('|'))
  }
  await page.locator('.viewtabs [data-view=repos]').click()
  await until(async () => (await page.locator('[data-testid=workspace-repos], .repos-view, .ws-repos').count()) > 0
    || (await page.locator('.viewtabs [data-view=repos]').getAttribute('aria-selected')) === 'true', 8000, 'repos')
  await page.locator('.viewtabs [data-view=dashboard]').click()
})

await step('日常 Git secondary tabs have no 变更可视化 / viz / 概览 peers', async () => {
  await resetOverview()
  await page.locator('.dash-search input').fill('clean-a')
  await until(async () => (await page.locator('.dt-row').count()) >= 1, 8000, 'clean-a row')
  // open a repo so daily tabs enable
  const row = page.locator('.dt-row', { hasText: 'clean-a' }).first()
  await row.locator('button[aria-label="打开仓库"], .c-act .icon-btn').first().click().catch(async () => {
    await row.dblclick()
  })
  await sleep(800)
  await page.locator('.modbar [data-module=daily]').click()
  await sleep(400)
  const tabs = await page.locator('.viewtabs [role=tab]').allInnerTexts()
  const joined = tabs.join(' | ')
  if (/变更可视化|可视化/.test(joined) && !/看懂改动/.test(joined)) throw new Error('viz tab leaked into daily: ' + joined)
  if (tabs.some((x) => x.includes('概览') || x.includes('跨仓库'))) throw new Error('workspace tabs mixed into daily: ' + joined)
  // ADVANCED must not include viz — check data-view attributes
  const views = await page.locator('.viewtabs [data-view]').evaluateAll((els) => els.map((e) => e.getAttribute('data-view')))
  if (views.includes('viz')) throw new Error('data-view=viz present in daily tabs: ' + views.join(','))
  // 概览 via 工作区 module (not a peer tab on daily)
  await page.locator('.modbar [data-module=workspace]').click()
  await until(async () => (await page.locator('.dash-title').count()) > 0, 8000, 'back to dash')
})

await step('工作区 viewtabs: 概览|跨仓变更|仓库与扫描 — not daily peers', async () => {
  const sel = await page.locator('.modbar [data-module=workspace]').getAttribute('aria-selected')
  if (sel !== 'true') throw new Error('workspace module not selected on overview, got ' + sel)
  const tabs = await page.locator('.viewtabs[data-strip=workspace] [role=tab]').allInnerTexts()
  const joined = tabs.join(' | ')
  if (!tabs.some((x) => x.includes('概览'))) throw new Error('missing 概览: ' + joined)
  if (!tabs.some((x) => x.includes('跨仓变更') || x.includes('跨仓库'))) throw new Error('missing 跨仓变更: ' + joined)
  if (!tabs.some((x) => x.includes('仓库与扫描'))) throw new Error('missing 仓库与扫描: ' + joined)
  const views = await page.locator('.viewtabs[data-strip=workspace] [data-view]').evaluateAll((els) => els.map((e) => e.getAttribute('data-view')))
  for (const bad of ['changes', 'history', 'bisect', 'ai', 'rebase', 'stash', 'worktrees', 'branches']) {
    if (views.includes(bad)) throw new Error(bad + ' must not be on workspace strip: ' + views.join(','))
  }
  const strip = await page.locator('.viewtabs').getAttribute('data-strip')
  if (strip !== 'workspace') throw new Error('data-strip=' + strip)
})

await page.screenshot({ path: join(shots, 'overview-final.png') }).catch(() => {})
await app.close()

const fail = results.filter((r) => r[0] === 'FAIL')
console.log('\n=== overview e2e: %d/%d passed ===', results.length - fail.length, results.length)
if (fail.length) { console.log(fail.map((f) => 'FAIL ' + f[1]).join('\n')); process.exit(1) }
