import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { AIRun, LRU, type RunState } from '../lib/aiRun'
import { errMsg } from '../api'

/** Module-level result caches (survive view switches; cleared on reload). */
export const AI_CACHE = {
  commitExplain: new LRU<string>(200)
}

/** Create one AIRun for the component's lifetime; aborts on unmount. Does NOT subscribe (see useRunState). */
export function useAIRunner(cache?: LRU<string>): AIRun {
  const r = useMemo(() => new AIRun({ cache, errText: errMsg }), [cache])
  useEffect(() => () => r.dispose(), [r])
  return r
}

/** Subscribe to a runner. `select` lets a component re-render only when its slice changes (e.g. the button only on status). */
export function useRunState<T = RunState>(r: AIRun, select?: (s: RunState) => T): T {
  const get = (): T => (select ? select(r.getState()) : (r.getState() as unknown as T))
  return useSyncExternalStore(r.subscribe, get, get)
}

/** Human label "服务商 · 模型" for the profile a task would use. */
export function aiLabel(ai: import('@shared/types').AISettings | undefined, task: import('@shared/types').AITask): string {
  if (!ai) return 'AI'
  const t = ai.tasks?.[task]
  const pid = t?.profile || ai.activeProfile
  const p = ai.profiles?.find((x) => x.id === pid) ?? ai.profiles?.[0]
  const model = t?.model || p?.azureDeployment || p?.model || ai.model
  return [p?.name, model].filter(Boolean).join(' · ') || 'AI'
}
