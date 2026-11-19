// e2e 0.6.8+ critical paths: workspace todos/bulk/scope, conflict wizard, understand strip,
// knowledge export/stale chrome, quality hero+labels, automation strip+templates, DeepSeek seed (settings).
// Run: npm run build && xvfb-run -a node e2e/e2e-068-paths.mjs
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { makeHub, makeTsService, makePy } from '../scripts/viz-fixtures.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e068'
const DATA = join(ROOT, 'data'), SAVE = join(ROOT, 'saved'), shots = join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [DATA, SAVE, shots]) mkdirSync(d, { recursive: true })

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@test', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@test', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd, ...a) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'advice.detachedHead=false', ...a], { cwd, encoding: 'utf8', env: gitEnv }).trim()

function mkConflictRepo(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'hello.ts'), 'export const v = 1\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init')
  git(dir, 'checkout', '-qb', 'feature')
  writeFileSync(join(dir, 'hello.ts'), 'export const v = 2 // feature\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'feature change')
  git(dir, 'checkout', '-q', 'main')
  writeFileSync(join(dir, 'hello.ts'), 'export const v = 3 // main\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'main change')
  try { git(dir, 'merge', '--no-ff', '--no-edit', 'feature') } catch { /* expected conflict */ }
  if (!existsSync(join(dir, '.git', 'MERGE_HEAD'))) {
    // ensure conflict markers present
    writeFileSync(join(dir, 'hello.ts'), '<<<<<<< HEAD\nexport const v = 3\n=======\nexport const v = 2\n>>>>>>> feature\n')
  }
  return dir
}

const PROJ = join(ROOT, 'proj')
const SHOP = makeHub(join(PROJ, 'apps', 'web-shop'))
const TS = makeTsService(join(PROJ, 'services', 'ts-service'))
const PY = makePy(join(PROJ, 'services', 'py-worker'))
const CONFLICT = mkConflictRepo(join(PROJ, 'apps', 'conflict-demo'))
// dirty sibling for 今日待办
writeFileSync(join(SHOP, 'wip-e2e.ts'), 'export const wip = true\n')

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
  settings: { theme: 'dark', diffMode: 'split', graphLimit: 200, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 3, aiEnvForHooks: false, fontSize: 13, concurrency: 4, ai: AI },
  workspace: {
    repos: [TS, PY, SHOP, CONFLICT],
    active: CONFLICT,
    projects: [{
      id: 'p', name: 'gitloom-demo', root: PROJ,
      repos: [
        repoEntry(TS, 'services/ts-service'),
        repoEntry(PY, 'services/py-worker'),
        repoEntry(SHOP, 'apps/web-shop'),
        repoEntry(CONFLICT, 'apps/conflict-demo')
      ],
      hidden: []
    }],
    activeProject: 'p', pinned: [], recent: []
  }
}))

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', '--no-sandbox', '--disable-gpu'],
  env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_NO_WATCH: '1', GITLOOM_SAVE_DIR: SAVE },
  timeout: 120000
})
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|DevTools|Autofill|ResizeObserver/.test(m.text())) pageErrors.push('console: ' + m.text().slice(0, 300)) })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeout = 25000, what = '') => {
  const end = Date.now() + timeout; let last
  while (Date.now() < end) { try { last = await fn(); if (last) return last } catch (e) { last = e.message }; await sleep(120) }
  throw new Error('timeout ' + (what || fn.toString().slice(0, 140)) + ' last=' + JSON.stringify(last)?.slice(0, 200))
}
const results = []
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); console.log('✔', name) }
  catch (e) { results.push(['FAIL', name]); console.log('✘', name, (e.message || String(e)).slice(0, 700)); await page.screenshot({ path: join(shots, `fail-${results.length}.png`) }).catch(() => {}); await page.keyboard.press('Escape').catch(() => {}) }
}
const tid = (id) => page.locator(`[data-testid=${id}]`)
const mod = (id) => page.locator(`.modbar [data-module=${id}]`)
const on = async (id) => until(async () => (await mod(id).getAttribute('aria-selected')) === 'true', 8000, `module ${id}`)
const setActive = async (p) => { await page.evaluate((x) => window.__gitloomSetActive && window.__gitloomSetActive(x), p); await sleep(900) }
const menuItem = (t) => page.locator('.ctx-menu .ctx-item', { hasText: t })

await sleep(2000)

await step('工作区: 概览 今日待办 + secondaries 概览|跨仓变更|仓库与扫描', async () => {
  await mod('workspace').click(); await on('workspace')
  await until(async () => (await page.locator('.dt-row, [data-testid=dcard]').count()) >= 3, 30000, 'dash rows')
  await until(async () => (await tid('dash-todos').count()) > 0, 20000, 'todos')
  const todoTxt = await tid('dash-todos').innerText()
  if (!todoTxt.includes('今日待办')) throw new Error(todoTxt.slice(0, 160))
  if ((await page.locator('[data-testid=dash-todos] .todo-card').count()) < 1) throw new Error('no todo cards')
  const tabs = await page.locator('.viewtabs[data-strip=workspace] [role=tab]').allInnerTexts()
  for (const need of ['概览', '跨仓变更', '仓库与扫描']) if (!tabs.some((x) => x.includes(need))) throw new Error('ws tabs: ' + tabs.join('|'))
  await page.locator('.viewtabs [data-view=repos]').click()
  await tid('workspace-repos').waitFor()
  await page.locator('.viewtabs [data-view=dashboard]').click()
})

await step('工作区: 批量抓取 → bulk-sync-summary panel', async () => {
  await mod('workspace').click(); await on('workspace')
  await page.locator('.bulk-bar input[type=checkbox]').first().check({ force: true }).catch(async () => {
    await page.locator('.bulk-bar .chk, .bulk-bar input').first().click({ force: true })
  })
  await page.locator('.bulk-bar button', { hasText: '抓取' }).click()
  await tid('bulk-sync-summary').waitFor({ timeout: 20000 })
  await until(async () => {
    const h = await tid('bulk-sync-counts').innerText().catch(() => '')
    return /\d+\/\d+/.test(h)
  }, 60000, 'bulk counts')
  await tid('bulk-sync-chips').waitFor()
  const title = await tid('bulk-sync-title').innerText()
  if (!/批量同步结果|抓取/.test(title)) throw new Error(title)
})

await step('仓库组 scope: select folder, no right-rail tip', async () => {
  await page.locator('.scope-seg [data-scope=group]').click()
  await until(async () => (await page.locator('.ctx-menu, .menu').count()) > 0, 5000, 'group menu')
  const menuTxt = await page.locator('.ctx-menu, .menu').first().innerText()
  if (!/选择仓库组|文件夹|一组仓库/.test(menuTxt)) throw new Error('menu tip missing: ' + menuTxt.slice(0, 200))
  // tip must live in picker / inline hint — never a full-height right rail
  const rail = await page.locator('.tip-rail, .scope-tip-rail, .right-tip, [data-testid=scope-tip-rail]').count()
  if (rail > 0) throw new Error('right-rail tip present')
  const hintBox = await tid('scope-hint').boundingBox()
  const modBox = await page.locator('.modbar').boundingBox()
  if (!hintBox || !modBox) throw new Error('scope-hint/modbar missing')
  if (hintBox.x < modBox.x - 4 || hintBox.y < modBox.y - 4) throw new Error('scope-hint not in modbar')
  if (hintBox.x > modBox.x + modBox.width * 0.95) throw new Error('scope-hint looks right-railed')
  await menuItem('apps').click().catch(async () => { await menuItem('services').click() })
  await until(async () => (await page.locator('.scope-seg [data-scope=group]').getAttribute('aria-pressed')) === 'true', 8000, 'group pressed')
  await page.locator('.scope-seg [data-scope=project]').click()
})

await step('日常 Git: 变更页 + 冲突向导 (conflicted fixture)', async () => {
  await setActive(CONFLICT)
  await mod('daily').click(); await on('daily')
  await until(async () => (await tid('changes-workspace').count()) > 0 || (await page.locator('.viewtabs [data-view=changes]').getAttribute('aria-selected')) === 'true', 10000, 'changes')
  await page.locator('.viewtabs [data-view=changes]').click().catch(() => {})
  await until(async () => (await tid('conflict-wizard').count()) > 0, 20000, 'conflict wizard')
  const banner = await tid('conflict-wizard-banner').innerText()
  if (!/有冲突|合并|解决/.test(banner)) throw new Error(banner.slice(0, 200))
  await tid('conflict-wizard-files').waitFor()
  if ((await tid('conflict-wizard-files').locator('.cw-file').count()) < 1) throw new Error('no conflict files')
  await tid('conflict-wizard-abort').waitFor()
})

await step('看懂改动: strip 改动摘要|可视化; open-viz; no deep-map/tour', async () => {
  await setActive(TS)
  await mod('understand').click(); await on('understand')
  await tid('understand-strip').waitFor()
  await tid('us-tab-summary').waitFor(); await tid('us-tab-viz').waitFor()
  if (await tid('us-deep-map').count()) throw new Error('us-deep-map')
  if (await tid('us-deep-tour').count()) throw new Error('us-deep-tour')
  await tid('summary-view').waitFor()
  if ((await tid('us-open-viz').count()) !== 1) throw new Error('us-open-viz count')
  await tid('us-open-viz').click(); await on('understand')
  await until(async () => (await page.locator('.viewtabs [data-view=viz]').getAttribute('aria-selected')) === 'true', 10000, 'viz tab')
})

await step('架构与知识: graph-only (no 前/叠加/后); export; C4/Wiki/KG tabs', async () => {
  await mod('knowledge').click(); await on('knowledge')
  await tid('mod-hub-knowledge').waitFor(); await tid('k-sec-tabs').waitFor()
  await tid('k-arch-graph').waitFor()
  await tid('k-arch-export').waitFor()
  const exportTxt = await tid('k-arch-export').innerText()
  if (!/Mermaid|DOT|DSL/.test(exportTxt)) throw new Error('export buttons: ' + exportTxt)
  // wait briefly for analysis; overlay compare chrome must never appear
  await sleep(2500)
  for (const id of ['viz-ov-before', 'viz-ov-both', 'viz-ov-after', 'viz-ov-play']) {
    if ((await tid(id).count()) > 0) throw new Error('diff overlay leaked: ' + id)
  }
  // stale bar is conditional; export is the always-on smoke. If canvas rendered, tip ok.
  const staleOrExport = (await tid('k-arch-stale-bar').count()) + (await tid('k-arch-export').count())
  if (staleOrExport < 1) throw new Error('expected stale bar or export')
  await tid('k-tab-c4').click(); await tid('k-c4').waitFor()
  await tid('k-tab-wiki').click(); await tid('wiki-panel').waitFor()
  await tid('k-tab-graph').click(); await tid('knowledge-graph').waitFor()
  await tid('k-graph-export').waitFor().catch(() => {})
  await on('knowledge')
})

await step('质量把关: hero + 一键体检 CTA + beginner severity labels', async () => {
  await setActive(TS)
  await mod('quality').click(); await on('quality')
  await tid('mod-hub-quality').waitFor()
  await tid('q-hero-steps').waitFor()
  await tid('q-hero-run').waitFor()
  const cta = await tid('q-hero-run').innerText()
  if (!cta.includes('一键体检')) throw new Error(cta)
  await tid('q-report').waitFor()
  await tid('health-run').waitFor()
  // run a quick health check so severity chips (严重/注意/提示) can appear when findings exist;
  // labels are in the filter options even with empty report
  await tid('health-run').click()
  await until(async () => {
    const t = await tid('q-report').innerText()
    if (/正在体检/.test(t)) return false
    // score/conclusions/chips appear when report lands
    return (await tid('q-report').locator('.stat-chip, [data-testid=health-conclusions], .health-score').count()) > 0
      || /分数|发现|干净|通过|暂无问题|健康/.test(t)
  }, 120000, 'health result')
  // open details + filters so PLAIN_SEV options are in DOM even with 0 findings
  if (await tid('health-toggle-details').count()) {
    await tid('health-toggle-details').click().catch(() => {})
    await sleep(200)
  }
  if (await tid('health-filters-toggle').count()) {
    await tid('health-filters-toggle').click().catch(() => {})
    await sleep(200)
  }
  const report = await tid('q-report').innerText()
  const opts = await tid('q-report').locator('select option').allInnerTexts().catch(() => [])
  const chips = await tid('q-report').locator('.stat-chip, .hf-sev').allInnerTexts().catch(() => [])
  const blob = [report, ...opts, ...chips].join('|')
  if (!/严重|注意|提示/.test(blob)) throw new Error('no beginner severity labels: ' + blob.slice(0, 400))
})

await step('自动化: strip 事件触发|钩子|定时任务; no 规划中; AI 创建 + ≥11 templates', async () => {
  await mod('automation').click(); await on('automation')
  await tid('automation-strip').waitFor()
  const labels = await page.locator('[data-testid=automation-strip] [role=tab]').allInnerTexts()
  if (labels.join('|') !== '事件触发|钩子|定时任务') throw new Error(labels.join('|'))
  const stripTxt = await tid('automation-strip').innerText()
  if (stripTxt.includes('规划中')) throw new Error('规划中 on strip')
  await tid('auto-events').waitFor()
  if ((await page.locator('[data-testid=auto-events]').innerText()).includes('规划中')) throw new Error('规划中 on events')
  await tid('auto-tab-tasks').click(); await tid('ai-tasks').waitFor()
  await tid('tasks-ai-create').waitFor()
  await tid('tasks-ai-create').click(); await tid('tasks-ai-modal').waitFor()
  await page.locator('[data-testid=tasks-ai-modal]').locator('button', { hasText: '取消' }).click().catch(async () => {
    await page.locator('.modal-backdrop').first().click({ position: { x: 4, y: 4 } })
  })
  await until(async () => (await tid('tasks-ai-modal').count()) === 0, 8000, 'ai modal closed')
  await tid('tasks-new').click(); await tid('tasks-new-menu').waitFor()
  const items = await tid('tasks-new-menu').locator('[data-testid^=tasks-new-]').count()
  // blank + ≥11 templates
  if (items < 12) throw new Error('template menu items ' + items + ' (need ≥11 templates + blank)')
  await page.keyboard.press('Escape')
})

await step('DeepSeek default: preset reachable in AI settings (seed covered by unit)', async () => {
  // Empty-install DEEPSEEK_AI_SEED is unit-tested in tests/aiDefaults.test.ts.
  // Here: open Settings → AI → 添加服务商 and assert DeepSeek appears in the preset catalog.
  await page.evaluate(() => window.__gitloomSetView && window.__gitloomSetView('settings')).catch(() => {})
  await sleep(400)
  if ((await tid('ai-settings').count()) === 0) {
    await page.keyboard.press('Control+,')
    await sleep(500)
  }
  await tid('ai-settings').waitFor({ timeout: 15000 })
  await tid('ai-add').click()
  await tid('ai-search').waitFor()
  await tid('ai-search').fill('deepseek')
  await until(async () => {
    const body = await page.locator('.prov-picker, .prov-grid, [data-testid=ai-settings], .modal, body').first().innerText()
    return /DeepSeek/i.test(body)
  }, 8000, 'DeepSeek preset')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
})

await step('no page errors', async () => {
  const errs = pageErrors.filter((e) => !/ResizeObserver loop/.test(e))
  if (errs.length) throw new Error(errs.slice(0, 5).join('\n'))
})

const fails = results.filter((r) => r[0] === 'FAIL')
console.log('\n' + results.map((r) => r.join('\t')).join('\n'))
console.log(fails.length ? `\n${fails.length} FAIL` : `\n${results.length} ok`)
await page.screenshot({ path: join(shots, '068-final.png') }).catch(() => {})
await app.close().catch(() => {})
server.close()
process.exit(fails.length ? 1 : 0)
