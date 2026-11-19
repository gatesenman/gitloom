// In-process VizDeps (unit tests, CLI, and the fallback when the worker cannot start).
import { spawn } from 'child_process'
import { FactParser } from './parser'
import type { VizDeps, ParseItem } from './service'
import type { FileFacts } from './facts'

export function gitSpawn(cwd: string, args: string[], input?: string, gitPath = 'git'): Promise<{ buf: Buffer; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(gitPath, args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }, windowsHide: true })
    const out: Buffer[] = []; const err: Buffer[] = []
    c.stdout.on('data', (d: Buffer) => out.push(d)); c.stderr.on('data', (d: Buffer) => err.push(d))
    c.on('error', reject)
    c.on('close', (code) => resolve({ buf: Buffer.concat(out), code: code ?? -1, stderr: Buffer.concat(err).toString() }))
    if (input !== undefined) c.stdin.end(input); else c.stdin.end()
  })
}

export async function parseLocal(parser: FactParser, items: ParseItem[], onProgress?: (d: number) => void): Promise<FileFacts[]> {
  const out: FileFacts[] = []
  for (let i = 0; i < items.length; i++) {
    out.push(await parser.parse(items[i].path, items[i].lang, items[i].src))
    if (onProgress && i % 50 === 49) onProgress(i + 1)
  }
  return out
}

export function localDeps(grammarDir: string, runtimeWasm?: string): VizDeps {
  const parser = new FactParser(grammarDir, runtimeWasm)
  return {
    git: async (cwd, args, o) => { const r = await gitSpawn(cwd, args, o?.input); if (r.code !== 0 && !o?.allowFail) throw new Error(r.stderr || `git ${args[0]} failed`); return { stdout: r.buf.toString('utf8'), ok: r.code === 0 } },
    gitBuf: async (cwd, args, input) => (await gitSpawn(cwd, args, input)).buf,
    parseMany: (items, onProgress) => parseLocal(parser, items, onProgress)
  }
}
