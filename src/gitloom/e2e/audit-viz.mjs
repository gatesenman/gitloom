// Visual audit of 变更可视化: every view on several real / fixture repos, at 1024 / 1440 / 1920, dark + light.
// Takes a screenshot per view and measures objective readability metrics on the rendered "after" pane:
//   zoom after fit, truncated labels, overlapping nodes, edge crossings, edges running through unrelated nodes.
// Run: AUDIT_DIR=/tmp/audit-new xvfb-run -a node e2e/audit-viz.mjs   → $AUDIT_DIR/*.png + metrics.json
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { makeTsService, makePy, makeJava, makeBig, makeHub } from '../scripts/viz-fixtures.mjs'
const require = createRequire(import.meta.url)

const ROOT = '/tmp/gitloom-audit'
const OUT = process.env.AUDIT_DIR || join(ROOT, 'out')
const ONLY = process.env.AUDIT_ONLY ? new RegExp(process.env.AUDIT_ONLY) : null
rmSync(ROOT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const DATA = join(ROOT, 'data'); mkdirSync(DATA, { recursive: true })
const PROJ = join(ROOT, 'proj')
const R = {
  ts: makeTsService(join(PROJ, 'ts-service')), py: makePy(join(PROJ, 'py-pkg')), java: makeJava(join(PROJ, 'java-app')),
  shop: makeHub(join(PROJ, 'web-shop')), big: makeBig(join(PROJ, 'big-mono'), 1500, 60), dog: join(PROJ, 'gitloom')
}
spawnSync('git', ['clone', '-q', '--no-local', '/workspace/gitdesk', R.dog])
const DOG_FROM = process.env.DOG_FROM || '7ff65c4', DOG_TO = process.env.DOG_TO || '96c7747'
const repoEntry = (p, rel) => ({ path: p, rel, kind: 'normal', initialized: true })
const all = Object.values(R)
writeFileSync(join(DATA, 'gitloom.json'), JSON.stringify({
  settings: { theme: 'dark', diffMode: 'split', graphLimit: 200, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 2, aiEnvForHooks: false, fontSize: 13, concurrency: 4 },
  workspace: { repos: all, active: R.ts, projects: [{ id: 'p', name: 'audit', root: PROJ, repos: Object.entries(R).map(([k, p]) => repoEntry(p, k)), hidden: [] }], activeProject: 'p', pinned: [], recent: [] }
}))
const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox', '--disable-gpu'], env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_NO_WATCH: '1' }, timeout: 120000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await fn()) return true } catch { /* retry */ } await sleep(120) } return false }
const size = async (w, h) => { await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]); await sleep(700) }
const theme = (t) => page.evaluate((t) => { document.documentElement.dataset.theme = t }, t)
const vizDone = () => until(async () => (await page.locator('[data-testid=viz-summary]').count()) > 0 && (await page.locator('[data-testid=viz-progress]').count()) === 0, 90000)
const settled = async () => { await until(async () => (await page.locator('.vz-busy').count()) === 0, 40000); await sleep(600) }
const setActive = async (p) => { await page.evaluate((x) => window.__gitloomSetActive && window.__gitloomSetActive(x), p); await sleep(900) }
const more = async (label) => { await page.locator('.viewtabs [role="tab"]', { hasText: label }).first().click(); await sleep(400) }
const openViz = async () => { await page.evaluate(() => window.__gitloomSetView && window.__gitloomSetView('viz')); await sleep(600) }
const analyze = async (scope, vals = {}) => {
  await page.locator(`[data-testid=viz-scope-${scope}]`).click()
  for (const [k, v] of Object.entries(vals)) await page.locator(`[data-testid=viz-${k}]`).fill(v)
  await page.locator('[data-testid=viz-run]').click(); await sleep(300); await vizDone(); await settled()
}

// ---- metrics measured inside the renderer (flow coordinates of the last visible pane)
const measure = () => page.evaluate(() => {
  const panes = [...document.querySelectorAll('.vz-pane')]
  const pane = panes.find((p) => p.matches('.pane-after, .pane-both')) ?? panes[panes.length - 1]
  if (!pane) return null
  const pct = Number((document.querySelector('.vz-zoom-pct')?.textContent ?? '0').replace('%', ''))
  const nodes = [...pane.querySelectorAll('.react-flow__node')].filter((n) => getComputedStyle(n).visibility !== 'hidden' && !n.querySelector('.vg'))
  // absolute flow coordinates (child nodes carry parent-relative transforms, so measure on screen and divide by zoom)
  const z = pct / 100 || 1
  const rect = (n) => { const b = n.getBoundingClientRect(); return { x: b.left / z, y: b.top / z, w: b.width / z, h: b.height / z, id: n.dataset.id } }
  const rs = nodes.map(rect)
  let overlaps = 0
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const a = rs[i], b = rs[j]; if (a.x < b.x + b.w - 2 && b.x < a.x + a.w - 2 && a.y < b.y + b.h - 2 && b.y < a.y + a.h - 2) overlaps++ }
  const trunc = [...pane.querySelectorAll('.vn-label, .vc-m, .vn-sub')].filter((e) => e.scrollWidth > e.clientWidth + 1).length
  const paths = [...pane.querySelectorAll('.react-flow__edge')].filter((e) => getComputedStyle(e).visibility !== 'hidden').map((e) => e.querySelector('path.react-flow__edge-path')).filter(Boolean)
  const polys = paths.map((p) => { const L = p.getTotalLength(); const n = Math.max(2, Math.min(240, Math.ceil(L / 8))); const M = p.getScreenCTM(); const pts = []; for (let i = 0; i <= n; i++) { const q = p.getPointAtLength((L * i) / n).matrixTransform(M); pts.push([q.x / z, q.y / z]) } return pts })
  const inside = (pt, r, pad) => pt[0] > r.x + pad && pt[0] < r.x + r.w - pad && pt[1] > r.y + pad && pt[1] < r.y + r.h - pad
  let through = 0
  const ends = polys.map((pts) => { const a = pts[0], b = pts[pts.length - 1]; return rs.filter((r) => inside(a, r, -8) || inside(b, r, -8)) })
  polys.forEach((pts, i) => { const own = new Set(ends[i]); if (rs.some((r) => !own.has(r) && pts.some((pt) => inside(pt, r, 3)))) through++ })
  // crossings: proper segment intersections between different edges, away from endpoints
  const segs = []
  polys.forEach((pts, ei) => { for (let k = 1; k < pts.length; k++) segs.push([ei, pts[k - 1], pts[k], pts[0], pts[pts.length - 1]]) })
  const cell = new Map(); const C = 40
  segs.forEach((s, si) => { const x0 = Math.floor(Math.min(s[1][0], s[2][0]) / C), x1 = Math.floor(Math.max(s[1][0], s[2][0]) / C), y0 = Math.floor(Math.min(s[1][1], s[2][1]) / C), y1 = Math.floor(Math.max(s[1][1], s[2][1]) / C); for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + ':' + y; (cell.get(k) ?? cell.set(k, []).get(k)).push(si) } })
  const ccw = (a, b, c) => (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0])
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 14
  const seen = new Set()
  for (const ids of cell.values()) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const A = segs[ids[i]], B = segs[ids[j]]
    if (A[0] === B[0]) continue
    const d1 = ccw(B[1], B[2], A[1]), d2 = ccw(B[1], B[2], A[2]), d3 = ccw(A[1], A[2], B[1]), d4 = ccw(A[1], A[2], B[2])
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
      const p = A[1]
      if ([A[3], A[4], B[3], B[4]].some((e) => near(e, p))) continue
      seen.add(`${Math.round(p[0] / 20)}-${Math.round(p[1] / 20)}`)   // distinct crossing spots (bundled edges merging are not N² crossings)
    }
  }
  const tb = document.querySelector('.vz-toolbar'); const tbr = tb?.getBoundingClientRect()
  const vis = tb ? [...tb.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0) : []
  const cy = (b) => (b.top + b.bottom) / 2
  const vis2 = vis.filter((r) => r.height > 4); const wrapped = tb ? vis2.some((r) => Math.abs(cy(r) - cy(vis2[0])) > 10 || r.right > tbr.right + 1) : false
  const sc = document.querySelector('.vz-scope'); const scr = sc?.getBoundingClientRect()
  const sk = sc ? [...sc.children].map((c) => c.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 4) : []
  const scopeWrapped = sk.some((b) => Math.abs(cy(b) - cy(sk[0])) > 10)
  const pr = pane.getBoundingClientRect()
  const changedInView = [...pane.querySelectorAll('.vn:not(.st-unchanged)')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > pr.left && b.left < pr.right && b.bottom > pr.top && b.top < pr.bottom }).length
  return { changedInView, scopeWrapped, nodes: rs.length, edges: polys.length, zoom: pct, fontPx: +(12.5 * pct / 100).toFixed(1), trunc, overlaps, crossings: seen.size, through, toolbarWrapped: wrapped }
})

const metrics = []
const shotView = async (tag, view) => {
  const name = `${tag}-${view}`
  if (ONLY && !ONLY.test(name)) return
  const t0 = Date.now()
  await page.locator(`[data-testid=viz-tab-${view}]`).click(); await sleep(250); await settled()
  const ms = Date.now() - t0
  await page.mouse.move(5, 300); await sleep(250)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  const m = view === 'sequence' || view === 'map' ? {} : (await measure()) ?? {}
  metrics.push({ name, ms, ...m })
  console.log(name.padEnd(28), JSON.stringify({ ms, ...m }))
}
const VIEWS = ['map', 'tour', 'arch', 'modules', 'calls', 'flow', 'sequence', 'state', 'classes', 'impact']

await sleep(2500)
await size(1440, 900)
await openViz()
await page.locator('.view-intro button', { hasText: '知道了' }).click({ timeout: 4000 }).catch(() => {})
await vizDone()
const plan = [
  ['ts', R.ts, ['commit', { sha: 'HEAD' }]], ['py', R.py, ['commit', { sha: 'HEAD' }]], ['java', R.java, ['commit', { sha: 'HEAD' }]],
  ['shop', R.shop, ['refs', { base: 'main', head: 'feature/coupons' }]], ['big', R.big, ['commit', { sha: 'HEAD' }]],
  ['dog', R.dog, ['range', { from: DOG_FROM, to: DOG_TO }]]
]
for (const [tag, repo, [scope, vals]] of plan) {
  if (ONLY && !VIEWS.some((v) => ONLY.test(`${tag}-1440-dark-${v}`) || ONLY.test(`${tag}-1024-light-${v}`) || ONLY.test(`${tag}-1920-dark-${v}`))) continue
  await setActive(repo); await openViz(); await vizDone()
  await analyze(scope, vals)
  await size(1440, 900); await theme('dark')
  for (const v of VIEWS) await shotView(`${tag}-1440-dark`, v)
  if (tag === 'ts' || tag === 'dog') {
    await size(1024, 720); await theme('light')
    for (const v of ['map', 'arch', 'modules', 'calls', 'flow', 'state', 'classes']) await shotView(`${tag}-1024-light`, v)
    await size(1920, 1080); await theme('dark')
    for (const v of ['modules', 'calls', 'impact', 'classes']) await shotView(`${tag}-1920-dark`, v)
    await size(1440, 900); await theme('dark')
  }
}
writeFileSync(join(OUT, 'metrics.json'), JSON.stringify({ metrics, errors }, null, 1))
console.log('page errors:', errors.length, errors.slice(0, 3))
await app.close()
