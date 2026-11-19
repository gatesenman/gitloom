/** HEAD 模块依赖架构图 — 内嵌于「架构与知识」，绝不 setView。图节点过时检测 + 导出。 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VizScope } from '@shared/viz'
import { viz, errMsg } from '../../api'
import { useApp } from '../../state'
import { Icon } from '../../components/Icon'
import { Spinner, useToast } from '../../components/ui'
import { GraphDiff, type ExportApi } from '../../components/viz/GraphDiff'
import { presentGraph, toMermaid } from '../../lib/vizGraph'
import { archToDot, archToStructurizr, exportFilename } from '../../lib/knowledgeExport'
import { useAnalysis, Empty, Loading } from '../UnderstandViews'

const SCOPE: VizScope = { kind: 'commit', sha: 'HEAD' }

export function ArchGraphEmbed() {
  const { active } = useApp()
  const toast = useToast()
  const { res, busy, err, prog, run } = useAnalysis(active, active ? SCOPE : null)
  const [sel, setSel] = useState<string | null>(null)
  const [staleIds, setStaleIds] = useState<string[]>([])
  const [staleOnly, setStaleOnly] = useState(false)
  const [staleIdx, setStaleIdx] = useState(0)
  const apiRef = useRef<ExportApi | null>(null)
  const graph = useMemo(() => (res?.arch ? presentGraph(res.arch) : null), [res?.arch])

  const refreshStale = useCallback(async () => {
    if (!active || !graph) { setStaleIds([]); return }
    const paths: string[] = []
    const idByPath = new Map<string, string[]>()
    for (const n of graph.nodes) {
      const file = (n.after?.file || n.before?.file || '').replace(/\\/g, '/')
      if (!file) continue
      paths.push(file)
      const arr = idByPath.get(file) || []
      arr.push(n.id)
      idByPath.set(file, arr)
    }
    try {
      const miss = (await window.api.graphMissingPaths?.(active, paths)) as string[] | undefined
      if (!miss) { setStaleIds([]); return }
      const ids = new Set<string>()
      for (const p of miss) for (const id of idByPath.get(p) || []) ids.add(id)
      setStaleIds([...ids])
    } catch { setStaleIds([]) }
  }, [active, graph])

  useEffect(() => { void refreshStale() }, [refreshStale])

  const shownGraph = useMemo(() => {
    if (!graph || !staleOnly || staleIds.length === 0) return graph
    const keep = new Set(staleIds)
    // keep parents of stale leaves so layout still works
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    for (const id of [...keep]) {
      let p = byId.get(id)?.parent
      while (p) { keep.add(p); p = byId.get(p)?.parent }
    }
    return {
      ...graph,
      nodes: graph.nodes.filter((n) => keep.has(n.id)),
      edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target))
    }
  }, [graph, staleOnly, staleIds])

  const focusStale = (dir = 0) => {
    if (!staleIds.length) return
    const next = ((staleIdx + dir) % staleIds.length + staleIds.length) % staleIds.length
    setStaleIdx(next)
    const id = staleIds[next]
    setSel(id)
    apiRef.current?.focus?.(id)
  }

  const doExport = async (format: 'mermaid' | 'dot' | 'dsl', copy: boolean) => {
    if (!graph) return
    const txt =
      format === 'mermaid' ? (apiRef.current?.mermaid() ?? toMermaid(graph, 'flowchart', 'LR'))
        : format === 'dot' ? archToDot(graph)
          : archToStructurizr(graph, active ? active.split(/[/\\]/).pop() || 'App' : 'App')
    const name = exportFilename('gitloom-arch-HEAD', format)
    if (copy) {
      await navigator.clipboard.writeText(txt).catch(() => undefined)
      toast('ok', `已复制 ${format === 'mermaid' ? 'Mermaid' : format === 'dot' ? 'DOT' : 'Structurizr DSL'}（${txt.split('\n').length} 行）`)
      return
    }
    try {
      const path = await window.api.vizSave(name, txt, 'utf8')
      if (path) toast('ok', `已保存 ${path}`)
    } catch (e) { toast('err', errMsg(e)) }
  }

  return (
    <section className="mod-hub-sec" id="k-arch-graph" data-testid="k-arch-graph">
      <div className="mod-hub-sec-head">
        <b title="以最新提交画出模块依赖；本页内嵌，不跳转到看懂改动">模块架构图</b>
        <span className="muted">HEAD · 当前状态</span>
        <div className="flex1" />
        <div className="k-export-bar" data-testid="k-arch-export">
          <button className="btn btn-sm" disabled={!graph} onClick={() => void doExport('mermaid', true)} title="复制 Mermaid">复制 Mermaid</button>
          <button className="btn btn-sm" disabled={!graph} onClick={() => void doExport('mermaid', false)} title="保存 .mmd">导出 Mermaid</button>
          <button className="btn btn-sm btn-ghost" disabled={!graph} onClick={() => void doExport('dot', false)} title="Graphviz DOT">导出 DOT</button>
          <button className="btn btn-sm btn-ghost" disabled={!graph} onClick={() => void doExport('dsl', false)} title="Structurizr DSL">导出 DSL</button>
        </div>
        <button className="btn btn-sm btn-ghost" disabled={busy || !active} onClick={() => void run()} title="重新分析" data-testid="k-arch-refresh">
          {busy ? <Spinner size={12} /> : <Icon name="refresh" size={13} />}
        </button>
      </div>
      {staleIds.length > 0 && (
        <div className="k-stale-bar" data-testid="k-arch-stale-bar">
          <button type="button" className={`btn btn-sm k-stale-btn ${staleOnly ? 'on' : ''}`} data-testid="k-arch-stale-count"
            title="点击聚焦下一个过时节点；可筛选只看过时"
            onClick={() => focusStale(1)}>
            {staleIds.length} 个节点已过时
          </button>
          <button type="button" className={`btn btn-sm ${staleOnly ? 'btn-primary' : ''}`} data-testid="k-arch-stale-filter"
            onClick={() => setStaleOnly((v) => !v)}>{staleOnly ? '显示全部' : '只看过时'}</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void refreshStale()} title="重新检测">重检</button>
        </div>
      )}
      {!active ? (
        <p className="muted">选择仓库后在此显示 HEAD 模块依赖图。</p>
      ) : busy ? (
        <Loading text={`正在分析 HEAD… ${prog}`} />
      ) : err ? (
        <Empty icon="warn" tone="err" title="分析失败" text={err} action={{ label: '重试', onClick: () => void run() }} />
      ) : shownGraph ? (
        <div className="mod-hub-embed mod-hub-canvas-host" data-testid="k-arch-embed">
          <span className="mod-hub-canvas-tip" data-testid="k-arch-canvas-tip">可拖动画布缩放</span>
          <GraphDiff
            ref={(r) => { apiRef.current = r }}
            graph={shownGraph}
            kind="arch"
            mode="overlay"
            present
            focus={false}
            hops={1}
            search=""
            searchIndex={0}
            selected={sel}
            staleIds={staleIds}
            onSelect={(n) => setSel(n?.id ?? null)}
            beforeLabel=""
            afterLabel="HEAD"
            title="模块架构 · HEAD"
            emptyHint={<span className="muted">这次提交没有可画的模块依赖。</span>}
          />
        </div>
      ) : (
        <p className="muted">暂无架构图数据。</p>
      )}
      {sel && res && (
        <p className="muted small" style={{ marginTop: 6 }}>
          已选 <code>{sel}</code>
          {staleIds.includes(sel) && <span className="kg-stale-tag">过时</span>}
          <button className="link small" style={{ marginLeft: 8 }} onClick={() => {
            void viz.snippet(res.id, { after: { file: sel.replace(/^file:/, '').split('#')[0], line: 1, endLine: 40 } })
              .catch((e) => console.warn(errMsg(e)))
          }}>（可在 C4 区点文件看依据）</button>
        </p>
      )}
    </section>
  )
}
