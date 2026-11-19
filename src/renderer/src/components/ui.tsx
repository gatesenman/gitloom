import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

// ---------------------------------------------------------------- toasts
export interface ToastAction { label: string; onClick: () => void; /** icon name, default 'undo' */ icon?: string }
type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string; action?: ToastAction }
const ToastCtx = createContext<(kind: Toast['kind'], text: string, action?: ToastAction) => void>(() => undefined)
export const useToast = () => useContext(ToastCtx)

// ---------------------------------------------------------------- dialogs
export interface Field { name: string; label: string; type?: 'text' | 'textarea' | 'select' | 'checkbox' | 'password'; value?: string | boolean; options?: { value: string; label: string }[]; placeholder?: string; hint?: string }
interface DialogReq { title: string; message?: React.ReactNode; fields?: Field[]; okText?: string; danger?: boolean; resolve: (v: Record<string, string | boolean> | null) => void; extra?: (set: (n: string, v: string | boolean) => void) => React.ReactNode }
const DialogCtx = createContext<(r: Omit<DialogReq, 'resolve'>) => Promise<Record<string, string | boolean> | null>>(async () => null)
export const useDialog = () => useContext(DialogCtx)

export function UIProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dlg, setDlg] = useState<DialogReq | null>(null)
  const push = useCallback((kind: Toast['kind'], text: string, action?: ToastAction) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-4), { id, kind, text, action }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? (action ? 12000 : 9000) : action ? 7000 : 3500)
  }, [])
  const open = useCallback((r: Omit<DialogReq, 'resolve'>) => new Promise<Record<string, string | boolean> | null>((resolve) => setDlg({ ...r, resolve })), [])
  return (
    <ToastCtx.Provider value={push}>
      <DialogCtx.Provider value={open}>
        {children}
        <TooltipLayer />
        {dlg && <Dialog req={dlg} onClose={(v) => { dlg.resolve(v); setDlg(null) }} />}
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <Icon name={t.kind === 'ok' ? 'ok' : t.kind === 'err' ? 'error' : 'info'} size={16} />
              <span>{t.text}</span>
              {t.action && <button className="toast-action" onClick={(e) => { e.stopPropagation(); t.action!.onClick(); setToasts((x) => x.filter((y) => y.id !== t.id)) }}><Icon name={t.action.icon ?? 'undo'} size={13} />{t.action.label}</button>}
            </div>
          ))}
        </div>
      </DialogCtx.Provider>
    </ToastCtx.Provider>
  )
}

function Dialog({ req, onClose }: { req: DialogReq; onClose: (v: Record<string, string | boolean> | null) => void }) {
  const [vals, setVals] = useState<Record<string, string | boolean>>(() => Object.fromEntries((req.fields ?? []).map((f) => [f.name, f.value ?? (f.type === 'checkbox' ? false : '')])))
  const first = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const form = useRef<HTMLFormElement>(null)
  // confirm dialogs without fields never took focus, so Esc / Enter did nothing until the user clicked inside
  useEffect(() => { if (first.current) { first.current.focus(); first.current.select?.() } else form.current?.querySelector<HTMLButtonElement>('button[type=submit]')?.focus() }, [])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !form.current?.contains(document.activeElement)) { e.preventDefault(); onClose(null) } }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])
  const set = (n: string, v: string | boolean) => setVals((s) => ({ ...s, [n]: v }))
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(null) }}>
      <form ref={form} className="modal" onSubmit={(e) => { e.preventDefault(); onClose(vals) }} onKeyDown={(e) => { if (e.key === 'Escape') onClose(null) }}>
        <div className="modal-title">{req.title}</div>
        {req.message && <div className="modal-msg">{req.message}</div>}
        {(req.fields ?? []).map((f, i) => (
          <label key={f.name} className={`field ${f.type === 'checkbox' ? 'field-check' : ''}`}>
            {f.type === 'checkbox' ? (
              <><input type="checkbox" checked={!!vals[f.name]} onChange={(e) => set(f.name, e.target.checked)} /> <span>{f.label}</span></>
            ) : (
              <>
                <span className="field-label">{f.label}</span>
                {f.type === 'textarea' ? <textarea ref={i === 0 ? first : undefined} rows={5} value={String(vals[f.name])} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} />
                  : f.type === 'select' ? <select value={String(vals[f.name])} onChange={(e) => set(f.name, e.target.value)}>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                  : <input ref={i === 0 ? first : undefined} type={f.type === 'password' ? 'password' : 'text'} value={String(vals[f.name])} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} />}
              </>
            )}
            {f.hint && <span className="field-hint">{f.hint}</span>}
          </label>
        ))}
        {req.extra?.(set)}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => onClose(null)}>取消</button>
          <button type="submit" className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`}>{req.okText ?? '确定'}</button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------- context menu
export interface MenuItem { label?: string; icon?: string; danger?: boolean; disabled?: boolean; onClick?: () => void; sep?: boolean; hint?: string; checked?: boolean; header?: boolean; /** soft explanatory line (not clickable) */ note?: boolean; sub?: string }
type MenuEvent = React.MouseEvent | { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }
const MenuCtx = createContext<(e: MenuEvent, items: MenuItem[]) => void>(() => undefined)
export const useMenu = () => useContext(MenuCtx)
/** Open a menu anchored below an element (breadcrumb / dropdown buttons). */
export const anchorOf = (el: Element) => { const r = el.getBoundingClientRect(); return { clientX: r.left, clientY: r.bottom + 4, preventDefault: () => undefined, stopPropagation: () => undefined } }

export function MenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const openedAt = useRef(0)
  useEffect(() => {
    // the click that opened an anchored dropdown bubbles to window afterwards — ignore it
    const close = () => { if (performance.now() - openedAt.current > 60) setMenu(null) }
    window.addEventListener('click', close); window.addEventListener('blur', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('blur', close) }
  }, [])
  const open = useCallback((e: MenuEvent, items: MenuItem[]) => {
    e.preventDefault?.(); e.stopPropagation?.()
    openedAt.current = performance.now()
    const h = Math.min(items.length * 30 + 12, window.innerHeight * 0.7)
    setMenu({ x: Math.max(4, Math.min(e.clientX, window.innerWidth - 280)), y: Math.max(4, Math.min(e.clientY, window.innerHeight - h - 8)), items })
  }, [])
  return (
    <MenuCtx.Provider value={open}>
      {children}
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.items.map((it, i) => it.sep ? <div key={i} className="ctx-sep" /> : it.header ? <div key={i} className="ctx-header">{it.label}</div> : it.note ? <div key={i} className="ctx-note" role="note">{it.label}</div> : (
            <button key={i} disabled={it.disabled} className={`ctx-item ${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}`} onClick={() => { setMenu(null); it.onClick?.() }}>
              {it.checked ? <Icon name="check" size={14} /> : it.icon ? <Icon name={it.icon} size={14} /> : <span style={{ width: 14 }} />}
              <span className="ctx-label">{it.label}{it.sub && <span className="ctx-sub">{it.sub}</span>}</span>
              {it.hint && <span className="ctx-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </MenuCtx.Provider>
  )
}

// ---------------------------------------------------------------- misc
export function Spinner({ size = 14 }: { size?: number }) { return <span className="spinner" style={{ width: size, height: size }} /> }

/** Illustrated empty state: layered "loom" cards with the view's icon. */
export function Empty({ icon = 'check', title, children, actions }: { icon?: string; title: string; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="empty">
      <svg className="empty-art" viewBox="0 0 132 96" fill="none" aria-hidden>
        <defs>
          <linearGradient id="eg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7c5cff" /><stop offset=".55" stopColor="#4f7bff" /><stop offset="1" stopColor="#12c2c9" /></linearGradient>
        </defs>
        <rect x="20" y="18" width="92" height="62" rx="12" fill="var(--panel2)" stroke="var(--border2)" transform="rotate(-6 66 49)" />
        <rect x="20" y="18" width="92" height="62" rx="12" fill="var(--panel3)" stroke="var(--border-strong)" />
        <path d="M34 36h40M34 48h56M34 60h30" stroke="var(--border-strong)" strokeWidth="5" strokeLinecap="round" />
        <path d="M8 70c18 0 22-22 40-22s22 22 40 22 22-22 40-22" stroke="url(#eg)" strokeWidth="2.5" strokeLinecap="round" opacity=".7" />
        <circle cx="100" cy="24" r="17" fill="url(#eg)" />
        <foreignObject x="88" y="12" width="24" height="24"><div style={{ color: '#fff', display: 'grid', placeItems: 'center', height: '100%' }}><Icon name={icon} size={16} strokeWidth={2} /></div></foreignObject>
      </svg>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-sub">{children}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  )
}

/** Shimmering placeholder rows while lists load. */
export function Skeleton({ rows = 8, variant = 'list' }: { rows?: number; variant?: 'list' | 'graph' | 'cards' }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row" style={{ opacity: 1 - i / (rows * 1.4) }}>
          {variant === 'graph' && <span className="sk sk-dot" style={{ marginLeft: (i % 3) * 14 }} />}
          {variant === 'list' && <span className="sk sk-box" style={{ width: 18 }} />}
          <span className="sk" style={{ width: `${38 + ((i * 37) % 45)}%` }} />
          <span className="flex1" />
          {variant !== 'cards' && <span className="sk" style={{ width: 60 }} />}
        </div>
      ))}
    </div>
  )
}

const AVATAR_COLORS = ['#7b74ff', '#2ec4b6', '#f59e0b', '#ef5a7a', '#3b9cff', '#8bc34a', '#b07cff', '#ff8a4c', '#14b8c4', '#e66fb5']
/** Stable color for a name (repo / author avatars). */
export function hashColor(s: string): string { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length] }

/** Keyboard hint chips, e.g. <Kbd keys={['Ctrl', 'K']} />. */
export const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'
export function Kbd({ keys }: { keys: string[] }) {
  return <span className="kbds">{keys.map((k) => <kbd key={k}>{k === 'Mod' ? MOD : k}</kbd>)}</span>
}

/** Styled tooltips for every element with a title attribute (native tooltip suppressed while shown). */
function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null)
  const [left, setLeft] = useState(8)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let cur: HTMLElement | null = null
    const restore = () => { if (cur && cur.dataset.tip !== undefined) { cur.setAttribute('title', cur.dataset.tip); delete cur.dataset.tip } cur = null }
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.('[title]') as HTMLElement | null
      if (!el || el === cur) return
      clearTimeout(timer); restore(); setTip(null)
      const text = el.getAttribute('title')
      if (!text) return
      cur = el; el.dataset.tip = text; el.removeAttribute('title')
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect()
        const below = r.top < 60
        // Keep the natural center; clamp later after measuring width so right-edge tips
        // never shrink into a vertical "rail" against the window edge.
        setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below })
      }, 450)
    }
    const out = (e: MouseEvent) => {
      if (!cur) return
      const to = e.relatedTarget as Node | null
      if (to && cur.contains(to)) return
      clearTimeout(timer); restore(); setTip(null)
    }
    const hide = () => { clearTimeout(timer); restore(); setTip(null) }
    document.addEventListener('mouseover', over); document.addEventListener('mouseout', out)
    document.addEventListener('mousedown', hide, true); window.addEventListener('blur', hide); document.addEventListener('scroll', hide, true)
    return () => { document.removeEventListener('mouseover', over); document.removeEventListener('mouseout', out); document.removeEventListener('mousedown', hide, true); window.removeEventListener('blur', hide); document.removeEventListener('scroll', hide, true) }
  }, [])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!tip || !ref.current) return
    const w = Math.min(ref.current.offsetWidth || 0, 340)
    let l = tip.x - w / 2
    if (l < 8) l = 8
    if (l + w > window.innerWidth - 8) l = Math.max(8, window.innerWidth - 8 - w)
    setLeft(l)
  }, [tip])
  if (!tip) return null
  return <div ref={ref} className="tooltip" role="tooltip" style={{ left, top: tip.y, transform: tip.below ? 'none' : 'translateY(-100%)' }}>{tip.text}</div>
}

export function Resizer({ onResize, vertical = false }: { onResize: (delta: number) => void; vertical?: boolean }) {
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault()
    let last = vertical ? e.clientY : e.clientX
    const move = (ev: MouseEvent) => { const cur = vertical ? ev.clientY : ev.clientX; onResize(cur - last); last = cur }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = '' }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize'
  }
  return <div className={vertical ? 'resizer-v' : 'resizer'} onMouseDown={onDown} />
}

export function relTime(sec: number): string {
  const d = Date.now() / 1000 - sec
  if (d < 60) return '刚刚'
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天前`
  const dt = new Date(sec * 1000)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

export function fullTime(sec: number): string { return new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false }) }

export const STATUS_LABEL: Record<string, string> = { M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', U: '冲突', '?': '未跟踪', T: '类型变更' }

export function StatusBadge({ code }: { code: string }) {
  const c = code === '?' ? 'U2' : code
  return <span className={`st st-${c}`} title={STATUS_LABEL[code] ?? code}>{code === '?' ? 'U' : code === 'U' ? '!' : code}</span>
}

/** Tiny markdown renderer (headings, lists, blockquotes, code fences, inline code, bold) for AI output. */
export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  const inline = (s: string, k: number) => {
    const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
    return <React.Fragment key={k}>{parts.map((p, j) => p.startsWith('`') && p.endsWith('`') && p.length > 1 ? <code key={j}>{p.slice(1, -1)}</code> : p.startsWith('**') && p.endsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : p)}</React.Fragment>
  }
  while (i < lines.length) {
    const l = lines[i]
    if (l.startsWith('```')) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++])
      i++
      blocks.push(<pre key={blocks.length} className="md-pre">{buf.join('\n')}</pre>)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l)
    if (h) { blocks.push(React.createElement(`h${Math.min(h[1].length + 2, 6)}`, { key: blocks.length, className: 'md-h' }, inline(h[2], 0))); i++; continue }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      // one level of nesting: lines indented by 2+ spaces attach to the previous top-level item
      const items: { t: string; sub: string[] }[] = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const raw = lines[i++], txt = raw.replace(/^\s*([-*]|\d+\.)\s+/, '')
        if (/^\s{2,}/.test(raw) && items.length) items[items.length - 1].sub.push(txt); else items.push({ t: txt, sub: [] })
      }
      blocks.push(<ul key={blocks.length} className="md-ul">{items.map((it, k) => <li key={k}>{inline(it.t, k)}{it.sub.length > 0 && <ul className="md-ul md-sub">{it.sub.map((x, j) => <li key={j}>{inline(x, j)}</li>)}</ul>}</li>)}</ul>)
      continue
    }
    if (/^>\s?/.test(l)) {
      const q: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={blocks.length} className="md-q">{q.map((x, k) => <div key={k}>{inline(x, k)}</div>)}</blockquote>)
      continue
    }
    if (l.trim()) blocks.push(<p key={blocks.length} className="md-p">{inline(l, 0)}</p>)
    i++
  }
  return <div className="md">{blocks}</div>
}

/** useState persisted to localStorage (layout sizes, toggles). */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => { try { const s = localStorage.getItem(key); return s === null ? initial : (JSON.parse(s) as T) } catch { return initial } })
  const t = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => { clearTimeout(t.current); t.current = setTimeout(() => localStorage.setItem(key, JSON.stringify(v)), 200); return () => clearTimeout(t.current) }, [key, v])
  return [v, setV]
}

/** Run async tasks with a concurrency limit; onEach reports progress. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>, signal?: { cancelled: boolean }): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length)
  let i = 0
  const worker = async () => { while (i < items.length) { if (signal?.cancelled) return; const k = i++; out[k] = await fn(items[k], k) } }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}
