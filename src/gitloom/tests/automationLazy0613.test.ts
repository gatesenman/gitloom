/**
 * 0.6.13: opening 自动化 must not sync-import ModuleHubs / xyflow / health panels.
 * Source-level guards so a future eager import regresses CI.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const root = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

describe('0.6.13 automation open stays off Knowledge/Quality chunk', () => {
  it('App.tsx lazy-loads AutomationHub / ModuleHubs (no eager hub imports)', () => {
    const app = read('src/renderer/src/App.tsx')
    expect(app).not.toMatch(/import\s+\{\s*KnowledgeView,\s*QualityView\s*\}\s+from\s+['\"]\.\/views\/ModuleHubs['\"]/)
    expect(app).not.toMatch(/import\s+\{\s*AutomationView\s*\}\s+from\s+['\"]\.\/views\/AutomationHub['\"]/)
    expect(app).toMatch(/lazy\(\(\)\s*=>\s*import\(['\"]\.\/views\/AutomationHub['\"]\)/)
    expect(app).toMatch(/lazy\(\(\)\s*=>\s*import\(['\"]\.\/views\/ModuleHubs['\"]\)/)
    expect(app).toMatch(/function KeepHub/)
  })

  it('AutomationHub does not import ModuleHubs, xyflow, monaco, or health panels', () => {
    const hub = read('src/renderer/src/views/AutomationHub.tsx')
    expect(hub).not.toMatch(/from ['"][^'"]*ModuleHubs/)
    expect(hub).not.toMatch(/@xyflow/)
    expect(hub).not.toMatch(/from ['"][^'"]*monaco/i)
    expect(hub).not.toMatch(/import\(['"][^'"]*(HealthReport|KnowledgeGraph|ArchGraph)/)
    expect(hub).toMatch(/lazy\(\(\)\s*=>\s*import\(['\"]\.\/EventRulesPanel['\"]\)/)
    expect(hub).toMatch(/lazy\(\(\)\s*=>\s*import\(['\"]\.\/HooksView['\"]\)/)
    expect(hub).toMatch(/lazy\(\(\)\s*=>\s*import\(['\"]\.\/TasksPanel['\"]\)/)
    expect(hub).toMatch(/function Deferred/)
  })

  it('ModuleHubs lazy-loads Tasks/Health/xyflow panels (no sync barrel pull)', () => {
    const mod = read('src/renderer/src/views/ModuleHubs.tsx')
    expect(mod).not.toMatch(/^import TasksPanel from/m)
    expect(mod).not.toMatch(/^import \{ HealthReportPanel/m)
    expect(mod).not.toMatch(/^import \{ KnowledgeGraphPanel/m)
    expect(mod).not.toMatch(/^import \{ ArchGraphEmbed/m)
    expect(mod).toMatch(/lazy\(\(\)\s*=>\s*import\(['\"]\.\/TasksPanel['\"]\)/)
    expect(mod).toMatch(/lazy\(\(\)\s*=>\s*import\(['\"]\.\/health\/HealthReportPanel['\"]/)
    expect(mod).toMatch(/lazy\(\(\)\s*=>\s*import\(['\"]\.\/knowledge\/KnowledgeGraphPanel['\"]/)
  })

  it('package version is 0.6.14', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string }
    expect(pkg.version).toBe('0.6.14')
  })
})
