/**
 * 0.6.14: 自动化 → 钩子 secondary tab must always be selectable (empty state when no repo),
 * never disabled / skipped / tooltip-only. Idle-prefetch AutomationHub after shell idle.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const root = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

describe('0.6.14 hooks tab always reachable + idle prefetch', () => {
  it('automation strip hooks tab is not disabled={!active}', () => {
    const app = read('src/renderer/src/App.tsx')
    const start = app.indexOf("strip === 'automation'")
    const end = app.indexOf("data-strip=\"daily\"", start)
    const strip = app.slice(start, end > start ? end : start + 2500)
    expect(strip).toMatch(/data-testid="auto-tab-hooks"/)
    const hooksLine = strip.split('\n').find((l) => l.includes('auto-tab-hooks'))
    expect(hooksLine).toBeTruthy()
    expect(hooksLine!).not.toMatch(/disabled=\{!active\}/)
    expect(strip).toMatch(/data-testid="auto-tab-events"/)
    expect(strip).toMatch(/data-testid="auto-tab-tasks"/)
  })

  it('AutomationHub shows empty state when no active repo', () => {
    const hub = read('src/renderer/src/views/AutomationHub.tsx')
    expect(hub).toMatch(/data-testid="auto-hooks-empty"/)
    expect(hub).toMatch(/data-testid="auto-hooks-goto-repos"/)
    expect(hub).toMatch(/先在左侧|左侧边栏|仓库与扫描/)
    expect(hub).toMatch(/\{active \? \(/)
  })

  it('App idle-prefetches AutomationHub; KeepHub + lazy hubs preserved', () => {
    const app = read('src/renderer/src/App.tsx')
    expect(app).toMatch(/requestIdleCallback/)
    expect(app).toMatch(/void import\(['"]\.\/views\/AutomationHub['"]\)/)
    expect(app).toMatch(/0\.6\.14: idle-prefetch AutomationHub/)
    expect(app).toMatch(/lazy\(\(\)\s*=>\s*import\(['"]\.\/views\/AutomationHub['"]\)\)/)
    expect(app).toMatch(/function KeepHub/)
    expect(app).not.toMatch(/import\s+\{\s*AutomationView\s*\}\s+from\s+['"]\.\/views\/AutomationHub['"]/)
    expect(app).toMatch(/lazy\(\(\)\s*=>\s*import\(['"]\.\/views\/ModuleHubs['"]\)/)
  })

  it('package version is 0.6.14', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string }
    expect(pkg.version).toBe('0.6.14')
  })
})
