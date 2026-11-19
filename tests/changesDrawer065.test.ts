import { describe, expect, it } from 'vitest'
import {
  CHANGES_DRAWER_DEFAULT_W,
  CHANGES_DRAWER_MAX_W,
  CHANGES_DRAWER_MIN_W,
  CHANGES_DRAWER_OPEN_KEY,
  clampDrawerWidth,
  changesDrawerClass,
  defaultDrawerOpen
} from '../src/renderer/src/lib/changesDrawer'

describe('changes right drawer (0.6.5-hotfix.3)', () => {
  it('opens by default when entering 变更 view', () => {
    expect(defaultDrawerOpen()).toBe(true)
    expect(CHANGES_DRAWER_OPEN_KEY).toBe('gitloom.changes.drawerOpen')
  })

  it('uses docked drawer class with open modifier for slide-in', () => {
    expect(changesDrawerClass(true)).toBe('changes-drawer open')
    expect(changesDrawerClass(false)).toBe('changes-drawer')
  })

  it('clamps drawer width in the 300–560 band (target ~380–420)', () => {
    expect(CHANGES_DRAWER_DEFAULT_W).toBe(400)
    expect(clampDrawerWidth(200)).toBe(CHANGES_DRAWER_MIN_W)
    expect(clampDrawerWidth(900)).toBe(CHANGES_DRAWER_MAX_W)
    expect(clampDrawerWidth(400)).toBe(400)
  })

  it('collapse handle + drawer testids are wired in ChangesView source', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../src/renderer/src/views/ChangesView.tsx', import.meta.url), 'utf8')
    expect(src).toContain('data-testid="changes-drawer"')
    expect(src).toContain('data-testid="changes-drawer-handle"')
    expect(src).toContain('data-testid="changes-drawer-toggle"')
    expect(src).toContain('data-testid="changes-drawer-collapse"')
    expect(src).toContain('changes-workspace')
    // Diff is the main canvas; file list lives in the drawer
    expect(src).toMatch(/changes-canvas[\s\S]*DiffPane/)
    expect(src).toMatch(/changes-drawer[\s\S]*CommitBox/)
  })
})
