/**
 * Quit-time races: git ChildProcess 'close' / ProjectManager emit can still invoke
 * callbacks after BrowserWindow / webContents are destroyed. Swallow those only —
 * never let them surface Electron's "A JavaScript error occurred in the main process" box.
 *
 * Regression (0.6.5-hotfix.1): GitRunner.onLog → send after close must not throw uncaught.
 */
export function isQuitDestroyedError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err)
  return /Object has been destroyed|Render frame was disposed|WebFrameMain/i.test(msg)
}

/** Invoke an optional log/emit callback; never throw (quit may have cleared the window). */
export function safeInvoke<T>(fn: ((arg: T) => void) | undefined, arg: T): void {
  if (!fn) return
  try {
    fn(arg)
  } catch {
    /* window / webContents already gone */
  }
}
