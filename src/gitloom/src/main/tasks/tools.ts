// Read-only tool runners used by task templates; every git call passes the whitelist in readonly.ts.
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import { gitSpawn } from '../viz/local'
import { checkTool } from './readonly'

export interface Tools {
  git(cwd: string, args: string[]): Promise<{ stdout: string; ok: boolean }>
  read(repo: string, file: string, max?: number): Promise<string | null>
  audit(repo: string): Promise<{ ok: boolean; json?: unknown; note?: string }>
}
export function makeTools(allowWrite = false): Tools {
  return {
    async git(cwd, args) {
      const c = checkTool({ tool: 'git', args }, allowWrite)
      if (!c.ok) throw new Error(c.reason)
      const r = await gitSpawn(cwd, args)
      return { stdout: r.buf.toString('utf8'), ok: r.code === 0 }
    },
    async read(repo, file, max = 512 * 1024) {
      const p = resolve(repo, file)
      if (p !== resolve(repo) && !p.startsWith(resolve(repo) + sep)) return null // never read outside the repo
      try { const st = await fs.stat(p); if (!st.isFile() || st.size > max) return null; return await fs.readFile(p, 'utf8') } catch { return null }
    },
    async audit(repo) {
      // npm audit is read-only (no "fix"); --package-lock-only never touches node_modules
      try { await fs.access(join(repo, 'package-lock.json')) } catch { return { ok: false, note: '没有 package-lock.json，跳过依赖漏洞检查' } }
      return new Promise((res) => {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
        let out = ''
        let done = false
        const p = spawn(npm, ['audit', '--json', '--package-lock-only'], { cwd: repo, shell: process.platform === 'win32', windowsHide: true })
        const t = setTimeout(() => { if (!done) { done = true; p.kill(); res({ ok: false, note: 'npm audit 超时（可能无法联网），已跳过' }) } }, 60000)
        p.stdout.on('data', (d) => { out += d })
        p.on('error', () => { if (!done) { done = true; clearTimeout(t); res({ ok: false, note: '未找到 npm，跳过依赖漏洞检查' }) } })
        p.on('close', () => { if (done) return; done = true; clearTimeout(t); try { res({ ok: true, json: JSON.parse(out) }) } catch { res({ ok: false, note: 'npm audit 没有返回结果（可能无法联网），已跳过' }) } })
      })
    }
  }
}
