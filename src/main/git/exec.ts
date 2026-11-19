import { spawn } from 'child_process'
import type { CommandLogEntry, GitResult } from '../../shared/types'
import { safeInvoke } from '../quitGuard'

export interface ExecOptions {
  input?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** do not throw on non-zero exit */
  allowFail?: boolean
  maxBuffer?: number
}

export class GitError extends Error {
  constructor(public args: string[], public code: number, public stderr: string, public stdout: string) {
    super((stderr || stdout || `git ${args.join(' ')} exited with ${code}`).trim())
  }
}

let seq = 0

export class GitRunner {
  log: CommandLogEntry[] = []
  constructor(public gitPath = 'git', public onLog?: (e: CommandLogEntry) => void) {}

  run(cwd: string, args: string[], opts: ExecOptions = {}): Promise<GitResult> {
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, args, {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          LC_MESSAGES: 'C',
          GIT_EDITOR: 'true',
          ...opts.env
        },
        windowsHide: true
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let size = 0
      const max = opts.maxBuffer ?? 64 * 1024 * 1024
      child.stdout.on('data', (d: Buffer) => { size += d.length; if (size <= max) out.push(d) })
      child.stderr.on('data', (d: Buffer) => err.push(d))
      let timer: NodeJS.Timeout | undefined
      if (opts.timeoutMs) timer = setTimeout(() => child.kill(), opts.timeoutMs)
      child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e) })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        const stdout = Buffer.concat(out).toString('utf8')
        const stderr = Buffer.concat(err).toString('utf8')
        const entry: CommandLogEntry = {
          id: ++seq, cwd, args, code: code ?? -1, ms: Date.now() - started, at: started,
          stderr: code ? stderr.slice(0, 2000) : undefined
        }
        this.log.push(entry)
        if (this.log.length > 300) this.log.shift()
        // Quit may clear onLog / destroy the window while git is still closing — never throw.
        if (this.onLog) safeInvoke(this.onLog, entry)
        const res: GitResult = { ok: code === 0, stdout, stderr, code: code ?? -1 }
        if (code !== 0 && !opts.allowFail) reject(new GitError(args, code ?? -1, stderr, stdout))
        else resolve(res)
      })
      if (opts.input !== undefined) child.stdin.end(opts.input)
      else child.stdin.end()
    })
  }

  async out(cwd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
    return (await this.run(cwd, args, opts)).stdout
  }
}
