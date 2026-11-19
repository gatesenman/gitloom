/** 看懂改动 · 审阅一页纸：从 ChangeSummary 生成可复制/下载的 Markdown */

import type { ChangeSummary } from './changeSummary'

export type ReviewBriefOpts = {
  repoName?: string
  scopeLabel?: string
  /** 可选可视化提示 */
  vizTip?: string
  generatedAt?: number
}

const STATUS_TXT: Record<string, string> = {
  added: '新增', removed: '删除', modified: '修改', moved: '移动', unchanged: '未变'
}

/** 一页纸审阅简报（Markdown） */
export function buildReviewBrief(sum: ChangeSummary, opts: ReviewBriefOpts = {}): string {
  const at = new Date(opts.generatedAt ?? Date.now())
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  const lines: string[] = [
    '# 审阅一页纸',
    '',
    opts.repoName ? `- 仓库：${opts.repoName}` : '',
    opts.scopeLabel ? `- 范围：${opts.scopeLabel}` : '',
    `- 生成时间：${stamp}`,
    '',
    '## 范围与摘要',
    '',
    sum.headline.text,
    '',
    `- 文件 **${sum.stats.files}** · 行 **+${sum.stats.add} / −${sum.stats.del}**`,
    `- 函数 增/删/改：**${sum.stats.fnAdded}/${sum.stats.fnRemoved}/${sum.stats.fnModified}**`,
    `- 模块 **${sum.stats.modules}** · 依赖变化 **${sum.stats.depsChanged}** · 间接受影响文件 **${sum.stats.affectedFiles}**`,
    '',
    '## 风险摘要',
    ''
  ].filter((x) => x !== '')

  if (!sum.risks.length) {
    lines.push('没有发现明显风险（静态规则）。', '')
  } else {
    for (const r of sum.risks.slice(0, 8)) {
      lines.push(`- **[${r.level}] ${r.title}** — ${r.detail}`)
      if (r.evidence.length) {
        lines.push(`  - 依据：${r.evidence.slice(0, 4).map((e) => `\`${e.file}${e.line ? ':' + e.line : ''}\``).join('、')}`)
      }
    }
    lines.push('')
  }

  lines.push('## 影响模块', '')
  if (!sum.modules.length) {
    lines.push('（无可归类模块，可能只改了文档或配置。）', '')
  } else {
    for (const m of sum.modules.slice(0, 12)) {
      lines.push(`- **${m.layer} / ${m.name}**：${STATUS_TXT[m.status] ?? m.status} · ${m.changed} 文件${m.blast ? ` · 影响面 ${m.blast}` : ''}`)
    }
    if (sum.modules.length > 12) lines.push(`- …另有 ${sum.modules.length - 12} 个模块`)
    lines.push('')
  }

  lines.push('## 文件列表（按影响面）', '')
  const topFiles = sum.files.slice(0, 40)
  for (const f of topFiles) {
    const mark = f.hub ? ' ★热点' : ''
    lines.push(`- \`${f.path}\` · ${STATUS_TXT[f.status] ?? f.status} · +${f.add}/−${f.del}${f.blast ? ` · 影响 ${f.blast}` : ''}${mark}`)
  }
  if (sum.files.length > topFiles.length) lines.push(`- …共 ${sum.files.length} 个文件，此处列出前 ${topFiles.length} 个`)
  lines.push('')

  const findings = sum.risks.filter((r) => r.level === '高' || r.level === '中').slice(0, 5)
  lines.push('## 重点发现 / 可视化建议', '')
  if (findings.length) {
    lines.push('建议优先看：')
    for (const r of findings) lines.push(`- ${r.title}`)
    lines.push('')
  }
  const tip = opts.vizTip
    ?? (sum.risks.some((r) => r.id === 'hub' || r.id === 'blast')
      ? '打开「看懂改动 → 可视化」看影响范围图与前后对比图，热点文件优先审。'
      : '可用「打开可视化」看前后对比图 / 代码地图，帮助把握改动结构。')
  lines.push(`> ${tip}`, '')
  lines.push('---', '_由 GitLoom「改动摘要 · 导出审阅一页纸」生成_')
  return lines.join('\n')
}

export function reviewBriefFilename(repoName?: string): string {
  const safe = (repoName || 'repo').replace(/[^\w.-]+/g, '_').slice(0, 40)
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `审阅一页纸-${safe}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.md`
}

/** 触发浏览器下载 Markdown 文本 */
export function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
