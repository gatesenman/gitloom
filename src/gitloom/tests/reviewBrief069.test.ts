import { describe, it, expect } from 'vitest'
import { buildReviewBrief, reviewBriefFilename } from '../src/renderer/src/lib/reviewBrief'
import type { ChangeSummary } from '../src/renderer/src/lib/changeSummary'

const sum: ChangeSummary = {
  headline: { text: '改了 2 个文件', evidence: [], confidence: 'high' },
  stats: { files: 2, add: 10, del: 3, fnAdded: 1, fnRemoved: 0, fnModified: 1, modules: 1, depsChanged: 0, affectedFiles: 4 },
  risks: [
    { id: 'hub', level: '高', title: '改了核心文件', detail: '影响面大', evidence: [{ file: 'a.ts', line: 1 }], confidence: 'high' },
    { id: 'no-tests', level: '中', title: '没改测试', detail: '建议补测', evidence: [], confidence: 'medium' }
  ],
  modules: [{ id: 'm1', name: 'core', layer: '服务', status: 'modified', changed: 2, blast: 4, files: ['a.ts', 'b.ts'], evidence: [] }],
  files: [
    { path: 'a.ts', status: 'modified', add: 8, del: 2, blast: 4, hub: true, module: 'm1', fns: [1, 0, 1], importers: ['x.ts'] },
    { path: 'b.ts', status: 'added', add: 2, del: 0, blast: 0, hub: false, module: 'm1', importers: [] }
  ]
}

describe('0.6.9 审阅一页纸', () => {
  it('buildReviewBrief includes scope risk files tip', () => {
    const md = buildReviewBrief(sum, { repoName: 'demo', scopeLabel: '工作区改动', generatedAt: Date.parse('2026-11-01T09:00:00+08:00') })
    expect(md).toMatch(/# 审阅一页纸/)
    expect(md).toMatch(/工作区改动/)
    expect(md).toMatch(/风险摘要/)
    expect(md).toMatch(/改了核心文件/)
    expect(md).toMatch(/`a\.ts`/)
    expect(md).toMatch(/可视化/)
  })

  it('reviewBriefFilename is safe', () => {
    expect(reviewBriefFilename('my repo!')).toMatch(/^审阅一页纸-my_repo_-\d{8}\.md$/)
  })
})
