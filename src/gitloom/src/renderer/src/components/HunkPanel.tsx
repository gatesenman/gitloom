import React, { useEffect, useState } from 'react'
import type { FileDiff } from '@shared/types'
import { git, errMsg } from '../api'
import { useApp } from '../state'
import { Icon } from './Icon'
import { Empty, Skeleton, Spinner, useDialog } from './ui'

/** Hunk + line level staging (GitHub Desktop / Fork style). */
export function HunkPanel({ repo, file, staged }: { repo: string; file: string; staged: boolean }) {
  const { run, tick } = useApp()
  const dialog = useDialog()
  const [fd, setFd] = useState<FileDiff | null | undefined>(undefined)
  const [sel, setSel] = useState<Record<number, Set<number>>>({})
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    git.fileDiff(repo, file, staged).then((d) => { if (alive) { setFd(d); setErr(null) } }).catch((e) => alive && setErr(errMsg(e)))
    return () => { alive = false }
  }, [repo, file, staged, tick])
  useEffect(() => { setSel({}) }, [file, staged])

  if (err) return <Empty icon="warn" title="无法读取差异">{err}</Empty>
  if (fd === undefined) return <Skeleton rows={10} variant="cards" />
  if (!fd || !fd.hunks.length) return <Empty icon="file" title={fd?.binary ? '二进制文件' : '没有可分块的文本差异'}>未跟踪的新文件请整体暂存；二进制文件不支持分块。</Empty>

  const toggle = (h: number, i: number) => setSel((s) => {
    const n = new Set(s[h] ?? [])
    if (n.has(i)) n.delete(i); else n.add(i)
    return { ...s, [h]: n }
  })
  const act = async (h: number, action: 'stage' | 'unstage' | 'discard', lines?: number[]) => {
    if (action === 'discard') {
      const ok = await dialog({ title: '丢弃改动', message: lines ? `丢弃所选 ${lines.length} 行的改动？此操作无法撤销。` : '丢弃整个代码块的改动？此操作无法撤销。', danger: true, okText: '丢弃' })
      if (!ok) return
    }
    const label = action === 'stage' ? '暂存' : action === 'unstage' ? '取消暂存' : '丢弃'
    await run(label, () => git.applyHunk(repo, file, h, action, lines))
    setSel({})
  }

  return (
    <div className="hunks">
      {fd.hunks.map((h, hi) => {
        const chosen = sel[hi] ?? new Set<number>()
        return (
          <div key={hi} className="hunk">
            <div className="hunk-head">
              <code>{h.header}</code>
              <div className="flex1" />
              {chosen.size > 0 && (
                <button className="btn btn-sm" onClick={() => act(hi, staged ? 'unstage' : 'stage', [...chosen])}>
                  {staged ? '取消暂存' : '暂存'}所选 {chosen.size} 行
                </button>
              )}
              {!staged && chosen.size > 0 && <button className="btn btn-sm btn-ghost-danger" onClick={() => act(hi, 'discard', [...chosen])}>丢弃所选行</button>}
              <button className="btn btn-sm btn-primary" onClick={() => act(hi, staged ? 'unstage' : 'stage')}>
                <Icon name={staged ? 'minus' : 'plus'} size={12} />{staged ? '取消暂存此块' : '暂存此块'}
              </button>
              {!staged && <button className="btn btn-sm btn-ghost-danger" title="丢弃此块" onClick={() => act(hi, 'discard')}><Icon name="undo" size={12} /></button>}
            </div>
            <table className="hunk-lines">
              <tbody>
                {h.lines.map((l, li) => {
                  const changeable = l.type === 'add' || l.type === 'del'
                  return (
                    <tr key={li} className={`hl hl-${l.type} ${chosen.has(li) ? 'sel' : ''}`} onClick={() => changeable && toggle(hi, li)}>
                      <td className="hl-check">{changeable && <input type="checkbox" readOnly checked={chosen.has(li)} />}</td>
                      <td className="hl-no">{l.oldNo ?? ''}</td>
                      <td className="hl-no">{l.newNo ?? ''}</td>
                      <td className="hl-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</td>
                      <td className="hl-text">{l.text || ' '}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}
      <div className="hint">提示：点击行可勾选，实现按行暂存 / 取消暂存 / 丢弃。</div>
    </div>
  )
}
