// Standalone SVG rendering of a laid-out DiffGraph (0.5.2): used for "导出完整 SVG / PNG" — the whole diagram at
// native scale (not just what is visible in the pane), plus a legend and a title. Pure: no DOM, unit-tested.
import type { DiffGraph, DiffStatus, GNode } from '../../../shared/viz'
import type { Layout, Pt } from './vizLayout'
import { STATUS_LABEL, STATUS_SIGN } from './vizGraph'
import { MAX_MEMBERS } from './vizLayout'

export type SvgSide = 'before' | 'after' | 'both'
export interface SvgTheme { bg: string; panel: string; text: string; muted: string; border: string; add: string; del: string; mod: string; ren: string; font: string; mono: string }
export const LIGHT: SvgTheme = { bg: '#ffffff', panel: '#f6f7f9', text: '#1f2328', muted: '#6b7280', border: '#c4c9d1', add: '#16a34a', del: '#dc2626', mod: '#d97706', ren: '#2563eb', font: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif', mono: 'Consolas, "SFMono-Regular", Menlo, monospace' }
export const DARK: SvgTheme = { bg: '#16171b', panel: '#212329', text: '#e8e9ec', muted: '#9aa0aa', border: '#4a4e57', add: '#3fb950', del: '#f85149', mod: '#d29922', ren: '#58a6ff', font: LIGHT.font, mono: LIGHT.mono }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const shown = (s: DiffStatus, side: SvgSide) => side === 'both' || (side === 'before' ? s !== 'added' : s !== 'removed')
const fit = (s: string, px: number, w: number) => { const max = Math.max(3, Math.floor(w / (px * 0.62))); return s.length > max ? s.slice(0, max - 1) + '…' : s }

/** rounded orthogonal path through the route points */
export function roundedPath(pts: Pt[], r = 8): string {
  if (pts.length < 2) return ''
  let d = `M${pts[0].x},${pts[0].y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1]
    const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y)
    const k = Math.min(r, l1 / 2, l2 / 2)
    if (k < 0.5) { d += ` L${b.x},${b.y}`; continue }
    const p1 = { x: b.x - ((b.x - a.x) / l1) * k, y: b.y - ((b.y - a.y) / l1) * k }
    const p2 = { x: b.x + ((c.x - b.x) / l2) * k, y: b.y + ((c.y - b.y) / l2) * k }
    d += ` L${+p1.x.toFixed(1)},${+p1.y.toFixed(1)} Q${b.x},${b.y} ${+p2.x.toFixed(1)},${+p2.y.toFixed(1)}`
  }
  const z = pts[pts.length - 1]
  return d + ` L${z.x},${z.y}`
}

export function absBoxes(g: DiffGraph, L: Layout): Map<string, { x: number; y: number; w: number; h: number }> {
  const by = new Map(g.nodes.map((n) => [n.id, n]))
  const out = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const n of g.nodes) {
    const b = L.boxes[n.id]; if (!b) continue
    let x = b.x, y = b.y, p = n.parent
    while (p && by.has(p)) { const pb = L.boxes[p]; if (pb) { x += pb.x; y += pb.y } p = by.get(p)!.parent }
    out.set(n.id, { x, y, w: b.w, h: b.h })
  }
  return out
}

export interface SvgOpts { side: SvgSide; theme?: SvgTheme; title?: string; subtitle?: string; legend?: boolean }

/** render one picture (before / after / overlay) of the merged graph */
export function graphSvg(g: DiffGraph, L: Layout, o: SvgOpts): string {
  const t = o.theme ?? LIGHT
  const col: Record<DiffStatus, string> = { added: t.add, removed: t.del, modified: t.mod, moved: t.ren, unchanged: t.border }
  const abs = absBoxes(g, L)
  const head = o.title ? 44 : 0
  const foot = o.legend === false ? 0 : 34
  const W = Math.max(L.width, 420), H = L.height + head + foot
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${t.font}'>`)
  out.push(`<defs>${(Object.keys(col) as DiffStatus[]).map((s) => `<marker id="ar-${s}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${col[s]}"/></marker>`).join('')}</defs>`)
  out.push(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`)
  if (o.title) out.push(`<text x="20" y="26" font-size="15" font-weight="700" fill="${t.text}">${esc(o.title)}</text>${o.subtitle ? `<text x="20" y="40" font-size="11" fill="${t.muted}">${esc(o.subtitle)}</text>` : ''}`)
  out.push(`<g transform="translate(0 ${head})">`)
  // groups first (containers), then edges, then nodes
  const depth = (n: GNode) => { let d = 0; let p = n.parent; const by = new Map(g.nodes.map((x) => [x.id, x])); while (p && by.has(p)) { d++; p = by.get(p)!.parent } return d }
  for (const n of [...g.nodes].filter((x) => x.group).sort((a, b) => depth(a) - depth(b))) {
    const b = abs.get(n.id); if (!b || !shown(n.status, o.side)) continue
    out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${t.panel}" fill-opacity=".6" stroke="${n.status === 'unchanged' ? t.border : col[n.status]}" stroke-opacity=".7"${n.status === 'removed' ? ' stroke-dasharray="5 3"' : ''}/>`)
    out.push(`<text x="${b.x + 10}" y="${b.y + 18}" font-size="11.5" font-weight="650" fill="${t.muted}">${esc(fit(n.label, 11.5, b.w - 20))}</text>`)
  }
  const leafShown = new Set(g.nodes.filter((n) => shown(n.status, o.side)).map((n) => n.id))
  for (const e of g.edges) {
    if (!shown(e.status, o.side) || !leafShown.has(e.source) || !leafShown.has(e.target)) continue
    const r = L.routes?.[e.id]
    let d = ''
    if (r) d = roundedPath(r.pts)
    else {
      const a = abs.get(e.source), b = abs.get(e.target); if (!a || !b) continue
      const down = L.dir === 'DOWN'
      const p1 = down ? { x: a.x + a.w / 2, y: a.y + a.h } : { x: a.x + a.w, y: a.y + a.h / 2 }
      const p2 = down ? { x: b.x + b.w / 2, y: b.y } : { x: b.x, y: b.y + b.h / 2 }
      d = down ? `M${p1.x},${p1.y} C${p1.x},${(p1.y + p2.y) / 2} ${p2.x},${(p1.y + p2.y) / 2} ${p2.x},${p2.y}` : `M${p1.x},${p1.y} C${(p1.x + p2.x) / 2},${p1.y} ${(p1.x + p2.x) / 2},${p2.y} ${p2.x},${p2.y}`
    }
    const c = col[e.status]
    out.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="${e.status === 'unchanged' ? 1.3 : 1.9}"${e.status === 'unchanged' ? ' stroke-opacity=".7"' : ''}${e.status === 'removed' || e.status === 'added' ? ` stroke-dasharray="${e.status === 'added' ? '7 4' : '5 4'}"` : ''} marker-end="url(#ar-${e.status})"/>`)
    if (e.label && r?.label) out.push(`<text x="${r.label.x}" y="${r.label.y + 4}" font-size="10.5" text-anchor="middle" fill="${e.status === 'unchanged' ? t.muted : c}" font-family='${t.mono}'>${esc(e.label)}</text>`)
  }
  for (const n of g.nodes) {
    if (n.group || !shown(n.status, o.side)) continue
    const b = abs.get(n.id); if (!b) continue
    const c = col[n.status]
    const fill = n.status === 'unchanged' ? t.panel : `${c}22`
    const dash = n.status === 'removed' ? ' stroke-dasharray="5 3"' : ''
    if (n.kind === 'decision') out.push(`<polygon points="${b.x + b.w / 2},${b.y} ${b.x + b.w},${b.y + b.h / 2} ${b.x + b.w / 2},${b.y + b.h} ${b.x},${b.y + b.h / 2}" fill="${fill}" stroke="${c}" stroke-width="1.5"${dash}/>`)
    else if (n.kind === 'initial') { out.push(`<circle cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" r="${b.w / 2}" fill="${t.text}"/>`); continue }
    else out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${n.kind === 'state' || n.kind === 'start' || n.kind === 'end' ? Math.min(18, b.h / 2) : 7}" fill="${fill}" stroke="${c}" stroke-width="1.5"${dash}/>`)
    const sign = STATUS_SIGN[n.status]
    const ms = n.members ?? []
    const classLike = ms.length > 0
    const ly = classLike ? b.y + 20 : n.sub ? b.y + b.h / 2 - 2 : b.y + b.h / 2 + 4.5
    const label = (sign ? sign + ' ' : '') + (n.label.split('\n')[0] ?? '')
    out.push(`<text x="${classLike || n.kind === 'decision' || n.kind === 'state' ? b.x + b.w / 2 : b.x + 10}" y="${ly}" font-size="12.5" font-weight="600" fill="${n.status === 'unchanged' ? t.muted : t.text}"${classLike || n.kind === 'decision' || n.kind === 'state' ? ' text-anchor="middle"' : ''}${n.status === 'removed' && o.side === 'both' ? ' text-decoration="line-through"' : ''}>${esc(fit(label, 12.5, b.w - 16))}${n.kind === 'cluster' && n.count ? ` (${n.count})` : ''}</text>`)
    if (n.sub && !classLike) out.push(`<text x="${b.x + 10}" y="${ly + 15}" font-size="10.5" fill="${t.muted}" font-family='${t.mono}'>${esc(fit(n.sub, 10.5, b.w - 16))}</text>`)
    if (classLike) {
      out.push(`<line x1="${b.x}" x2="${b.x + b.w}" y1="${b.y + 36}" y2="${b.y + 36}" stroke="${c}" stroke-opacity=".5"/>`)
      ms.slice(0, MAX_MEMBERS).forEach((m, i) => {
        const mc = m.status === 'unchanged' ? t.muted : col[m.status]
        out.push(`<text x="${b.x + 10}" y="${b.y + 54 + i * 18}" font-size="11" fill="${mc}" font-family='${t.mono}'${m.status === 'removed' ? ' text-decoration="line-through"' : ''}>${esc(fit(`${STATUS_SIGN[m.status] || (m.kind === 'method' ? 'ƒ' : '·')} ${m.name}${m.kind === 'method' ? '()' : ''}`, 11, b.w - 16))}</text>`)
      })
      if (ms.length > MAX_MEMBERS) out.push(`<text x="${b.x + 10}" y="${b.y + 54 + MAX_MEMBERS * 18}" font-size="11" fill="${t.muted}" font-style="italic">… 还有 ${ms.length - MAX_MEMBERS} 个成员</text>`)
    }
  }
  out.push('</g>')
  if (foot) {
    let x = 20
    const y = head + L.height + 20
    for (const s of ['added', 'removed', 'modified', 'moved', 'unchanged'] as DiffStatus[]) {
      out.push(`<rect x="${x}" y="${y - 9}" width="14" height="10" rx="3" fill="${s === 'unchanged' ? t.panel : col[s] + '33'}" stroke="${col[s]}"${s === 'removed' ? ' stroke-dasharray="3 2"' : ''}/><text x="${x + 19}" y="${y}" font-size="11" fill="${t.muted}">${STATUS_LABEL[s]}</text>`)
      x += 64
    }
    out.push(`<text x="${W - 20}" y="${y}" font-size="10.5" fill="${t.muted}" text-anchor="end">GitLoom 织线 · 变更可视化</text>`)
  }
  out.push('</svg>')
  return out.join('\n')
}

/** before | after side by side in one SVG (both pictures share coordinates) */
export function sideBySideSvg(g: DiffGraph, L: Layout, o: Omit<SvgOpts, 'side'> & { beforeLabel: string; afterLabel: string }): string {
  const t = o.theme ?? LIGHT
  const a = graphSvg(g, L, { side: 'before', theme: t, legend: false })
  const b = graphSvg(g, L, { side: 'after', theme: t, legend: false })
  const inner = (s: string) => s.slice(s.indexOf('>') + 1, s.lastIndexOf('</svg>'))
  const w = Math.max(L.width, 420), gap = 24, head = 70, foot = 34
  const W = w * 2 + gap, H = L.height + head + foot
  const legend = graphSvg({ nodes: [], edges: [] }, { boxes: {}, width: W, height: 0, dir: 'RIGHT' }, { side: 'both', theme: t })
  const leg = inner(legend).replace(/<rect width="[^"]+" height="[^"]+" fill="[^"]+"\/>/, '')
  return [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${t.font}'>`, `<rect width="${W}" height="${H}" fill="${t.bg}"/>`,
    o.title ? `<text x="20" y="26" font-size="15" font-weight="700" fill="${t.text}">${esc(o.title)}</text>` : '',
    `<text x="20" y="56" font-size="12" font-weight="650" fill="${t.del}">● 改动前 <tspan fill="${t.muted}" font-weight="400" font-family='${t.mono}'>${esc(o.beforeLabel)}</tspan></text>`,
    `<text x="${w + gap + 20}" y="56" font-size="12" font-weight="650" fill="${t.add}">● 改动后 <tspan fill="${t.muted}" font-weight="400" font-family='${t.mono}'>${esc(o.afterLabel)}</tspan></text>`,
    `<line x1="${w + gap / 2}" x2="${w + gap / 2}" y1="${head - 8}" y2="${head + L.height}" stroke="${t.border}"/>`,
    `<g transform="translate(0 ${head})">${inner(a).replace(/<rect width="[^"]+" height="[^"]+" fill="[^"]+"\/>/, '')}</g>`,
    `<g transform="translate(${w + gap} ${head})">${inner(b).replace(/<rect width="[^"]+" height="[^"]+" fill="[^"]+"\/>/, '')}</g>`,
    `<g transform="translate(0 ${head + L.height - 0})">${leg}</g>`, '</svg>'].join('\n')
}
