// Tool whitelist: tasks are analysis-only by default. Only read-only commands may run unless the task explicitly
// enables writes. (0.6.1 ships no write tools at all; the guard is enforced anyway so future tools can't slip through.)
const READ_GIT = new Set(['log', 'branch', 'diff', 'show', 'status', 'for-each-ref', 'rev-list', 'rev-parse', 'merge-base', 'ls-files', 'grep', 'remote', 'symbolic-ref', 'cat-file', 'shortlog', 'blame'])
const WRITE_FLAGS = /^(-d|-D|--delete|-m|-M|--move|-c|-C|--copy|-f|--force|--set-upstream-to|-u|--unset-upstream|--edit-description|add|remove|rm|rename|set-url|prune|set-head)$/
export type ToolCall = { tool: 'git'; args: string[] } | { tool: 'read'; file: string } | { tool: 'grep'; pattern: string } | { tool: 'audit'; manager: 'npm' | 'pip' } | { tool: string; args?: string[] }
export function checkTool(c: ToolCall, allowWrite: boolean): { ok: true } | { ok: false; reason: string } {
  if (c.tool === 'read' || c.tool === 'grep' || c.tool === 'audit') return { ok: true }
  if (c.tool === 'git') {
    const args = (c as { args: string[] }).args
    const sub = args[0]
    if (!READ_GIT.has(sub)) return allowWrite ? { ok: true } : { ok: false, reason: `只读任务不允许 git ${sub}` }
    if ((sub === 'branch' || sub === 'remote') && args.slice(1).some((a) => WRITE_FLAGS.test(a))) return allowWrite ? { ok: true } : { ok: false, reason: `只读任务不允许 git ${args.join(' ')}` }
    if (args.some((a) => a === '--output' || a.startsWith('--output='))) return { ok: false, reason: '不允许写出文件' }
    return { ok: true }
  }
  return allowWrite ? { ok: true } : { ok: false, reason: `只读任务不允许工具 ${c.tool}` }
}
/** scrub secrets from anything that might be logged or rendered */
export function redact(text: string, secrets: string[] = []): string {
  let s = text
  for (const k of secrets) if (k && k.length >= 4) s = s.split(k).join('***')
  return s.replace(/(authorization|token|api[_-]?key|secret|password)(["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi, (_m, a, b) => `${a}${b}***`)
}
