/** Changes view right drawer: docked panel (not modal) so Diff stays interactive. */

export const CHANGES_DRAWER_OPEN_KEY = 'gitloom.changes.drawerOpen'
export const CHANGES_DRAWER_W_KEY = 'gitloom.changes.drawerW'
export const CHANGES_DRAWER_DEFAULT_W = 400
export const CHANGES_DRAWER_MIN_W = 300
export const CHANGES_DRAWER_MAX_W = 560

/** Opening「变更」auto-opens the drawer; persisted preference may collapse it. */
export function defaultDrawerOpen(): boolean {
  return true
}

export function clampDrawerWidth(w: number): number {
  return Math.max(CHANGES_DRAWER_MIN_W, Math.min(CHANGES_DRAWER_MAX_W, w))
}

/** Class list for the docked drawer element. */
export function changesDrawerClass(open: boolean): string {
  return `changes-drawer${open ? ' open' : ''}`
}
