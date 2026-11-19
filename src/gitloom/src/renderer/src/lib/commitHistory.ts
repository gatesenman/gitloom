// Recently used commit messages (newest first) + per-repo unsent drafts.
// Pure helpers are exported for unit tests; storage access is wrapped so it never throws.

export const HISTORY_KEY = 'gitloom.commitHistory'
export const DRAFTS_KEY = 'gitloom.commitDrafts'
export const HISTORY_MAX = 20

/** Add `msg` to the front of `list`, de-duplicated (trim-insensitive), capped to `max`. */
export function pushHistory(list: string[], msg: string, max = HISTORY_MAX): string[] {
  const m = msg.trim()
  if (!m) return list
  return [m, ...list.filter((x) => x.trim() !== m)].slice(0, max)
}

/** Case-insensitive substring filter over the full message. */
export function filterHistory(list: string[], q: string): string[] {
  const s = q.trim().toLowerCase()
  return s ? list.filter((x) => x.toLowerCase().includes(s)) : list
}

/** Split a stored message into summary + body the same way the commit box does. */
export function splitMessage(msg: string): { summary: string; body: string } {
  const [s, ...b] = msg.split('\n')
  return { summary: s.trim(), body: b.join('\n').trim() }
}

function read<T>(key: string, dflt: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : dflt } catch { return dflt }
}
function write(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* quota / disabled */ }
}

export const loadHistory = (): string[] => { const v = read<unknown>(HISTORY_KEY, []); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] }
export const rememberMessage = (msg: string): string[] => { const next = pushHistory(loadHistory(), msg); write(HISTORY_KEY, next); return next }
export const clearHistory = (): void => write(HISTORY_KEY, [])

type Draft = { summary: string; body: string }
export const loadDraft = (repo: string): Draft => read<Record<string, Draft>>(DRAFTS_KEY, {})[repo] ?? { summary: '', body: '' }
export function saveDraft(repo: string, d: Draft): void {
  const all = read<Record<string, Draft>>(DRAFTS_KEY, {})
  if (d.summary.trim() || d.body.trim()) all[repo] = d
  else delete all[repo]
  write(DRAFTS_KEY, all)
}
