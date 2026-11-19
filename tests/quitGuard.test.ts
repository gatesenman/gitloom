import { describe, it, expect, vi } from 'vitest'
import { isQuitDestroyedError, safeInvoke } from '../src/main/quitGuard'

describe('quitGuard (0.6.5-hotfix.1 regression)', () => {
  it('matches Electron destroyed-object messages', () => {
    expect(isQuitDestroyedError(new TypeError('Object has been destroyed'))).toBe(true)
    expect(isQuitDestroyedError(new Error('Render frame was disposed'))).toBe(true)
    expect(isQuitDestroyedError('Error: WebFrameMain was destroyed')).toBe(true)
    expect(isQuitDestroyedError(new Error('ENOENT: no such file'))).toBe(false)
  })

  it('safeInvoke skips missing callback and swallows throws', () => {
    expect(() => safeInvoke(undefined, { id: 1 })).not.toThrow()
    const bad = vi.fn(() => { throw new TypeError('Object has been destroyed') })
    expect(() => safeInvoke(bad, { id: 2 })).not.toThrow()
    expect(bad).toHaveBeenCalledOnce()
    const ok = vi.fn()
    safeInvoke(ok, { id: 3 })
    expect(ok).toHaveBeenCalledWith({ id: 3 })
  })
})
