// Startup / scan performance on the large-project fixture (scripts/make-bigproject-fixture.sh).
// Launches the built app with GITLOOM_PERF=1 and reads the [perf] milestones it prints (ms since process start).
// usage: bash scripts/make-bigproject-fixture.sh /tmp/gitloom-big && npm run build && xvfb-run -a node scripts/perf-big.mjs [runs=4]
import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const P = process.env.BIG || '/tmp/gitloom-big/EVER-BUDDY'
const DATA = '/tmp/gitloom-perf-data'
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true })
writeFileSync(join(DATA, 'gitloom.json'), JSON.stringify({
  settings: { theme: 'dark', ai: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'x', temperature: 0.2, language: 'zh', commitStyle: 'conventional' }, diffMode: 'split', graphLimit: 400, autoFetchMinutes: 0, gitPath: 'git', scanDepth: 6, aiEnvForHooks: false, fontSize: 13, density: 'comfortable', concurrency: 6 },
  workspace: { repos: [], active: null, projects: [{ id: 'eb', name: 'EVER-BUDDY', root: P, repos: [], hidden: [] }], activeProject: 'eb', pinned: [], recent: [] }
}))
const once = (label) => new Promise((resolve, reject) => {
  const t0 = Date.now()
  const ev = {}
  const cp = spawn(require('electron'), ['.', '--no-sandbox', '--disable-gpu'], { env: { ...process.env, GITLOOM_DATA_DIR: DATA, GITLOOM_PERF: '1' } })
  const kill = setTimeout(() => { cp.kill(); reject(new Error(`${label}: timeout ${JSON.stringify(ev)}`)) }, 90000)
  let buf = ''
  cp.stdout.on('data', (d) => {
    buf += d
    for (const m of buf.matchAll(/\[perf\] (\d+) ([\w-]+)(?: ([^\n]*))?/g)) if (!ev[m[2]]) ev[m[2]] = { t: Date.now() - t0, extra: m[3] ?? '' }
    if (ev.summaries) {
      // keep running a moment so the background rescan of a cached project also lands, then quit
      setTimeout(() => { cp.kill('SIGTERM') }, 1500)
    }
  })
  cp.on('exit', () => {
    clearTimeout(kill)
    const f = (k) => (ev[k] ? `${ev[k].t}ms` : '—')
    if (process.env.PERF_DEBUG) console.log(ev); console.log(`${label.padEnd(18)} app-ready ${f('app-ready')} · window ${f('ready-to-show')} · workspace ${f('workspace-loaded')} · tree ${f('tree')} (${ev.tree?.extra ?? ''}) · all badges ${f('summaries')}`)
    resolve(Object.fromEntries(Object.entries(ev).map(([k, v]) => [k, v.t])))
  })
})
const runs = Number(process.argv[2] || 4)
const out = []
for (let i = 0; i < runs; i++) { out.push(await once(i === 0 ? 'cold (first scan)' : `warm #${i}`)); await new Promise((r) => setTimeout(r, 800)) }
writeFileSync('/tmp/gitloom-perf.json', JSON.stringify(out, null, 1))
