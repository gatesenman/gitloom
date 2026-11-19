// One side (before or after) of the change: files → resolved import graph, functions → resolved call graph,
// declarations → type graph. Name resolution is best-effort and language aware, never guesses across ambiguity
// (an ambiguous call stays unresolved rather than drawing a wrong edge).
import { posix } from 'path'
import type { CallFact, DeclFact, FileFacts, FnFact } from './facts'

export interface RepoHints {
  /** tsconfig `paths` prefixes: "@/" → ["src/renderer/src/"] */
  tsPaths?: { prefix: string; targets: string[] }[]
  goModule?: string
}

export interface FnRef { id: string; file: string; f: FnFact }
export interface DeclRef { id: string; file: string; d: DeclFact }

const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte']
const NOISE = new Set(['log', 'error', 'warn', 'info', 'debug', 'push', 'pop', 'map', 'filter', 'forEach', 'reduce', 'find', 'some', 'every', 'includes', 'join', 'split',
  'slice', 'splice', 'concat', 'keys', 'values', 'entries', 'get', 'set', 'has', 'add', 'delete', 'toString', 'trim', 'replace', 'match', 'test', 'exec', 'then', 'catch',
  'finally', 'resolve', 'reject', 'all', 'append', 'extend', 'format', 'len', 'print', 'Println', 'Printf', 'Sprintf', 'Errorf', 'equals', 'hashCode', 'size', 'length',
  'apply', 'call', 'bind', 'emit', 'on', 'once', 'sort', 'indexOf', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'parse', 'stringify', 'max', 'min', 'floor',
  'ceil', 'round', 'abs', 'now', 'unwrap', 'expect', 'clone', 'into', 'iter', 'collect', 'to_string', 'as_str', 'is_empty', 'ok', 'err', 'items', 'update', 'copy',
  'assign', 'create', 'from', 'of', 'isArray', 'String', 'Number', 'Boolean', 'Object', 'Array', 'Promise', 'require', 'setTimeout', 'clearTimeout', 'setState',
  'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useContext', 'describe', 'it', 'expect', 'toBe', 'toEqual', 'close', 'write', 'read', 'send', 'run'])
export const isNoiseCall = (name: string): boolean => NOISE.has(name)

export const fnIdOf = (file: string, f: { name: string; owner?: string }): string => `${file}#${f.owner ? f.owner + '.' : ''}${f.name}`
export const declIdOf = (file: string, d: { name: string; owner?: string }): string => `${file}#${d.owner ? d.owner + '.' : ''}${d.name}`

export class SideModel {
  files = new Map<string, FileFacts>()
  /** file → (imported file → line) */
  imports = new Map<string, Map<string, number>>()
  fns = new Map<string, FnRef>()
  fnsByFile = new Map<string, FnRef[]>()
  decls = new Map<string, DeclRef>()
  declsByName = new Map<string, DeclRef[]>()
  methodsByName = new Map<string, FnRef[]>()
  topFnsByName = new Map<string, FnRef[]>()
  /** fn → (callee fn → line) */
  calls = new Map<string, Map<string, number>>()
  private dirs = new Map<string, string[]>()
  private pkgFiles = new Map<string, string[]>()
  private importNames = new Map<string, Map<string, string[]>>()

  constructor(facts: FileFacts[], private hints: RepoHints = {}) {
    for (const f of [...facts].sort((a, b) => (a.path < b.path ? -1 : 1))) this.files.set(f.path, f)
    for (const [p, f] of this.files) {
      const d = posix.dirname(p)
      if (!this.dirs.has(d)) this.dirs.set(d, [])
      this.dirs.get(d)!.push(p)
      if (f.pkg) { if (!this.pkgFiles.has(f.pkg)) this.pkgFiles.set(f.pkg, []); this.pkgFiles.get(f.pkg)!.push(p) }
      for (const fn of f.fns) {
        const id = fnIdOf(p, fn)
        if (this.fns.has(id)) continue
        const r = { id, file: p, f: fn }
        this.fns.set(id, r)
        push(this.fnsByFile, p, r)
        push(fn.owner ? this.methodsByName : this.topFnsByName, fn.name, r)
      }
      for (const d of f.decls) {
        const id = declIdOf(p, d)
        if (this.decls.has(id)) continue
        const r = { id, file: p, d }
        this.decls.set(id, r)
        push(this.declsByName, d.name, r)
      }
    }
    for (const p of this.files.keys()) this.resolveImports(p)
    this.addTypeRefEdges()
    for (const r of this.fns.values()) this.resolveCalls(r)
  }

  // ------------------------------------------------------------------------------------------ imports
  private has = (p: string) => this.files.has(p)
  private addImport(from: string, to: string, line: number) {
    if (from === to) return
    if (!this.imports.has(from)) this.imports.set(from, new Map())
    const m = this.imports.get(from)!
    if (!m.has(to)) m.set(to, line)
  }
  private byBase = new Map<string, string[]>()
  private suffixFind(rest: string, exts: string[]): string | undefined {
    if (!rest) return undefined
    if (!this.byBase.size) for (const p of this.files.keys()) push(this.byBase, posix.basename(p), p)
    const cands: string[] = []
    for (const e of exts) { const t = rest + e; for (const p of this.byBase.get(posix.basename(t)) ?? []) if (p === t || p.endsWith('/' + t)) cands.push(p) }
    cands.sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
    return cands[0]
  }
  private tryJs(base: string): string | undefined {
    const b = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
    for (const c of [base, ...JS_EXT.map((e) => b + e), ...JS_EXT.map((e) => b + '/index' + e)]) if (this.has(c)) return c
    return undefined
  }

  resolveSpec(from: string, spec: string, lang: string): string[] {
    const dir = posix.dirname(from)
    const f = this.files.get(from)!
    switch (lang) {
      case 'typescript': case 'tsx': case 'javascript': case 'vue': case 'svelte': {
        if (spec.startsWith('.')) { const r = this.tryJs(posix.normalize(posix.join(dir, spec))); return r ? [r] : [] }
        for (const tp of this.hints.tsPaths ?? []) {
          if (!spec.startsWith(tp.prefix)) continue
          for (const t of tp.targets) { const r = this.tryJs(posix.normalize(t + spec.slice(tp.prefix.length))); if (r) return [r] }
        }
        if (/^[@~#]/.test(spec)) {
          const rest = spec.replace(/^[@~#]\/?/, '')
          const r = this.suffixFind(rest, JS_EXT) ?? this.suffixFind(rest + '/index', JS_EXT) ?? this.suffixFind(rest.split('/').slice(1).join('/'), JS_EXT)
          return r ? [r] : []
        }
        return []
      }
      case 'python': {
        const m = /^(\.*)(.*)$/.exec(spec)!
        const dots = m[1].length
        const parts = m[2] ? m[2].split('.') : []
        const out: string[] = []
        const tryMod = (base: string) => { for (const c of [base + '.py', base + '/__init__.py', base + '.pyi']) if (this.has(c)) return c; return undefined }
        if (dots) {
          let b = dir
          for (let i = 1; i < dots; i++) b = posix.dirname(b)
          const base = posix.join(b, ...parts)
          const r = tryMod(base); if (r) out.push(r)
          for (const n of this.importNamesOf(from, spec)) { const s = tryMod(posix.join(base, n)); if (s) out.push(s) }
        } else if (parts.length) {
          const rest = parts.join('/')
          const r = (this.has(rest + '.py') ? rest + '.py' : undefined) ?? this.suffixFind(rest, ['.py', '/__init__.py'])
          if (r) out.push(r)
          for (const n of this.importNamesOf(from, spec)) { const s = this.suffixFind(rest + '/' + n, ['.py', '/__init__.py']); if (s) out.push(s) }
        }
        return out
      }
      case 'java': case 'kotlin': {
        const parts = spec.split('.')
        if (parts[parts.length - 1] === '*') return this.pkgFiles.get(parts.slice(0, -1).join('.')) ?? []
        for (let k = parts.length; k >= 2; k--) {
          const rest = parts.slice(0, k).join('/')
          const r = this.suffixFind(rest, ['.java', '.kt', '.kts'])
          if (r) return [r]
          // Kotlin top-level function import: com.a.util.helper → package com.a.util
          const pkg = parts.slice(0, k - 1).join('.')
          const pf = this.pkgFiles.get(pkg)
          if (pf) { const name = parts[k - 1]; const hit = pf.filter((p) => this.files.get(p)!.fns.some((fn) => !fn.owner && fn.name === name) || this.files.get(p)!.decls.some((d) => d.name === name)); if (hit.length) return hit.slice(0, 3) }
        }
        return []
      }
      case 'go': {
        let p = spec
        if (this.hints.goModule && (p === this.hints.goModule || p.startsWith(this.hints.goModule + '/'))) p = p.slice(this.hints.goModule.length + 1)
        const segs = p.split('/')
        for (let k = 0; k < segs.length; k++) {
          const d = segs.slice(k).join('/')
          for (const [dirName, files] of this.dirs) if (dirName === d || dirName.endsWith('/' + d)) {
            const src = files.filter((x) => x.endsWith('.go') && !x.endsWith('_test.go'))
            if (!src.length) continue
            // link to files of that package that define identifiers this file uses
            const used = new Set(f.idents)
            const hit = src.filter((x) => { const ff = this.files.get(x)!; return ff.decls.some((dd) => used.has(dd.name)) || ff.fns.some((fn) => used.has(fn.name)) })
            return (hit.length ? hit : src.slice(0, 1)).slice(0, 6)
          }
          if (k > 0 && segs.length - k < 1) break
        }
        return []
      }
      case 'rust': {
        const segs = spec.replace(/[{}]/g, '').split('::').filter(Boolean)
        let base: string
        const crateRoot = this.rustCrateRoot(from)
        const modDir = /(^|\/)(lib|main|mod)\.rs$/.test(from) ? dir : from.replace(/\.rs$/, '')
        if (segs[0] === 'crate') { base = crateRoot; segs.shift() } else if (segs[0] === 'super') { base = posix.dirname(modDir); segs.shift(); while (segs[0] === 'super') { base = posix.dirname(base); segs.shift() } } else if (segs[0] === 'self') { base = modDir; segs.shift() } else base = modDir
        for (let k = segs.length; k >= 1; k--) {
          const p = posix.join(base, ...segs.slice(0, k))
          for (const c of [p + '.rs', p + '/mod.rs']) if (this.has(c)) return [c]
        }
        return []
      }
      case 'csharp': {
        const files = this.pkgFiles.get(spec)
        if (!files) return []
        const used = new Set(f.idents)
        return files.filter((x) => this.files.get(x)!.decls.some((d) => used.has(d.name))).slice(0, 8)
      }
      case 'c': case 'cpp': { const r = posix.normalize(posix.join(dir, spec)); if (this.has(r)) return [r]; const s = this.suffixFind(spec, ['']); return s ? [s] : [] }
      case 'ruby': { const r = posix.normalize(posix.join(dir, spec)); for (const c of [r, r + '.rb']) if (this.has(c)) return [c]; const s = this.suffixFind(spec, ['.rb']); return s ? [s] : [] }
      default: {
        if (spec.startsWith('.')) { const r = posix.normalize(posix.join(dir, spec)); if (this.has(r)) return [r] }
        const s = this.suffixFind(spec.replace(/\\/g, '/').replace(/\./g, '/'), ['.php', '.swift', '.scala', '.dart', '.lua', ''])
        return s ? [s] : []
      }
    }
  }
  private rustCrateRoot(from: string): string {
    let d = posix.dirname(from)
    for (let i = 0; i < 12; i++) { if (this.has(d + '/lib.rs') || this.has(d + '/main.rs')) return d; const up = posix.dirname(d); if (up === d) break; d = up }
    return posix.dirname(from)
  }
  private importNamesOf(from: string, spec: string): string[] { return this.files.get(from)!.imports.find((i) => i.spec === spec)?.names ?? [] }

  private resolveImports(p: string) {
    const f = this.files.get(p)!
    const names = new Map<string, string[]>()
    for (const imp of f.imports) {
      const targets = this.resolveSpec(p, imp.spec, f.lang)
      for (const t of targets) this.addImport(p, t, imp.line)
      if (targets.length) {
        for (const n of imp.names) names.set(n.replace(/^\* as /, ''), targets)
        if (f.lang === 'go' || f.lang === 'rust') names.set(imp.spec.split(/\/|::/).pop()!, targets)
      }
    }
    this.importNames.set(p, names)
  }

  /** Java / Kotlin / C# don't import same-package types: link files through referenced type names. */
  private addTypeRefEdges() {
    for (const [p, f] of this.files) {
      if (!['java', 'kotlin', 'csharp'].includes(f.lang)) continue
      const own = new Set(f.decls.map((d) => d.name))
      const imported = new Set(f.imports.map((i) => i.spec.replace(/\.\*$/, '')))
      for (const id of f.idents) {
        if (own.has(id)) continue
        const cands = (this.declsByName.get(id) ?? []).filter((r) => r.file !== p && !r.d.owner)
        if (!cands.length) continue
        const pick = cands.length === 1 ? cands[0] : cands.find((r) => { const tf = this.files.get(r.file)!; return tf.pkg && (tf.pkg === f.pkg || imported.has(tf.pkg)) })
        if (pick) this.addImport(p, pick.file, 0)
      }
    }
  }

  // ------------------------------------------------------------------------------------------ calls
  private ownerChain(file: string, owner: string): string[] {
    const out = [owner]
    let cur = owner
    for (let i = 0; i < 6; i++) {
      const d = (this.declsByName.get(cur) ?? []).find((r) => r.file === file) ?? (this.declsByName.get(cur) ?? [])[0]
      const sup = d?.d.ext[0]
      if (!sup || out.includes(sup)) break
      out.push(sup); cur = sup
    }
    return out
  }
  private methodOf(cls: string, name: string, preferFile?: string): FnRef | undefined {
    const ms = (this.methodsByName.get(name) ?? []).filter((m) => m.f.owner === cls)
    return ms.find((m) => m.file === preferFile) ?? (ms.length === 1 ? ms[0] : undefined)
  }
  private fieldType(file: string, owner: string, field: string): string | undefined {
    const d = (this.declsByName.get(owner) ?? []).find((r) => r.file === file)
    const m = d?.d.members.find((x) => x.name === field && x.kind === 'field')
    return m?.type?.replace(/^[?*&\s]+|[?\s]+$/g, '').replace(/<.*$/, '').replace(/\[\]$/, '').split(/[\s|]/)[0]
  }
  /** resolve one call made inside `from` → callee fn id, or an external participant label */
  resolveCall(from: FnRef, c: CallFact): { fn?: string; ext?: string } {
    const { file, f } = from
    const names = this.importNames.get(file) ?? new Map<string, string[]>()
    const recv = c.recv
    const sameFile = (n: string, owner?: string) => (this.fnsByFile.get(file) ?? []).find((r) => r.f.name === n && r.f.owner === owner)
    if (c.isNew) {
      const ds = (this.declsByName.get(c.name) ?? [])
      const d = ds.find((r) => r.file === file) ?? ds.find((r) => (names.get(c.name) ?? []).includes(r.file)) ?? (ds.length === 1 ? ds[0] : undefined)
      if (d) { const ctor = this.methodOf(c.name, 'constructor', d.file) ?? this.methodOf(c.name, '__init__', d.file) ?? this.methodOf(c.name, c.name, d.file); if (ctor) return { fn: ctor.id } }
      return {}
    }
    if (!recv || recv === 'this' || recv === 'self' || recv === 'super' || recv === 'Self' || recv === 'base') {
      if (f.owner) for (const o of this.ownerChain(file, f.owner)) { const m = this.methodOf(o, c.name, file); if (m) return { fn: m.id } }
      if (!recv) {
        const s = sameFile(c.name); if (s) return { fn: s.id }
        const t = names.get(c.name)
        if (t) for (const tf of t) { const r = (this.fnsByFile.get(tf) ?? []).find((x) => x.f.name === c.name && !x.f.owner); if (r) return { fn: r.id } }
        // same package / directory (Go, Kotlin, Java static helpers, Rust module fns)
        const lang = this.files.get(file)!.lang
        if (lang === 'go' || lang === 'kotlin' || lang === 'python' && false) {
          const dir = posix.dirname(file)
          const r = (this.topFnsByName.get(c.name) ?? []).filter((x) => posix.dirname(x.file) === dir)
          if (r.length === 1) return { fn: r[0].id }
        }
        const tops = this.topFnsByName.get(c.name) ?? []
        if (tops.length === 1 && !isNoiseCall(c.name) && c.name.length > 3 && (this.imports.get(file)?.has(tops[0].file))) return { fn: tops[0].id }
      }
      return {}
    }
    const head = recv.split('.')[0]
    // module / namespace alias (TS `import * as x`, python `import x`, go package, rust path)
    const t = names.get(head)
    if (t && !recv.includes('.')) {
      for (const tf of t) {
        const r = (this.fnsByFile.get(tf) ?? []).find((x) => x.f.name === c.name && !x.f.owner) ?? (this.fnsByFile.get(tf) ?? []).find((x) => x.f.name === c.name && x.f.owner === head)
        if (r) return { fn: r.id }
      }
      if (!isNoiseCall(c.name)) return { ext: head }
    }
    // static call on a class name: Repo.create()
    if (/^[A-Z]/.test(head) && !recv.includes('.')) { const m = this.methodOf(head, c.name); if (m) return { fn: m.id } }
    // field: this.repo.save() / self.repo.save()
    const fm = /^(?:this|self|base)\.([A-Za-z_]\w*)$/.exec(recv) ?? (f.owner && /^[a-z_]\w*$/.test(recv) ? [recv, recv] : null)
    if (fm && f.owner) {
      const ft = this.fieldType(file, f.owner, fm[1])
      if (ft) { for (const o of this.ownerChain(file, ft)) { const m = this.methodOf(o, c.name); if (m) return { fn: m.id } } }
      // interface-typed field: pick the implementation when exactly one class implements it
      if (ft) { const impls = [...this.decls.values()].filter((d) => d.d.impl.includes(ft) || d.d.ext.includes(ft)); for (const d of impls) { const m = this.methodOf(d.d.name, c.name); if (m && impls.length === 1) return { fn: m.id } } }
      const declHasField = (this.declsByName.get(f.owner) ?? []).some((d) => d.d.members.some((m) => m.name === fm[1] && m.kind === 'field'))
      if (declHasField && !isNoiseCall(c.name)) {
        const uniq = this.methodsByName.get(c.name) ?? []
        if (uniq.length === 1 && c.name.length > 3) return { fn: uniq[0].id }
        return { ext: fm[1] }
      }
    }
    // unique method name in the whole project (last resort, skips generic names)
    if (!isNoiseCall(c.name) && c.name.length > 4) { const uniq = this.methodsByName.get(c.name) ?? []; if (uniq.length === 1 && this.imports.get(file)?.has(uniq[0].file)) return { fn: uniq[0].id } }
    return {}
  }
  private resolveCalls(r: FnRef) {
    const m = new Map<string, number>()
    for (const c of r.f.calls) { const res = this.resolveCall(r, c); if (res.fn && res.fn !== r.id && !m.has(res.fn)) m.set(res.fn, c.line) }
    if (m.size) this.calls.set(r.id, m)
  }

  /** declaration referenced by a type name from inside `file` */
  findDecl(name: string, file: string): DeclRef | undefined {
    const ds = this.declsByName.get(name) ?? []
    if (!ds.length) return undefined
    const same = ds.find((d) => d.file === file)
    if (same) return same
    const imp = this.imports.get(file)
    const viaImport = ds.filter((d) => imp?.has(d.file))
    if (viaImport.length) return viaImport[0]
    return ds.length === 1 ? ds[0] : undefined
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]) }
