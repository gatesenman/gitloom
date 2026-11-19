// End-to-end UI test: drives the real Electron app with Playwright against demo repos + a mock
// OpenAI-compatible server.  Run: xvfb-run -a node e2e/e2e.mjs
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { createRequire } from 'module'
import path from 'path'

const require = createRequire(import.meta.url)
const ROOT = '/tmp/gitloom-e2e'
const shots = process.env.E2E_SHOTS ?? path.join(ROOT, 'shots')
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
const results = []
const step = async (name, fn) => {
  const t = Date.now()
  try { await fn(); results.push(['PASS', name, Date.now() - t]); console.log('✔', name) }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('✘', name, e.message); await page?.screenshot({ path: path.join(shots, `fail-${results.length}.png`) }).catch(() => {}) }
}

// ---- mock AI
const calls = []
const server = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
    const body = JSON.parse(d); calls.push(body)
    const sys = body.messages[0].content
    let content = 'feat(app): 新增登录入口与副标题\n\n- App 中渲染 SubHeader 与 Login'
    if (sys.includes('审查')) content = '## 总结\n改动合理。\n## 问题\n- 🟢 无严重问题'
    if (sys.includes('分支名')) content = 'feature/dark-settings\nfeature/settings-theme'
    if (sys.includes('项目文档维护者')) content = '- mock：本次提交的 AI 摘要'
    if (sys.includes('JSON')) content = '{"commands":["git log --oneline -n 3"],"explanation":"查看最近 3 个提交"}'
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/v1`

// ---- fixtures
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })
execFileSync('bash', ['scripts/make-demo-repos.sh', ROOT, 'docs/hooks/llmwiki-post-commit.sh'], { stdio: 'ignore' })
const W = `${ROOT}/workspace/webapp`, X = `${ROOT}/workspace/conflict-demo`
const data = `${ROOT}/data`; mkdirSync(data, { recursive: true })
writeFileSync(`${data}/gitloom.json`, JSON.stringify({
  settings: { theme: 'dark', ai: { baseUrl: base, apiKey: 'sk-e2e', model: 'mock-model', temperature: 0.2, language: 'zh', commitStyle: 'conventional' }, diffMode: 'split', graphLimit: 800, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 3, aiEnvForHooks: true, fontSize: 13 },
  workspace: { repos: [W, X], active: W }
}))

const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox'], env: { ...process.env, GITLOOM_DATA_DIR: data } })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
// CSP forbids eval, so poll with page.evaluate instead of page.waitForFunction
const waitFn = async (fn, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await page.evaluate(fn).catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)) }
  throw new Error('timeout waiting for ' + fn.toString().slice(0, 120))
}
const fileRow = (name) => page.locator('.file-row', { hasText: name }).first()

await step('app boots with multi-repo sidebar', async () => {
  await page.waitForSelector('.repo-item')
  const n = await page.locator('.repo-item').count()
  if (n !== 2) throw new Error(`expected 2 repos, got ${n}`)
  await page.waitForSelector('.file-row')
})
await step('window icon / title', async () => {
  const t = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
  if (!t.includes('GitLoom')) throw new Error(t)
})
await step('select file shows Monaco side-by-side diff', async () => {
  await fileRow('README.md').click()
  await page.waitForSelector('.monaco-diff-editor')
  await page.waitForSelector('.monaco-diff-editor .editor.original')
})
await step('stage whole file by double-click', async () => {
  await fileRow('README.md').dblclick()
  await waitFn(() => [...document.querySelectorAll('.file-section')].some((s) => s.textContent.includes('已暂存') && s.textContent.includes('README.md')))
  if (!git(W, 'diff', '--cached', '--name-only').includes('README.md')) throw new Error('not staged in git')
})
await step('stage a single hunk from the hunk panel', async () => {
  await fileRow('Login.tsx').click()
  await page.getByRole('tab', { name: '分块暂存' }).click()
  await page.getByRole('button', { name: '暂存此块' }).first().click()
  await waitFn(() => [...document.querySelectorAll('.file-section')].some((s) => s.textContent.includes('已暂存') && s.textContent.includes('Login.tsx')))
  if (!git(W, 'diff', '--cached', '--name-only').includes('src/pages/Login.tsx')) throw new Error('hunk not staged')
  await page.getByRole('tab', { name: '对比视图' }).click()
})
await step('AI commit message generation (OpenAI-compatible mock)', async () => {
  await page.getByRole('button', { name: 'AI 生成' }).click()
  await waitFn(() => document.querySelector('.commit-summary').value.startsWith('feat(app)'))
  const last = calls[calls.length - 1]
  if (last.model !== 'mock-model' || !last.messages[1].content.includes('README.md')) throw new Error('bad AI request')
})
await step('commit via UI runs llmwiki post-commit hook', async () => {
  await page.locator('.commit-actions .btn-primary').click()
  await waitFn(() => document.querySelector('.commit-summary').value === '')
  const subj = git(W, 'log', '-1', '--format=%s')
  if (subj !== 'feat(app): 新增登录入口与副标题') throw new Error(subj)
  if (!existsSync(`${W}/docs/llmwiki/index.md`)) throw new Error('llmwiki index missing')
  for (let i = 0; i < 40 && !readFileSync(`${W}/docs/llmwiki/changelog.md`, 'utf8').includes('AI 摘要'); i++) await new Promise((r) => setTimeout(r, 250))
  if (!readFileSync(`${W}/docs/llmwiki/changelog.md`, 'utf8').includes('mock：本次提交的 AI 摘要')) throw new Error('AI summary not appended')
})
await step('amend last commit', async () => {
  await page.locator('.commit-opts-wrap > button').click()
  await page.locator('.commit-opts-pop label', { hasText: '修改上次提交' }).click()
  await page.keyboard.press('Escape')
  await waitFn(() => document.querySelector('.commit-summary').value.startsWith('feat(app)'))
  await page.locator('.commit-summary').fill('feat(app): 新增登录入口（amend）')
  await page.locator('.commit-actions .btn-primary').click()
  await waitFn(() => document.querySelector('.commit-summary').value === '')
  if (git(W, 'log', '-1', '--format=%s') !== 'feat(app): 新增登录入口（amend）') throw new Error('amend failed')
})
await step('graph view renders commit rows + detail diff', async () => {
  await page.locator('.viewtabs .nav-item', { hasText: '历史' }).click()
  await page.locator('.history .seg button', { hasText: '提交图' }).click()
  await page.waitForSelector('.commit-row')
  const n = await page.locator('.commit-row').count()
  if (n < 10) throw new Error(`rows ${n}`)
  await page.locator('.commit-row').nth(2).click()
  await page.waitForSelector('.commit-detail .monaco-diff-editor')
})
await step('create branch via dialog (with AI name suggestion)', async () => {
  await page.locator('.viewtabs .nav-item', { hasText: '分支' }).click()
  await page.locator('.subnav button', { hasText: '分支与标签' }).click()
  await page.getByRole('button', { name: '新建分支' }).click()
  await page.locator('.modal input').nth(1).fill('设置页暗色主题')
  await page.getByRole('button', { name: 'AI 建议分支名' }).click()
  await page.locator('.modal .chip', { hasText: 'feature/dark-settings' }).click()
  await page.locator('.modal button[type=submit]').click()
  await waitFn(() => document.querySelector('.branch-chip')?.textContent.includes('feature/dark-settings'))
  if (git(W, 'branch', '--show-current') !== 'feature/dark-settings') throw new Error('not switched')
})
await step('switch branch back to main from list', async () => {
  await page.locator('tr', { hasText: 'main' }).filter({ hasNotText: 'feature' }).first().getByRole('button', { name: '切换' }).click()
  await waitFn(() => document.querySelector('.branch-chip')?.textContent.includes('main'))
})
await step('create worktree and open it in workspace', async () => {
  await page.locator('.viewtabs .nav-item', { hasText: '分支' }).click()
  await page.locator('.subnav button', { hasText: '工作树' }).click()
  await page.getByRole('button', { name: '新建工作树' }).click()
  await page.locator('.modal input').first().fill('feature/wt-e2e')
  await page.locator('.modal button[type=submit]').click()
  await waitFn(() => document.querySelectorAll('.repo-item').length === 3)
  if (!git(W, 'worktree', 'list').includes('feature/wt-e2e')) throw new Error('worktree missing')
})
await step('remove worktree', async () => {
  await page.locator('.viewtabs .nav-item', { hasText: '分支' }).click()
  await page.locator('.subnav button', { hasText: '工作树' }).click()
  await page.locator('.wt-card', { hasText: 'feature/wt-e2e' }).getByRole('button', { name: '移除' }).click()
  await page.locator('.modal button[type=submit]').click()
  await waitFn(() => ![...document.querySelectorAll('.wt-card')].some((c) => c.textContent.includes('feature/wt-e2e')))
  if (git(W, 'worktree', 'list').includes('wt-e2e')) throw new Error('still listed')
})
await step('install conventional commit-msg hook from template', async () => {
  await page.locator('.repo-item', { hasText: 'webapp' }).first().click()
  await page.locator('.topbar button[aria-label="更多操作"]').click()
  await page.locator('.ctx-item', { hasText: 'Git 钩子' }).click()
  await page.locator('.tpl', { hasText: '约定式提交校验' }).getByRole('button', { name: '安装' }).click()
  await waitFn(() => [...document.querySelectorAll('.hook-item')].some((h) => h.textContent.includes('commit-msg') && h.textContent.includes('已启用')))
  if (!existsSync(`${W}/.git/hooks/commit-msg`)) throw new Error('hook file missing')
})
await step('disable hook with toggle', async () => {
  await page.locator('.hook-item', { hasText: 'commit-msg' }).locator('.switch span').click()
  await waitFn(() => [...document.querySelectorAll('.hook-item')].some((h) => h.textContent.includes('commit-msg') && h.textContent.includes('已禁用')))
  if (!existsSync(`${W}/.git/hooks/commit-msg.disabled`)) throw new Error('not disabled')
})
await step('stash push / pop', async () => {
  await page.keyboard.press('Control+3') // back from 设置 → Git 钩子 to the repo view (分支 tab)
  await page.locator('.viewtabs .nav-item', { hasText: '分支' }).click()
  await page.locator('.subnav button', { hasText: '储藏' }).click()
  await page.getByRole('button', { name: '储藏改动' }).click()
  await page.locator('.modal input').first().fill('e2e stash')
  await page.locator('.modal button[type=submit]').click()
  await page.locator('.list-item', { hasText: 'e2e stash' }).click()
  await page.waitForSelector('.monaco-diff-editor')
  await page.getByRole('button', { name: '弹出（pop）' }).click()
  await waitFn(() => ![...document.querySelectorAll('.list-item')].some((c) => c.textContent.includes('e2e stash')))
})
await step('AI natural language → git command and run it', async () => {
  await page.locator('.viewtabs [role=tab]', { hasText: 'AI 助手' }).first().click()
  await page.locator('button', { hasText: '快捷工具' }).click()
  await page.locator('.ai-tool textarea').fill('看看最近三个提交')
  await page.getByRole('button', { name: '生成命令' }).click()
  await page.locator('.cmd-row').getByRole('button', { name: '执行' }).click()
  await page.locator('.modal button[type=submit]').click()
  await waitFn(() => document.querySelector('.cmd-out')?.textContent.includes('amend'))
})
await step('resolve merge conflict (theirs) and continue', async () => {
  await page.locator('.repo-item', { hasText: 'conflict-demo' }).click()
  await page.waitForSelector('.op-banner')
  await page.locator('.viewtabs .nav-item', { hasText: '变更' }).click()
  await page.getByRole('button', { name: '采用对方（theirs）' }).click()
  await waitFn(() => !document.querySelector('.op-banner button.btn-primary')?.disabled)
  await page.locator('.op-banner').getByRole('button', { name: '继续' }).click()
  await waitFn(() => !document.querySelector('.op-banner'))
  if (git(X, 'log', '-1', '--format=%p').split(' ').length !== 2) throw new Error('no merge commit')
})
await step('button layout: sync group, one overflow menu, files/diff/commit toolbars', async () => {
  const r = await page.evaluate(() => ({
    loose: document.querySelectorAll('.topbar > .icon-btn:not(.top-more)').length,
    sync: [...document.querySelectorAll('.topbar .sync-group button')].map((b) => b.textContent.trim()),
    untitled: [...document.querySelectorAll('.icon-btn')].filter((b) => !b.getAttribute('title') && !b.closest('.win-controls')).length
  }))
  if (r.loose) throw new Error('loose topbar icon buttons: ' + r.loose)
  if (!['抓取', '拉取', '推送'].every((t, i) => (r.sync[i] || '').startsWith(t))) throw new Error('sync group ' + r.sync)
  if (r.untitled) throw new Error(r.untitled + ' icon-only buttons without tooltip')
  await page.locator('.files-toolbar button', { hasText: '全部暂存' }).waitFor({ timeout: 3000 })
  await page.locator('.commit-head button', { hasText: 'AI 生成' }).waitFor({ timeout: 3000 })
})
await step('theme toggle (light)', async () => {
  await page.locator('.topbar button[aria-label="更多操作"]').click()
  await page.locator('.ctx-item', { hasText: '切换到浅色主题' }).click()
  await waitFn(() => document.documentElement.dataset.theme === 'light')
})
await page.screenshot({ path: path.join(shots, 'e2e-final.png') })
await app.close()
server.close()
const failed = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - failed.length}/${results.length} e2e steps passed`)
writeFileSync(path.join(ROOT, 'e2e-results.json'), JSON.stringify(results, null, 2))
process.exit(failed.length ? 1 : 0)
