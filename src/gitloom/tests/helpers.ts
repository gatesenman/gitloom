import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com' }
  })
}

export function tmpRepo(prefix = 'gitloom-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'Tester')
  sh(dir, 'config', 'user.email', 't@example.com')
  sh(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

export function write(dir: string, file: string, content: string): void {
  const p = path.join(dir, file)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, content)
}

export function commitAll(dir: string, msg: string): void {
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-q', '-m', msg)
}
