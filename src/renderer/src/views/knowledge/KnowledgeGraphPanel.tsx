import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap,
  type Node, type Edge, MarkerType, useReactFlow
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useApp } from '../../state'
import { Icon } from '../../components/Icon'
import { Spinner, useToast } from '../../components/ui'
import { errMsg } from '../../api'
import {
  knowledgeToMermaid, knowledgeToDot, knowledgeToStructurizr, exportFilename, type KgGraph
} from '../../lib/knowledgeExport'

type GraphMeta = {
  projectId: string; repo?: string; builtAt: number; fileCount: number
  nodeCount: number; edgeCount: number; sampleCap: number; truncated: boolean
}
type GraphStatus = { projectId: string; path: string; exists: boolean; meta: GraphMeta | null }
type GNode = {
  id: string; kind: string; label: string; path?: string; line?: number; endLine?: number
  symbolKind?: string; lang?: string
}
type GEdge = { id: string; from: string; to: string; kind: string; confidence: string; line?: number }
type Neighbor = { edge: GEdge; node: GNode; direction: 'in' | 'out' }
type StaleHit = { id: string; kind: string; label: string; path?: string; reason: string }

const KIND_COLOR: Record<string, string> = {
  file: 'var(--accent)', module: 'var(--mod)', symbol: 'var(--add)', wiki: 'var(--ren)'
}

function layoutSubtree(center: GNode, neighbors: Neighbor[], stale: Set<string>): { nodes: Node[]; edges: Edge[] } {
  const styleOf = (n: GNode, strong: boolean) => ({
    padding: strong ? 8 : 6, borderRadius: 8,
    border: `${strong ? 2 : 1}px solid ${KIND_COLOR[n.kind] || 'var(--border)'}`,
    background: strong ? 'var(--panel)' : 'var(--panel2)',
    fontSize: strong ? 12 : 11, minWidth: strong ? 100 : undefined, maxWidth: strong ? undefined : 140
  })
  const labelOf = (n: GNode) => (
    <span>{n.label}{stale.has(n.id) ? <span className="kg-stale-tag">过时</span> : null}</span>
  )
  const nodes: Node[] = [{
    id: center.id, position: { x: 280, y: 180 },
    data: { label: labelOf(center), kind: center.kind },
    className: stale.has(center.id) ? 'kg-node-stale' : undefined,
    style: styleOf(center, true)
  }]
  const edges: Edge[] = []
  const outs = neighbors.filter((n) => n.direction === 'out').slice(0, 18)
  const inns = neighbors.filter((n) => n.direction === 'in').slice(0, 18)
  outs.forEach((n, i) => {
    const angle = (i / Math.max(outs.length, 1)) * Math.PI - Math.PI / 2
    const x = 280 + Math.cos(angle) * 220
    const y = 180 + Math.sin(angle) * 160
    nodes.push({
      id: n.node.id, position: { x, y }, data: { label: labelOf(n.node), kind: n.node.kind },
      className: stale.has(n.node.id) ? 'kg-node-stale' : undefined,
      style: styleOf(n.node, false)
    })
    edges.push({
      id: n.edge.id, source: center.id, target: n.node.id,
      label: `${n.edge.kind}·${n.edge.confidence}`, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: { stroke: 'var(--border-strong)' }
    })
  })
  inns.forEach((n, i) => {
    const angle = (i / Math.max(inns.length, 1)) * Math.PI + Math.PI / 2
    const x = 280 + Math.cos(angle) * 220
    const y = 180 + Math.sin(angle) * 160
    if (!nodes.some((x) => x.id === n.node.id)) {
      nodes.push({
        id: n.node.id, position: { x, y }, data: { label: labelOf(n.node), kind: n.node.kind },
        className: stale.has(n.node.id) ? 'kg-node-stale' : undefined,
        style: styleOf(n.node, false)
      })
    }
    edges.push({
      id: n.edge.id + ':in', source: n.node.id, target: center.id,
      label: `${n.edge.kind}·${n.edge.confidence}`, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: { stroke: 'var(--border-strong)', opacity: 0.85 }
    })
  })
  return { nodes, edges }
}

function FocusHelper({ nodeId }: { nodeId: string | null }) {
  const rf = useReactFlow()
  useEffect(() => {
    if (!nodeId) return
    try { rf.fitView({ nodes: [{ id: nodeId }], padding: 0.4, duration: 280 }) } catch { /* */ }
  }, [nodeId, rf])
  return null
}

export function KnowledgeGraphPanel() {
  const { project, active } = useApp()
  const toast = useToast()
  const root = project?.root
  const [st, setSt] = useState<GraphStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [prog, setProg] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ node: GNode; score: number }[]>([])
  const [sel, setSel] = useState<GNode | null>(null)
  const [detail, setDetail] = useState<{ node: GNode; inDegree: number; outDegree: number; neighbors: Neighbor[] } | null>(null)
  const [blast, setBlast] = useState<GNode[]>([])
  const [staleHits, setStaleHits] = useState<StaleHit[]>([])
  const [staleOnly, setStaleOnly] = useState(false)
  const [staleIdx, setStaleIdx] = useState(0)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [reqId] = useState(() => 'g-' + Math.random().toString(36).slice(2, 9))

  const staleSet = useMemo(() => new Set(staleHits.map((h) => h.id)), [staleHits])

  const refresh = useCallback(async () => {
    if (!root || !window.api.graphStatus) { setSt(null); return }
    try { setSt(await window.api.graphStatus(root) as GraphStatus) } catch (e) { toast('err', errMsg(e)) }
  }, [root, toast])

  const refreshStale = useCallback(async () => {
    if (!root || !active || !window.api.graphCheckStale) { setStaleHits([]); return }
    try {
      const r = await window.api.graphCheckStale(root, active) as { hits: StaleHit[]; staleIds: string[] }
      setStaleHits(r.hits || [])
    } catch { setStaleHits([]) }
  }, [root, active])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { if (st?.exists) void refreshStale() }, [st?.exists, refreshStale])
  useEffect(() => {
    if (!window.api.onGraphProgress) return
    const off = window.api.onGraphProgress((p) => {
      if (p.reqId && p.reqId !== reqId) return
      setProg(p.text || `${p.phase} ${p.done}/${p.total}`)
    })
    return () => { off?.() }
  }, [reqId])

  const build = async (force = false) => {
    if (!root || !active) { toast('err', '请先选择仓库'); return }
    setBusy(true); setProg('开始构建…')
    try {
      const data = await window.api.graphBuild(root, active, { force, sampleCap: 600 }, reqId) as { meta: GraphMeta }
      toast('ok', `图谱已更新 · ${data.meta.nodeCount} 节点 · ${data.meta.edgeCount} 边`)
      await refresh()
      await refreshStale()
    } catch (e) { toast('err', errMsg(e)) }
    finally { setBusy(false); setProg(null) }
  }

  const doSearch = async () => {
    if (!root || !q.trim()) return
    try {
      let r = await window.api.graphSearch(root, q.trim()) as { node: GNode; score: number }[]
      if (staleOnly) r = r.filter((h) => staleSet.has(h.node.id))
      setHits(r)
      if (r[0]) void selectNode(r[0].node)
    } catch (e) { toast('err', errMsg(e)) }
  }

  const selectNode = async (n: GNode) => {
    if (!root) return
    setSel(n); setBlast([]); setFocusId(n.id)
    try {
      const d = await window.api.graphGetNode(root, n.id) as typeof detail
      setDetail(d)
      const b = await window.api.graphBlastRadius(root, n.id, { maxDepth: 3, cap: 40 }) as { nodes: GNode[] }
      setBlast(b.nodes || [])
    } catch (e) { toast('err', errMsg(e)) }
  }

  const focusStale = async (dir = 1) => {
    if (!staleHits.length) return
    const next = ((staleIdx + dir) % staleHits.length + staleHits.length) % staleHits.length
    setStaleIdx(next)
    const hit = staleHits[next]
    if (!root) return
    try {
      const d = await window.api.graphGetNode(root, hit.id) as typeof detail
      if (d?.node) void selectNode(d.node)
      else {
        setSel({ id: hit.id, kind: hit.kind, label: hit.label, path: hit.path })
        setFocusId(hit.id)
      }
    } catch {
      setSel({ id: hit.id, kind: hit.kind, label: hit.label, path: hit.path })
      setFocusId(hit.id)
    }
  }

  const doExport = async (format: 'mermaid' | 'dot' | 'dsl', copy: boolean) => {
    if (!root || !window.api.graphData) { toast('err', '图谱未就绪'); return }
    try {
      const data = await window.api.graphData(root) as KgGraph | null
      if (!data?.nodes?.length) { toast('err', '请先构建图谱'); return }
      let nodes = data.nodes
      let edges = data.edges
      if (staleOnly && staleSet.size) {
        nodes = nodes.filter((n) => staleSet.has(n.id))
        const keep = new Set(nodes.map((n) => n.id))
        edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to))
      }
      const g: KgGraph = { nodes, edges, meta: (data as { meta?: KgGraph['meta'] }).meta }
      const txt = format === 'mermaid' ? knowledgeToMermaid(g)
        : format === 'dot' ? knowledgeToDot(g)
          : knowledgeToStructurizr(g, project?.name || 'GitLoom')
      const name = exportFilename('gitloom-knowledge', format)
      if (copy) {
        await navigator.clipboard.writeText(txt).catch(() => undefined)
        toast('ok', `已复制 ${format === 'mermaid' ? 'Mermaid' : format === 'dot' ? 'DOT' : 'Structurizr DSL'}（${txt.split('\n').length} 行）`)
        return
      }
      const path = await window.api.vizSave(name, txt, 'utf8')
      if (path) toast('ok', `已保存 ${path}`)
    } catch (e) { toast('err', errMsg(e)) }
  }

  const flow = useMemo(() => {
    if (!detail) return { nodes: [] as Node[], edges: [] as Edge[] }
    let neighbors = detail.neighbors
    if (staleOnly && staleSet.size) {
      neighbors = neighbors.filter((n) => staleSet.has(n.node.id))
    }
    return layoutSubtree(detail.node, neighbors, staleSet)
  }, [detail, staleOnly, staleSet])

  const visibleHits = useMemo(() => {
    if (!staleOnly) return hits
    return hits.filter((h) => staleSet.has(h.node.id))
  }, [hits, staleOnly, staleSet])

  if (!project || !root) {
    return (
      <section className="mod-hub-sec" id="knowledge-graph" data-testid="knowledge-graph">
        <div className="mod-hub-sec-head"><b>知识图谱</b><span className="muted">本机 · 无 Neo4j</span></div>
        <p className="muted">打开项目并选择仓库后，可基于 tree-sitter 构建 File / Module / Symbol 图谱。</p>
      </section>
    )
  }

  return (
    <section className="mod-hub-sec" id="knowledge-graph" data-testid="knowledge-graph">
      <div className="mod-hub-sec-head">
        <b title="复用 FactParser：CONTAINS / IMPORTS / CALLS / DEFINES，边带 confidence">知识图谱</b>
        <span className="muted">本机邻接表 · 增量 hash</span>
        <div className="flex1" />
        <div className="k-export-bar" data-testid="k-graph-export">
          <button className="btn btn-sm" disabled={!st?.exists} onClick={() => void doExport('mermaid', true)}>复制 Mermaid</button>
          <button className="btn btn-sm" disabled={!st?.exists} onClick={() => void doExport('mermaid', false)}>导出 Mermaid</button>
          <button className="btn btn-sm btn-ghost" disabled={!st?.exists} onClick={() => void doExport('dot', false)}>导出 DOT</button>
          <button className="btn btn-sm btn-ghost" disabled={!st?.exists} onClick={() => void doExport('dsl', false)}>导出 DSL</button>
        </div>
        <button className="btn btn-sm btn-primary" disabled={busy || !active} onClick={() => void build(false)} data-testid="graph-build"
          title={!active ? '先选择仓库' : '解析源码并写入 projects/<id>/graph.json'}>
          {busy ? <Spinner size={12} /> : <Icon name="codemap" size={13} />}{st?.exists ? '刷新图谱' : '构建图谱'}
        </button>
        {st?.exists && (
          <button className="btn btn-sm" disabled={busy || !active} onClick={() => void build(true)} title="忽略 hash 全量重建">强制重建</button>
        )}
      </div>
      {prog && <p className="muted small" data-testid="graph-progress">{prog}</p>}
      {st && (
        <p className="muted small" data-testid="graph-meta">
          {st.exists && st.meta
            ? <>已构建 · {st.meta.nodeCount} 节点 · {st.meta.edgeCount} 边 · {st.meta.fileCount} 文件{st.meta.truncated ? '（已抽样）' : ''} · {new Date(st.meta.builtAt).toLocaleString()}</>
            : <>尚未构建 · 将保存到应用数据目录</>}
        </p>
      )}
      {staleHits.length > 0 && (
        <div className="k-stale-bar" data-testid="k-graph-stale-bar">
          <button type="button" className={`btn btn-sm k-stale-btn ${staleOnly ? 'on' : ''}`} data-testid="k-graph-stale-count"
            title="点击聚焦下一个过时节点"
            onClick={() => void focusStale(1)}>
            {staleHits.length} 个节点已过时
          </button>
          <button type="button" className={`btn btn-sm ${staleOnly ? 'btn-primary' : ''}`} data-testid="k-graph-stale-filter"
            onClick={() => setStaleOnly((v) => !v)}>{staleOnly ? '显示全部' : '只看过时'}</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void refreshStale()}>重检</button>
        </div>
      )}
      {st?.exists && (
        <div className="row gap" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          <input className="flex1" style={{ minWidth: 180 }} placeholder="搜索文件 / 符号 / 模块…" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void doSearch() }}
            data-testid="graph-search" />
          <button className="btn btn-sm" onClick={() => void doSearch()}>搜索</button>
        </div>
      )}
      {visibleHits.length > 0 && (
        <ul className="wiki-list" data-testid="graph-hits">
          {visibleHits.map((h) => (
            <li key={h.node.id}>
              <button className={`link ${sel?.id === h.node.id ? 'on' : ''}`} onClick={() => void selectNode(h.node)}>
                <span className="tag">{h.node.kind}</span> {h.node.label}
                {staleSet.has(h.node.id) && <span className="kg-stale-tag">过时</span>}
                {h.node.path ? <span className="muted"> — {h.node.path}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail && (
        <div className="wiki-layout" style={{ minHeight: 320 }} data-testid="graph-detail">
          <div className="wiki-preview" style={{ flex: 1, minHeight: 300 }}>
            <ReactFlowProvider>
              <div className="mod-hub-canvas-host kg" data-testid="k-graph-canvas" style={{ border: 'none', borderRadius: 0 }}>
                <span className="mod-hub-canvas-tip" data-testid="k-graph-canvas-tip">可拖动画布缩放</span>
                <div className="vz-graph" style={{ position: 'absolute', inset: 0 }}>
                  <ReactFlow nodes={flow.nodes} edges={flow.edges} fitView proOptions={{ hideAttribution: true }}
                    onNodeClick={(_, n) => {
                      const hit = detail.neighbors.find((x) => x.node.id === n.id)?.node
                      if (hit) void selectNode(hit)
                      else if (n.id === detail.node.id) setFocusId(n.id)
                    }}>
                    <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
                    <MiniMap pannable zoomable />
                    <FocusHelper nodeId={focusId} />
                  </ReactFlow>
                </div>
              </div>
            </ReactFlowProvider>
          </div>
          <aside className="wiki-list" style={{ maxWidth: 280 }} data-testid="graph-sidebar">
            <div className="wiki-preview-h">
              <b>{detail.node.label}</b>
              {staleSet.has(detail.node.id) && <span className="kg-stale-tag">过时</span>}
            </div>
            <p className="muted small">{detail.node.kind}{detail.node.symbolKind ? ` · ${detail.node.symbolKind}` : ''}</p>
            {detail.node.path && <p className="small"><code>{detail.node.path}</code>{detail.node.line ? `:${detail.node.line}` : ''}</p>}
            {staleSet.has(detail.node.id) && (
              <p className="muted small" data-testid="graph-stale-reason">
                原因：{staleHits.find((h) => h.id === detail.node.id)?.reason === 'missing-symbol' ? '符号已不存在'
                  : staleHits.find((h) => h.id === detail.node.id)?.reason === 'missing-dir' ? '目录已不存在'
                    : staleHits.find((h) => h.id === detail.node.id)?.reason === 'missing-wiki' ? 'Wiki 页已不存在'
                      : '路径已不存在'}
              </p>
            )}
            <p className="muted small">入度 {detail.inDegree} · 出度 {detail.outDegree}</p>
            <div className="section-title" style={{ marginTop: 8 }}>邻居（含置信度）</div>
            <ul className="wiki-list">
              {detail.neighbors.slice(0, 24).filter((n) => !staleOnly || staleSet.has(n.node.id)).map((n) => (
                <li key={n.edge.id + n.direction}>
                  <button className="link small" onClick={() => void selectNode(n.node)}>
                    {n.direction === 'out' ? '→' : '←'} [{n.edge.kind}/{n.edge.confidence}] {n.node.label}
                    {staleSet.has(n.node.id) && <span className="kg-stale-tag">过时</span>}
                  </button>
                </li>
              ))}
            </ul>
            {blast.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: 8 }}>Blast radius</div>
                <ul className="wiki-list">
                  {blast.slice(0, 20).map((n) => (
                    <li key={n.id}><button className="link small" onClick={() => void selectNode(n)}>{n.label}{staleSet.has(n.id) && <span className="kg-stale-tag">过时</span>}</button></li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  )
}
