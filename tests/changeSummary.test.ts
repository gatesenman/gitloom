// 0.6.1 看懂改动 summary + 当前架构 C4 on the real hub fixture
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { VizService } from '../src/main/viz/service'
import { localDeps } from '../src/main/viz/local'
// @ts-expect-error plain .mjs fixture builder
import { makeHub } from '../scripts/viz-fixtures.mjs'
import type { VizResult } from '../src/shared/viz'
import { buildSummary, buildC4, riskHints, componentFor } from '../src/renderer/src/lib/changeSummary'

const svc = new VizService(localDeps('node_modules/tree-sitter-wasms/out', 'node_modules/web-tree-sitter/tree-sitter.wasm'))
let pr: VizResult, head: VizResult
beforeAll(async () => {
  const hub = makeHub(join(mkdtempSync(join(tmpdir(), 'viz-sum-')), 'shop'))
  pr = await svc.analyze({ repo: hub, scope: { kind: 'refs', base: 'main', head: 'feature/coupons' } })
  head = await svc.analyze({ repo: hub, scope: { kind: 'commit', sha: 'main' } })
}, 120000)

describe('change summary', () => {
  it('stats, headline and per-file evidence', () => {
    const s = buildSummary(pr)
    expect(s.stats.files).toBe(pr.files.length)
    expect(s.stats.add).toBeGreaterThan(0)
    expect(s.headline.text).toMatch(/改了 \d+ 个文件/)
    expect(s.headline.evidence.length).toBeGreaterThan(0)
    expect(s.files[0].blast).toBeGreaterThanOrEqual(s.files[s.files.length - 1].blast)
  })
  it('affected modules each cite files', () => {
    const s = buildSummary(pr)
    expect(s.modules.length).toBeGreaterThan(0)
    for (const m of s.modules) { expect(m.evidence.length).toBeGreaterThan(0); expect(m.files.length).toBe(m.changed) }
  })
  it('flags the hub file config.ts as high risk with evidence', () => {
    const hub = buildSummary(pr).risks.find((r) => r.id === 'hub')!
    expect(hub.level).toBe('高')
    expect(hub.evidence.map((e) => e.file)).toContain('src/config.ts')
  })
  it('risk rules are pure', () => {
    const files = [{ path: 'package.json', status: 'modified' as const, add: 1, del: 1, blast: 0, hub: false, importers: [] }, { path: 'src/a.ts', status: 'modified' as const, add: 30, del: 0, blast: 0, hub: false, importers: [] }]
    const ids = riskHints(files, { files: 2, add: 31, del: 1, fnAdded: 0, fnRemoved: 0, fnModified: 0, depsChanged: 0, modules: 1, affectedFiles: 0 }, {}).map((r) => r.id)
    expect(ids).toEqual(expect.arrayContaining(['config', 'no-tests']))
    expect(componentFor('src/x/y.ts', [{ id: 'a:src/x', label: 'x', kind: 'component', status: 'unchanged' }, { id: 'a:src', label: 's', kind: 'component', status: 'unchanged' }])?.id).toBe('a:src/x')
  })
  it('empty change', () => {
    expect(buildSummary({ ...pr, files: [] }).headline.text).toMatch(/没有文件改动/)
  })
})

describe('current architecture (C4)', () => {
  it('containers → components with evidence + confidence', () => {
    const c4 = buildC4(head, 'shop')
    expect(c4.system.name).toBe('shop')
    expect(c4.containers.length).toBeGreaterThan(0)
    const comps = c4.containers.flatMap((c) => c.components)
    expect(comps.length).toBeGreaterThan(1)
    expect(comps.some((c) => c.confidence === 'high')).toBe(true)
    expect(comps.filter((c) => c.files > 0).every((c) => c.evidence.every((e) => e.file && e.line))).toBe(true)
    expect(c4.notes.join('')).toMatch(/置信度/)
  })
})
