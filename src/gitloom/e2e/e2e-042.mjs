// e2e for GitLoom 0.4.2: AI provider settings (picker → key → 获取模型 → 测试连接 → encrypted save) against a
// mock OpenAI-compatible server, sidebar 「只看有改动」, Changes keys (j/k/s/u) + commit-message history, overview
// 一键同步 with plain-Chinese failure explanations.  Run: xvfb-run -a node e2e/e2e-042.mjs
import { _electron as electron } from 'playwright-core'
import http from 'http'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-e2e042'
const P = join(ROOT, 'proj'), REM = join(ROOT, 'remotes'), DATA = join(ROOT, 'data'), shots = join(ROOT, 'shots')
rmSync(ROOT, { recursive: true, force: true })
for (const d of [P, REM, DATA, shots]) mkdirSync(d, { recursive: true })
const sh = (cwd, c) => { const r = spawnSync('bash', ['-c', c], { cwd, encoding: 'utf8' }); if (r.status) throw new Error(`${c}\n${r.stderr}`); return r.stdout.trim() }
const ID = 'git -c user.email=e@e.com -c user.name=E'
// repo with a bare remote; returns path
const mk = (name) => {
  sh(REM, `git init -q --bare -b main ${name}.git`)
  sh(P, `git clone -q ${REM}/${name}.git ${name} 2>/dev/null || true`)
  const r = join(P, name)
  sh(r, `git config user.email e@e.com && git config user.name E && echo "# ${name}" > README.md && git add . && git commit -qm init && git push -q -u origin main`)
  return r
}
const remoteCommit = (name, file) => {
  const tmp = join(ROOT, 'tmp-' + name); rmSync(tmp, { recursive: true, force: true })
  sh(ROOT, `git clone -q ${REM}/${name}.git ${tmp} && cd ${tmp} && echo r >> ${file} && git add . && ${ID} commit -qm "remote change" && git push -q`)
}
const alpha = mk('alpha'); remoteCommit('alpha', 'R.txt'); sh(alpha, 'git fetch -q')                 // behind 1
const beta = mk('beta'); sh(beta, `echo b > b.txt && git add . && git commit -qm "local b"`)          // ahead 1
mk('gamma')                                                                                           // clean
const eps = mk('eps'); remoteCommit('eps', 'same.txt'); sh(eps, `echo l > same.txt && git add . && git commit -qm local && git fetch -q`) // diverged
const zeta = mk('zeta'); sh(zeta, 'git checkout -q -b feature/local-only')                            // no upstream
const work = mk('work'); sh(work, 'printf "1\\n2\\n" > a.txt && printf "x" > b.txt && printf "y" > c.txt')  // 3 untracked files

// ---- mock provider: OpenAI-compatible, Bearer sk-good only, SSE when stream:true
const calls = []
const server = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
    const auth = req.headers.authorization
    calls.push({ url: req.url, auth, body: d ? JSON.parse(d) : null })
    if (auth !== 'Bearer sk-good') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } })) }
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-pro' }, { id: 'mock-mini' }] })) }
    const body = JSON.parse(d)
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const w of ['你', '好', '！']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '你好！' } }] }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/v1`

writeFileSync(join(DATA, 'gitloom.json'), JSON.stringify({
  settings: { theme: 'dark', ai: { baseUrl: '', apiKey: '', model: '', temperature: 0.2, language: 'zh', commitStyle: 'conventional' }, diffMode: 'split', graphLimit: 200, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 3, aiEnvForHooks: false, fontSize: 13, concurrency: 4 },
  workspace: { repos: [], active: null, projects: [{ id: 'p', name: 'proj', root: P, repos: [], hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
}))

const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox', '--disable-gpu'], env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_NO_WATCH: '1' }, timeout: 120000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const waitFn = async (fn, timeout = 15000, arg) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await page.evaluate(fn, arg).catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)) }
  throw new Error('timeout waiting for ' + fn.toString().slice(0, 140))
}
const until = async (fn, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { try { if (fn()) return } catch {} await new Promise((r) => setTimeout(r, 200)) } throw new Error('timeout: ' + fn.toString().slice(0, 120)) }
const results = []
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); console.log('✔', name) }
  catch (e) { results.push(['FAIL', name]); console.log('✘', name, (e.message || String(e)).slice(0, 300)); await page.screenshot({ path: join(shots, `fail-${results.length}.png`) }).catch(() => {}) }
}
const row = (text) => page.locator('.tree [data-row]', { hasText: text }).first()
const rowTexts = () => page.evaluate(() => [...document.querySelectorAll('.tree [data-row]')].map((e) => e.textContent))

await step('scan finds the 6 repos and badges settle', async () => {
  await waitFn(() => /6 个仓库/.test(document.querySelector('.side-foot')?.textContent ?? ''), 30000)
  await waitFn(() => [...document.querySelectorAll('.tree [data-row]')].some((e) => e.textContent.includes('alpha') && e.querySelector('.bdg-ab')), 20000)
})

await step('sidebar: 「无上游」 badge, rich hover title, legend', async () => {
  await waitFn(() => [...document.querySelectorAll('.tree [data-row]')].some((e) => e.textContent.includes('zeta') && e.querySelector('.bdg-noup')))
  const tt = await page.evaluate(() => { const r = [...document.querySelectorAll('.tree [data-row]')].find((e) => e.textContent.includes('alpha')); return [r, ...(r?.querySelectorAll('[title]') ?? [])].map((e) => e?.getAttribute('title') ?? '').find((t) => t.includes('分支：')) ?? '' })
  if (!/分支：main → origin\/main/.test(tt) || !/落后 1/.test(tt)) throw new Error('hover title: ' + tt)
  const legend = await page.locator('[data-testid=badge-legend]').getAttribute('title')
  if (!legend.includes('领先') || !legend.includes('无上游')) throw new Error('legend: ' + legend)
})

await step('sidebar: 只看有改动 hides clean repos and persists', async () => {
  await page.locator('[data-testid=changed-only]').click()
  await waitFn(() => ![...document.querySelectorAll('.tree [data-row]')].some((e) => /gamma|zeta/.test(e.textContent)))
  const t = (await rowTexts()).join('|')
  for (const n of ['alpha', 'beta', 'eps', 'work']) if (!t.includes(n)) throw new Error(`missing ${n}: ${t}`)
  if (!(await page.locator('.sf-filter').count())) throw new Error('footer filter chip missing')
  await page.waitForTimeout(400)
  const stored = await page.evaluate(() => localStorage.getItem('gitloom.sidebar.changedOnly'))
  if (stored !== 'true') throw new Error('not persisted: ' + stored)
  await page.locator('.sf-filter').click()
  await waitFn(() => [...document.querySelectorAll('.tree [data-row]')].some((e) => e.textContent.includes('gamma')))
})

await step('overview: 一键同步 shows counts; pull explains the diverged repo in Chinese', async () => {
  await page.locator('.modbar [data-module=workspace]').click().catch(async () => { await page.locator('.ws-tab', { hasText: '概览' }).click() })
  await page.locator('[data-testid=dash-quick]').waitFor()
  const pullTxt = await page.locator('[data-testid=quick-pull]').textContent()
  const pushTxt = await page.locator('[data-testid=quick-push]').textContent()
  if (!pullTxt.includes('2') || !pushTxt.includes('2')) throw new Error(`${pullTxt} / ${pushTxt}`) // alpha+eps behind, beta+eps ahead
  if (!(await page.locator('.dash-quick', { hasText: '1 个分支没有上游' }).count())) throw new Error('no-upstream hint missing')
  await page.locator('[data-testid=quick-pull]').click()
  await waitFn(() => /2\/2/.test(document.querySelector('.bulk-log .bl-head')?.textContent ?? ''), 30000)
  await waitFn(() => !document.querySelector('.bulk-log .spinner'), 20000).catch(() => {})
  const epsLine = page.locator('.bl-line', { hasText: 'eps' })
  const msg = await epsLine.locator('.bl-msg').textContent()
  if (!msg.includes('分叉')) throw new Error('eps message: ' + msg)
  if (!(await epsLine.locator('button', { hasText: '去处理' }).count())) throw new Error('去处理 button missing')
  if (!(await page.locator('.bl-line.r-ok', { hasText: 'alpha' }).count())) throw new Error('alpha should pull ok')
  if (sh(alpha, 'git rev-list --count HEAD..@{u}') !== '0') throw new Error('alpha still behind')
  await page.screenshot({ path: join(shots, 'quick-sync.png') })
})

await step('friendly error toast in plain Chinese with a fix button (pull on the diverged repo)', async () => {
  await row('eps').click()
  await page.locator('.viewtabs .nav-item', { hasText: '变更' }).click()
  await page.locator('.topbar button', { hasText: '拉取' }).first().click()
  const toast = page.locator('.toast', { hasText: '拉取失败' }).first()
  await toast.waitFor({ timeout: 15000 })
  const txt = await toast.textContent()
  if (!/分叉|冲突/.test(txt)) throw new Error('toast not explained: ' + txt)
  const fix = toast.locator('button', { hasText: /变基拉取|去处理/ })
  if (!(await fix.count())) throw new Error('no fix action in toast: ' + txt)
  await page.screenshot({ path: join(shots, 'friendly-error.png') })
  await fix.first().click()
  await page.locator('.viewtabs .nav-item.active, .viewtabs [aria-selected=true]', { hasText: '变更' }).waitFor()
})

await step('Changes: j/k move, s stages and advances, u unstages; key hint visible', async () => {
  await row('work').click()
  await page.locator('.viewtabs .nav-item', { hasText: '变更' }).click()
  await page.locator('[data-testid=changes-drawer].open, [data-testid=changes-keys]').first().waitFor()
  // drawer auto-opens on 变更; collapse handle appears when closed
  if (!(await page.locator('[data-testid=changes-drawer].open').count())) throw new Error('changes drawer should open with 变更 view')
  await page.locator('.file-row', { hasText: 'a.txt' }).click()
  await page.locator('[data-testid=changes-drawer] .pane-left, .pane-left').first().focus().catch(() => {})
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.press('j')
  await waitFn(() => document.querySelector('.file-row.sel')?.textContent.includes('b.txt'))
  await page.keyboard.press('k')
  await waitFn(() => document.querySelector('.file-row.sel')?.textContent.includes('a.txt'))
  await page.keyboard.press('s')
  await waitFn(() => [...document.querySelectorAll('.file-section')].some((s) => s.textContent.includes('已暂存') && s.textContent.includes('a.txt')))
  await waitFn(() => document.querySelector('.file-row.sel')?.textContent.includes('b.txt'))
  if (sh(work, 'git diff --cached --name-only') !== 'a.txt') throw new Error('a.txt not staged')
  await page.keyboard.press('s')
  await until(() => sh(work, 'git diff --cached --name-only').split('\n').length === 2)
  // jump to the staged a.txt and unstage it with u
  await page.locator('.file-section', { hasText: '已暂存' }).locator('.file-row', { hasText: 'a.txt' }).click()
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.keyboard.press('u')
  await until(() => !sh(work, 'git diff --cached --name-only').includes('a.txt'))
  // typing in the commit box must not trigger shortcuts
  await page.locator('.commit-summary').fill('')
  await page.locator('.commit-summary').type('s')
  if (sh(work, 'git diff --cached --name-only') !== 'b.txt') throw new Error('typing "s" in the input staged something')
})

await step('commit message history + per-repo draft', async () => {
  await page.locator('.commit-summary').fill('feat: 第一次用快捷键提交')
  await page.keyboard.press('Control+Enter')
  await until(() => sh(work, 'git log -1 --format=%s') === 'feat: 第一次用快捷键提交')
  // draft survives switching repo
  await page.locator('.commit-summary').fill('wip: 还没写完的说明')
  await row('beta').click()
  await waitFn(() => document.querySelector('.commit-summary')?.value === '')
  await row('work').click()
  await waitFn(() => document.querySelector('.commit-summary')?.value === 'wip: 还没写完的说明')
  await page.locator('.commit-summary').fill('')
  await page.locator('[data-testid=msg-history]').click()
  await page.locator('.msg-hist-item', { hasText: '第一次用快捷键提交' }).click()
  const v = await page.locator('.commit-summary').inputValue()
  if (v !== 'feat: 第一次用快捷键提交') throw new Error('history pick → ' + v)
  await page.locator('.commit-summary').fill('')
})

await step('diff: 显示全部行 toggle persists in settings', async () => {
  await page.locator('.file-row', { hasText: 'a.txt' }).first().click()
  await page.locator('[data-testid=diff-fold]').click()
  await waitFn(() => document.querySelector('[data-testid=diff-fold]')?.textContent.includes('折叠未改动'))
  await page.waitForTimeout(400)
  const j = JSON.parse(readFileSync(join(DATA, 'gitloom.json'), 'utf8'))
  if (j.settings.diffFoldUnchanged !== false) throw new Error('not saved')
  await page.locator('[data-testid=diff-fold]').click()
})

await step('AI settings: picker groups + search → add DeepSeek-like custom → 获取模型 → 测试连接 (streamed)', async () => {
  await page.keyboard.press('Control+,')
  await page.locator('[data-testid=ai-settings]').waitFor()
  await page.locator('[data-testid=ai-settings]').scrollIntoViewIfNeeded()
  await page.locator('[data-testid=ai-add]').click()
  await page.locator('.prov-picker').waitFor()
  const groups = await page.$$eval('.prov-group-title', (els) => els.map((e) => e.textContent))
  for (const g of ['国际', '国内', '聚合']) if (!groups.some((x) => x.includes(g))) throw new Error('groups: ' + groups)
  if ((await page.locator('.prov-tile').count()) < 20) throw new Error('too few tiles')
  await page.locator('[data-testid=ai-search]').fill('千问')
  await waitFn(() => document.querySelectorAll('.prov-tile').length >= 1 && !!document.querySelector('.prov-tile[data-preset=dashscope]'))
  await page.locator('[data-testid=ai-search]').fill('自定义')
  await page.locator('.prov-tile[data-preset=custom]').click()
  await page.locator('[data-testid=ai-editor]').waitFor()
  await page.locator('[data-testid=ai-baseurl]').fill(base)
  await page.locator('[data-testid=ai-model]').fill('mock-pro')
  await page.locator('[data-testid=ai-key]').fill('sk-wrong')
  await page.locator('[data-testid=ai-test]').click()
  await page.locator('[data-testid=ai-test-result].err').waitFor()
  const err = await page.locator('[data-testid=ai-test-result]').textContent()
  if (!/Key|密钥|鉴权|认证|身份/.test(err)) throw new Error('wrong-key error not explained: ' + err)
  await page.locator('[data-testid=ai-key]').fill('sk-good')
  await page.locator('[data-testid=ai-fetch-models]').click()
  await waitFn(() => /2/.test(document.querySelector('[data-testid=ai-models-info]')?.textContent ?? ''))
  await page.locator('[data-testid=ai-test]').click()
  await page.locator('[data-testid=ai-test-result].ok').waitFor()
  const ok = await page.locator('[data-testid=ai-test-result]').textContent()
  if (!ok.includes('你好') || !ok.includes('首字')) throw new Error('ok text: ' + ok)
  const last = calls.filter((c) => c.body?.messages).pop()
  if (!last.body.stream || last.body.model !== 'mock-pro') throw new Error('test call not streamed with chosen model: ' + JSON.stringify(last.body))
})

await step('save settings: key encrypted at rest (or omitted), legacy mirror kept for hooks', async () => {
  await page.getByRole('button', { name: '保存设置' }).click()
  await page.locator('.toast', { hasText: '设置已保存' }).waitFor()
  await page.waitForTimeout(300)
  const raw = readFileSync(join(DATA, 'gitloom.json'), 'utf8')
  if (raw.includes('sk-good')) {
    const enc = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
    if (enc) throw new Error('plaintext key on disk although safeStorage is available')
    console.log('   (no OS keyring on this box: safeStorage unavailable, key stored as plain text like before)')
  }
  const j = JSON.parse(raw)
  const p = j.settings.ai.profiles?.[0]
  if (!p || p.preset !== 'custom' || p.baseUrl !== base || p.model !== 'mock-pro') throw new Error('profile not saved: ' + JSON.stringify(p))
  if (j.settings.ai.baseUrl !== base || j.settings.ai.model !== 'mock-pro') throw new Error('legacy mirror not synced')
  await page.screenshot({ path: join(shots, 'ai-settings.png') })
})

await step('AI assistant chat streams through the saved profile', async () => {
  await page.keyboard.press('Escape')
  await row('work').click()
  await page.locator('.viewtabs [role=tab]', { hasText: 'AI 助手' }).first().click()
  const box = page.locator('.ai-chat-input textarea')
  await box.fill('打个招呼')
  await box.press('Control+Enter')
  await waitFn(() => [...document.querySelectorAll('.ai-assistant')].some((e) => e.textContent.includes('你好！')), 15000)
})

await app.close().catch(() => {})
server.close()
const failed = results.filter((r) => r[0] === 'FAIL')
console.log(`\n${results.length - failed.length}/${results.length} 0.4.2 e2e steps passed`)
process.exit(failed.length ? 1 : 0)
