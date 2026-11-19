// v0.4.1 screenshots: new tab bar, 更多 dropdown, advanced-view intro, changes-view button layout, light theme @1024.
// usage: xvfb-run -a node scripts/shots-v5.mjs   (after `npm run build`)
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const OUT = join(process.cwd(), 'screenshots/v5')
const DATA = '/tmp/gitloom-shots-v5'
const P = '/tmp/gitloom-v5'
rmSync(DATA, { recursive: true, force: true }); rmSync(P, { recursive: true, force: true }); rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true }); mkdirSync(DATA, { recursive: true })
const sh = (cwd, c) => { mkdirSync(cwd, { recursive: true }); const r = spawnSync('bash', ['-lc', c], { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr || c) }
const init = 'git init -q -b main && git config user.email dev@gitloom.app && git config user.name "Lin Wei"'
sh(`${P}/webapp`, `${init} && mkdir -p src/pages && printf 'export function Login() {\\n  return <form>登录</form>\\n}\\n' > src/pages/Login.tsx && printf '# webapp\\n\\n织线示例项目\\n' > README.md && printf '{ "name": "webapp" }\\n' > package.json && git add -A && git commit -qm "feat: 初始化项目" && git remote add origin https://github.com/acme/webapp.git`)
sh(`${P}/webapp`, `printf 'body { margin: 0 }\\n' > src/app.css && git add -A && git commit -qm "style: 全局样式" && git checkout -qb feature/login && printf 'export const api = "/v1"\\n' > src/api.ts && git add -A && git commit -qm "feat(api): 接口前缀" && git checkout -q main && git merge -q --no-ff feature/login -m "Merge branch feature/login"`)
sh(`${P}/webapp`, `printf 'export function Login() {\\n  const [user, setUser] = useState("")\\n  return <form onSubmit={submit}>\\n    <h1>欢迎回来</h1>\\n    <input value={user} onChange={(e) => setUser(e.target.value)} />\\n  </form>\\n}\\n' > src/pages/Login.tsx && printf '# webapp\\n\\n织线示例项目 · 登录页改版\\n' > README.md && git add README.md && printf 'TODO\\n' > NOTES.md`)
sh(`${P}/services/billing`, `${init} && echo 'billing' > main.go && git add -A && git commit -qm init && echo '// fix' >> main.go`)
sh(`${P}/libs/ui`, `${init} && echo 'ui' > index.ts && git add -A && git commit -qm init`)
const W = `${P}/webapp`
writeFileSync(join(DATA, 'gitloom.json'), JSON.stringify({
  settings: { theme: 'dark', ai: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'demo', temperature: 0.2, language: 'zh', commitStyle: 'conventional' }, diffMode: 'split', graphLimit: 400, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 4, aiEnvForHooks: false, fontSize: 13, density: 'comfortable', concurrency: 4, forge: { githubToken: '', gitlabToken: '', gitlabBaseUrl: 'https://gitlab.com' } },
  workspace: { repos: [], active: W, projects: [{ id: 'p', name: 'gitloom-demo', root: P, repos: [], hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
}))
const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox', '--disable-gpu'], env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_NO_WATCH: '1' }, timeout: 120000 })
const page = await app.firstWindow()
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: join(OUT, name) }); console.log('📸', name) }
await size(1440, 900)
await page.waitForTimeout(6000)
await page.locator('.repo-item', { hasText: 'webapp' }).first().click().catch(() => {})
await page.locator('.viewtabs .nav-item', { hasText: '变更' }).click({ timeout: 20000 })
await page.locator('.file-row', { hasText: 'Login.tsx' }).click({ timeout: 20000 })
await page.waitForSelector('.monaco-diff-editor', { timeout: 20000 })
await shot('01-repo-view-tabs-changes.png')
await page.locator('.commit-opts-wrap > button').click()
await shot('02-changes-commit-options.png')
await page.keyboard.press('Escape')
await shot('03-flat-advanced-tabs.png')
await page.locator('.viewtabs [role=tab]', { hasText: '二分查错' }).first().click()
await page.waitForSelector('.view-intro')
await shot('04-advanced-intro-bisect.png')
await page.locator('.viewtabs [role=tab]', { hasText: '文件追溯' }).first().click()
await page.waitForSelector('.view-intro')
await shot('12-file-trace-intro.png')
await page.locator('.viewtabs [role=tab]', { hasText: 'PR 与 Issue' }).first().click()
await page.waitForTimeout(800)
await shot('05-pr-issue-inline-setup.png')
await page.locator('.viewtabs .nav-item', { hasText: '历史' }).click()
await page.locator('.history .seg button', { hasText: '提交图' }).click()
await page.waitForSelector('.commit-row')
await shot('06-history-graph-toggle.png')
await page.locator('.viewtabs .nav-item', { hasText: '分支' }).click()
await shot('07-branches-subsections.png')
await page.locator('.topbar button[aria-label="更多操作"]').click()
await shot('08-topbar-overflow-menu.png')
await page.keyboard.press('Escape')
await page.locator('.topbar button[aria-label="更多操作"]').click()
await page.locator('.ctx-item', { hasText: 'Git 钩子' }).click()
await page.waitForTimeout(800)
await shot('11-settings-git-hooks.png')
await page.keyboard.press('Control+1')
// light theme @1024
await page.locator('.topbar button[aria-label="更多操作"]').click()
await page.locator('.ctx-item', { hasText: '切换到浅色主题' }).click()
await size(1024, 720)
await page.locator('.viewtabs .nav-item', { hasText: '变更' }).click()
await page.locator('.file-row', { hasText: 'Login.tsx' }).click()
await page.waitForSelector('.monaco-diff-editor')
await shot('09-light-1024-changes.png')
await shot('10-light-1024-flat-tabs.png')
await app.close()
