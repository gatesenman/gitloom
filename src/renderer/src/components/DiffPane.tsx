import React, { useEffect, useState } from 'react'
import { SafeDiffEditor as DiffEditor } from './SafeDiffEditor'
import type { DiffContents } from '@shared/types'
import { git, errMsg, type DiffSource } from '../api'
import { useApp } from '../state'
import { Icon } from './Icon'
import { Empty, Skeleton, Spinner } from './ui'

/** 并排 / 统一 toggle (shared by every diff toolbar). */
export function DiffModeToggle() {
  const { settings, saveSettings } = useApp()
  const split = (settings?.diffMode ?? 'split') === 'split'
  const fold = settings?.diffFoldUnchanged ?? true
  return (<>
    <button className={`btn btn-sm btn-ghost diff-fold ${fold ? '' : 'on'}`} data-testid="diff-fold" aria-pressed={!fold}
      onClick={() => settings && saveSettings({ ...settings, diffFoldUnchanged: !fold })}
      title={fold ? '当前折叠了未改动的代码（点折叠条可单独展开）。点此显示全部行' : '当前显示全部行。点此重新折叠未改动的代码'}>
      <Icon name={fold ? 'expand-all' : 'collapse-all'} size={13} /><span className="lbl">{fold ? '显示全部行' : '折叠未改动'}</span></button>
    <div className="seg" role="group" aria-label="差异布局">
      <button className={split ? 'on' : ''} onClick={() => settings && saveSettings({ ...settings, diffMode: 'split' })} title="并排：左右对比修改前后"><Icon name="split" size={13} />并排</button>
      <button className={!split ? 'on' : ''} onClick={() => settings && saveSettings({ ...settings, diffMode: 'inline' })} title="统一：上下合并显示增删行"><Icon name="inline" size={13} />统一</button>
    </div>
  </>)
}

export function DiffPane({ repo, file, source, origPath, header, toolbar, bare }: {
  repo: string; file: string | null; source: DiffSource; origPath?: string; header?: React.ReactNode; toolbar?: React.ReactNode
  /** omit the built-in header (the host renders its own toolbar) */
  bare?: boolean
}) {
  const { settings, theme, tick } = useApp()
  const [data, setData] = useState<DiffContents | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const split = (settings?.diffMode ?? 'split') === 'split'
  const key = JSON.stringify(source)
  // reload when file/source changes, or on status tick for working-tree diffs
  const live = source.kind === 'unstaged' || source.kind === 'staged'
  useEffect(() => {
    if (!file) { setData(null); return }
    let alive = true
    setLoading(true)
    git.diffContents(repo, file, source, origPath)
      .then((d) => { if (alive) { setData((old) => old && old.original === d.original && old.modified === d.modified ? old : d); setErr(null) } })
      .catch((e) => alive && setErr(errMsg(e)))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, file, key, origPath, live ? tick : 0])

  if (!file) return <Empty icon="diff" title="选择文件以查看差异">在右侧变更列表中选择一个文件，在此并排对比修改前后的内容。</Empty>
  return (
    <div className="diff-pane">
      {!bare && <div className="diff-head">
        <Icon name="file" size={14} />
        <span className="diff-path" title={file}>{origPath && origPath !== file ? <><span className="dir">{origPath}</span> <span className="muted">→</span> </> : null}{file.includes('/') && <span className="dir">{file.slice(0, file.lastIndexOf('/') + 1)}</span>}{file.split('/').pop()}</span>
        {header}
        {loading && <Spinner />}
        <div className="flex1" />
        {toolbar}
        <DiffModeToggle />
      </div>}
      <div className="diff-body">
        {err ? <Empty icon="warn" title="无法加载差异">{err}</Empty>
          : data?.binary ? <Empty icon="file" title="二进制文件">二进制文件不显示文本差异。</Empty>
          : data?.tooLarge ? <Empty icon="warn" title="文件过大">文件超过 4MB，已跳过渲染以保持流畅。</Empty>
          : data ? (
            <DiffEditor
              original={data.original}
              modified={data.modified}
              language={data.language}
              theme={theme === 'dark' ? 'gitloom-dark' : 'gitloom-light'}
              options={{
                readOnly: true, renderSideBySide: split, automaticLayout: true, minimap: { enabled: false },
                fontSize: settings?.fontSize ?? 13, fontFamily: "'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, 'Noto Sans Mono CJK SC', monospace", fontLigatures: false, lineHeight: 20, padding: { top: 8 },
                scrollBeyondLastLine: false, renderOverviewRuler: true, ignoreTrimWhitespace: false, originalEditable: false,
                hideUnchangedRegions: { enabled: settings?.diffFoldUnchanged ?? true, contextLineCount: 4, minimumLineCount: 6, revealLineCount: 20 },
                diffAlgorithm: 'advanced', renderIndicators: true, wordWrap: 'off', lineNumbersMinChars: 3, glyphMargin: false, renderLineHighlight: 'gutter', scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false }, overviewRulerBorder: false, smoothScrolling: true,
                useInlineViewWhenSpaceIsLimited: true, renderSideBySideInlineBreakpoint: 560,
                unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false }
              }}
            />
          ) : <Skeleton rows={12} variant="cards" />}
      </div>
    </div>
  )
}
