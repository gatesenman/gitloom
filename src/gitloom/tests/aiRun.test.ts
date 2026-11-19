import { describe, it, expect, vi } from 'vitest'
import { AIRun, LRU, aiTag, singleFlight, abortError } from '../src/renderer/src/lib/aiRun'

/** Controllable fake streaming request. */
function fakeStream() {
  const calls: { signal: AbortSignal; delta: (s: string) => void; resolve: (s: string) => void; reject: (e: unknown) => void }[] = []
  const fn = (signal: AbortSignal, delta: (s: string) => void) => new Promise<string>((resolve, reject) => {
    calls.push({ signal, delta, resolve, reject })
    signal.addEventListener('abort', () => reject(abortError()))
  })
  return { fn, calls }
}
const manual = () => { const q: (() => void)[] = []; return { schedule: (cb: () => void) => { q.push(cb) }, flush: () => { while (q.length) q.shift()!() }, size: () => q.length } }
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('AIRun single-flight / cancel / cache / throttle', () => {
  it('5 rapid starts for the same key → 1 request', () => {
    const s = fakeStream(); const r = new AIRun({ schedule: manual().schedule })
    const started = [1, 2, 3, 4, 5].map(() => r.start('repo|sha1|m', s.fn))
    expect(started).toEqual([true, false, false, false, false])
    expect(s.calls.length).toBe(1)
    expect(r.getState().status).toBe('running')
  })

  it('throttles streamed text to one publish per frame and ignores stale frames', async () => {
    const m = manual(); const s = fakeStream(); const r = new AIRun({ schedule: m.schedule })
    const seen: string[] = []; r.subscribe(() => seen.push(r.getState().text))
    r.start('k', s.fn)
    s.calls[0].delta('a'); s.calls[0].delta('ab'); s.calls[0].delta('abc')
    expect(m.size()).toBe(1)              // one frame scheduled for three deltas
    m.flush()
    expect(r.getState().text).toBe('abc')
    s.calls[0].resolve('abc!'); await tick()
    expect(r.getState()).toMatchObject({ status: 'done', text: 'abc!' })
    // text never went backwards
    for (let i = 1; i < seen.length; i++) expect(seen[i].length).toBeGreaterThanOrEqual(seen[i - 1].length)
  })

  it('stop() aborts the request, keeps the partial text and does not cache it', async () => {
    const m = manual(); const s = fakeStream(); const cache = new LRU<string>(); const r = new AIRun({ schedule: m.schedule, cache })
    r.start('k', s.fn); s.calls[0].delta('部分'); m.flush()
    r.stop()
    expect(s.calls[0].signal.aborted).toBe(true)
    expect(r.getState()).toMatchObject({ status: 'stopped', text: '部分' })
    await tick()
    expect(r.getState().status).toBe('stopped')   // late rejection of the aborted run is ignored
    expect(cache.has('k')).toBe(false)
  })

  it('switching key (select / start other) aborts the old run; its late result is dropped', async () => {
    const s = fakeStream(); const r = new AIRun({ schedule: manual().schedule })
    r.start('sha1', s.fn)
    r.select('sha2')
    expect(s.calls[0].signal.aborted).toBe(true)
    expect(r.getState()).toMatchObject({ status: 'idle', key: 'sha2' })
    s.calls[0].resolve('old'); await tick()
    expect(r.getState().text).toBe('')
    r.start('sha2', s.fn); r.start('sha3', s.fn)
    expect(s.calls[1].signal.aborted).toBe(true)
    expect(r.getState().key).toBe('sha3')
  })

  it('cache hit is instant and makes no request; force (重新生成) bypasses it', async () => {
    const s = fakeStream(); const cache = new LRU<string>(); const r = new AIRun({ schedule: manual().schedule, cache })
    r.start('sha1', s.fn); s.calls[0].resolve('结果'); await tick()
    r.select('sha2'); r.select('sha1')
    expect(r.getState()).toMatchObject({ status: 'done', text: '结果', cached: true })
    expect(r.start('sha1', s.fn)).toBe(false)
    expect(s.calls.length).toBe(1)
    expect(r.start('sha1', s.fn, { force: true })).toBe(true)
    expect(s.calls.length).toBe(2)
  })

  it('errors become an error state with the message (for inline 重试)', async () => {
    const r = new AIRun({ schedule: manual().schedule, errText: (e) => `中文：${(e as Error).message}` })
    r.start('k', () => Promise.reject(new Error('401')))
    await tick()
    expect(r.getState()).toMatchObject({ status: 'error', error: '中文：401' })
  })

  it('dispose() (unmount) aborts', () => {
    const s = fakeStream(); const r = new AIRun({ schedule: manual().schedule })
    r.start('k', s.fn); r.dispose()
    expect(s.calls[0].signal.aborted).toBe(true)
  })

  it('LRU evicts the oldest entry', () => {
    const c = new LRU<number>(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3)
    expect(c.has('a')).toBe(true); expect(c.has('b')).toBe(false)
  })
})

describe('singleFlight + aiTag', () => {
  it('concurrent calls with the same key share one run', async () => {
    const fn = vi.fn(async (x: string) => { await tick(); return x })
    const g = singleFlight(fn, (x) => x)
    const r = await Promise.all([g('fetch'), g('fetch'), g('fetch'), g('push')])
    expect(fn).toHaveBeenCalledTimes(2)
    expect(r).toEqual(['fetch', 'fetch', 'fetch', 'push'])
    await g('fetch'); expect(fn).toHaveBeenCalledTimes(3)   // free again once finished
  })
  it('aiTag changes with provider / model / task override', () => {
    const ai = { activeProfile: 'a', profiles: [{ id: 'a', preset: 'deepseek', model: 'deepseek-chat' }, { id: 'b', preset: 'anthropic', model: 'claude' }], tasks: { review: { profile: 'b' } } }
    expect(aiTag(ai, 'explain')).toBe('deepseek:a:deepseek-chat')
    expect(aiTag(ai, 'review')).toBe('anthropic:b:claude')
    expect(aiTag({ ...ai, tasks: { explain: { model: 'deepseek-reasoner' } } }, 'explain')).toBe('deepseek:a:deepseek-reasoner')
  })
})
