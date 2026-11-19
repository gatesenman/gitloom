/** Wiki Lint：孤儿页 / 空 index → info 发现 */
import { createHash } from 'crypto'
import { promises as fsp, existsSync } from 'fs'
import * as path from 'path'
import type { Finding } from '../../shared/health'

function fid(...p: string[]): string {
  return 'wiki-' + createHash('sha1').update(p.join('|')).digest('hex').slice(0, 12)
}

export async function wikiLintFindings(wikiRoot: string, repo?: string): Promise<Finding[]> {
  if (!wikiRoot || !existsSync(wikiRoot)) return []
  const out: Finding[] = []
  const indexPath = path.join(wikiRoot, 'index.md')
  let index = ''
  try { index = await fsp.readFile(indexPath, 'utf8') } catch { /* */ }
  if (!index.trim() || !/\[.+\]\(.+\)/.test(index) && !/pages\//.test(index)) {
    // empty-ish index
    const body = index.replace(/^#.*$/m, '').replace(/^[>].*$/gm, '').replace(/^##\s*页面\s*$/m, '').trim()
    if (!body || body.includes('建库后') || !/\[/.test(body)) {
      out.push({
        id: fid('empty-index', wikiRoot),
        severity: 'info',
        category: 'wiki',
        title: 'Wiki index 几乎为空',
        detail: 'index.md 尚无有效页面条目，可先吸收提交或手动添加页面。',
        evidence: { path: 'index.md', line: 1 },
        fix: '在架构与知识页执行「吸收最近提交」，或编辑 index.md。',
        source: 'wiki',
        confidence: 'high',
        status: 'open',
        repo
      })
    }
  }
  const pagesDir = path.join(wikiRoot, 'pages')
  let files: string[] = []
  try {
    const walk = async (dir: string, rel = ''): Promise<void> => {
      const ents = await fsp.readdir(dir, { withFileTypes: true })
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) await walk(path.join(dir, e.name), r)
        else if (/\.md$/i.test(e.name)) files.push(r.replace(/\\/g, '/'))
      }
    }
    if (existsSync(pagesDir)) await walk(pagesDir)
  } catch { /* */ }
  const linked = new Set<string>()
  for (const m of index.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let t = m[1].replace(/^\.\//, '').replace(/^pages\//, '').replace(/\.md$/i, '')
    linked.add(t)
    linked.add(t + '.md')
    linked.add('pages/' + t)
    linked.add('pages/' + t + '.md')
  }
  for (const f of files) {
    const stem = f.replace(/\.md$/i, '')
    const hit = linked.has(f) || linked.has(stem) || linked.has('pages/' + f) || linked.has('pages/' + stem)
      || [...linked].some((l) => l.endsWith(f) || l.endsWith(stem))
    if (hit) continue
    out.push({
      id: fid('orphan', f),
      severity: 'info',
      category: 'wiki',
      title: `Wiki 孤儿页：${f}`,
      detail: '该页未在 index.md 中出现链接。',
      evidence: { path: `pages/${f}`, line: 1 },
      fix: '在 index.md 增加条目，或删除过时页面。',
      source: 'wiki',
      confidence: 'medium',
      status: 'open',
      repo
    })
  }
  return out
}
