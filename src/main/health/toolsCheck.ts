/** 未安装的推荐工具 → info 级发现（非错误） */
import { createHash } from 'crypto'
import type { Finding } from '../../shared/health'
import { manualInstallHint } from '../tools/detect'

const RECOMMENDED: { id: string; name: string }[] = [
  { id: 'ocr', name: 'OpenCodeReview（ocr）' },
  { id: 'semgrep', name: 'Semgrep' },
  { id: 'osv-scanner', name: 'OSV Scanner（依赖漏洞）' }
]

function fid(id: string): string {
  return 'tool-' + createHash('sha1').update(id).digest('hex').slice(0, 12)
}

export function toolFindings(tools: { id: string; found: boolean; version?: string }[], repo?: string): Finding[] {
  const map = new Map(tools.map((t) => [t.id, t]))
  const out: Finding[] = []
  for (const r of RECOMMENDED) {
    const t = map.get(r.id)
    if (t?.found) continue
    const install = manualInstallHint(r.id)
    out.push({
      id: fid(r.id),
      severity: 'info',
      category: 'tool',
      title: `未安装推荐工具：${r.name}`,
      detail: `安装后可增强质量把关能力。安装：${install}`,
      evidence: {},
      fix: install,
      source: 'builtin',
      confidence: 'high',
      status: 'open',
      repo
    })
  }
  return out
}
