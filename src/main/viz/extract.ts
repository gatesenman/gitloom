// tree-sitter → FileFacts. One generic walker (flow, calls) + small per-language handlers (imports, declarations,
// function naming). Grammar node types were checked against tree-sitter-wasms 0.1.13 (tree-sitter-cli 0.20.8).
import type Parser from 'web-tree-sitter'
import type { CallFact, DeclFact, DeclKind, FileFacts, FlowStep, FnFact, ImportFact, MemberFact, StateFact, RouteFact, EventFact } from './facts'
import { fnv, normWs } from './facts'

type N = Parser.SyntaxNode

const set = (...a: string[]) => new Set(a)
const IF = set('if_statement', 'if_expression')
const LOOP = set('for_statement', 'for_in_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'for_each_statement',
  'for_expression', 'while_expression', 'loop_expression', 'do_while_statement', 'foreach_statement')
const TRY = set('try_statement', 'try_expression')
const SWITCH = set('switch_statement', 'switch_expression', 'expression_switch_statement', 'type_switch_statement', 'select_statement',
  'match_statement', 'match_expression', 'when_expression')
const RETURN = set('return_statement', 'return_expression')
const THROW = set('throw_statement', 'raise_statement', 'throw_expression')
const JUMP = set('break_statement', 'continue_statement', 'break_expression', 'continue_expression')
const SKIP = set('comment', 'line_comment', 'block_comment', 'pass_statement', 'empty_statement', 'decorator', 'annotation', 'marker_annotation')
const BLOCK = set('statement_block', 'block', 'compound_statement', 'control_structure_body', 'statements', 'function_body', 'expression_statement_list')
const CASES = set('switch_case', 'switch_default', 'switch_block_statement_group', 'switch_rule', 'expression_case', 'default_case', 'type_case',
  'communication_case', 'case_clause', 'match_arm', 'when_entry', 'switch_section')
const CASE_LABELS = set('switch_label', 'case_pattern', 'when_condition', 'case_switch_label', 'default_switch_label', 'match_pattern', 'constant_pattern')
const CALL = set('call_expression', 'call', 'method_invocation', 'invocation_expression', 'new_expression', 'object_creation_expression')
/** nested named declarations we do not descend into when collecting a statement's calls */
const NESTED_DECL = set('function_declaration', 'function_definition', 'class_declaration', 'class_definition', 'method_declaration',
  'function_item', 'impl_item', 'struct_item', 'local_function_statement', 'method_definition')
const FN_LIKE = set('arrow_function', 'function_expression', 'function', 'lambda', 'lambda_expression', 'closure_expression', 'lambda_literal', 'anonymous_function', 'func_literal')

const line = (n: N): number => n.startPosition.row + 1
const endLine = (n: N): number => n.endPosition.row + 1
const short = (s: string, max = 48): string => { const t = normWs(s); return t.length > max ? t.slice(0, max - 1) + '…' : t }
const firstLine = (s: string): string => s.split('\n')[0]
const named = (n: N | null | undefined): N[] => (n ? n.namedChildren.filter((c) => !SKIP.has(c.type)) : [])
const field = (n: N, f: string): N | null => n.childForFieldName(f)
const childOf = (n: N, ...types: string[]): N | undefined => n.namedChildren.find((c) => types.includes(c.type))
const childrenOf = (n: N, ...types: string[]): N[] => n.namedChildren.filter((c) => types.includes(c.type))
const stripParens = (s: string): string => { let t = s.trim(); while (t.startsWith('(') && t.endsWith(')')) t = t.slice(1, -1).trim(); return t }
const unquote = (s: string): string => s.replace(/^[@$]?["'`]+|["'`]+$/g, '')
const typeNames = (s: string): string[] => [...new Set((s.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? []))]

export interface ExtractCtx { lang: string; src: string }

// ---------------------------------------------------------------------------------------------------- calls
function calleeText(n: N, lang: string): { text: string; isNew?: boolean } | null {
  switch (n.type) {
    case 'method_invocation': { const o = field(n, 'object'); const nm = field(n, 'name'); return nm ? { text: (o ? o.text + '.' : '') + nm.text } : null }
    case 'new_expression': { const c = field(n, 'constructor'); return c ? { text: c.text, isNew: true } : null }
    case 'object_creation_expression': { const t = field(n, 'type'); return t ? { text: t.text, isNew: true } : null }
    case 'call_expression': { const f = field(n, 'function') ?? (lang === 'kotlin' ? n.namedChildren[0] : null); return f ? { text: f.text } : null }
    default: { const f = field(n, 'function'); return f ? { text: f.text } : null }
  }
}

export function parseCallee(text: string): { name: string; recv?: string } | null {
  let t = text.replace(/<[^<>()]*>/g, '').replace(/\s+/g, '').replace(/[!?]+$/, '')
  t = t.replace(/\([^()]*\)/g, '()').replace(/\([^()]*\)/g, '()')
  const parts = t.split(/\?\.|\.|::|->/).filter(Boolean)
  const name = parts.pop() ?? ''
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
  return { name, recv: parts.length ? parts.join('.') : undefined }
}

/** calls inside `n` in evaluation order (arguments before the outer call); does not enter nested named declarations */
function collectCalls(n: N, lang: string, out: CallFact[] = [], root = true): CallFact[] {
  if (!root && NESTED_DECL.has(n.type)) return out
  for (const c of n.namedChildren) collectCalls(c, lang, out, false)
  if (CALL.has(n.type)) {
    const ct = calleeText(n, lang)
    const p = ct && parseCallee(ct.text)
    if (p) out.push({ name: p.name, recv: p.recv, line: line(n), ...(ct?.isNew ? { isNew: true } : {}) })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------- flow
function unwrap(n: N): N {
  if ((n.type === 'expression_statement' || n.type === 'parenthesized_expression') && n.namedChildCount === 1) {
    const c = n.namedChildren[0]
    if (IF.has(c.type) || LOOP.has(c.type) || TRY.has(c.type) || SWITCH.has(c.type) || RETURN.has(c.type) || THROW.has(c.type) || JUMP.has(c.type)) return c
  }
  return n
}

function stmtsOf(n: N | null | undefined): N[] {
  if (!n) return []
  if (BLOCK.has(n.type) || n.type === 'else_clause') {
    const out: N[] = []
    for (const c of named(n)) {
      if (BLOCK.has(c.type)) out.push(...stmtsOf(c)); else out.push(c)
    }
    return out
  }
  return [n]
}

const MAX_DEPTH = 12
function flowOf(stmts: N[], cx: ExtractCtx, depth = 0): FlowStep[] {
  const out: FlowStep[] = []
  for (const raw of stmts) {
    const n = unwrap(raw)
    if (SKIP.has(n.type)) continue
    if (depth > MAX_DEPTH) { out.push({ t: 'stmt', text: short(firstLine(n.text)), line: line(n) }); continue }
    if (IF.has(n.type)) out.push({ t: 'if', line: line(n), branches: ifBranches(n, cx, depth) })
    else if (LOOP.has(n.type)) {
      const body = field(n, 'body') ?? childOf(n, 'control_structure_body', 'block', 'statement_block')
      const head = body ? cx.src.slice(n.startIndex, body.startIndex) : firstLine(n.text)
      const headCalls = n.namedChildren.filter((c) => c !== body).flatMap((c) => collectCalls(c, cx.lang))
      out.push({ t: 'loop', label: short(head.replace(/[{:]\s*$/, ''), 40), line: line(n), body: body ? flowOf(stmtsOf(body), cx, depth + 1) : [], ...(headCalls.length ? { calls: headCalls } : {}) })
    } else if (TRY.has(n.type)) {
      const body = field(n, 'body') ?? childOf(n, 'block', 'statement_block', 'statements')
      const catches = childrenOf(n, 'catch_clause', 'except_clause', 'catch_block').map((c) => {
        const b = field(c, 'body') ?? [...c.namedChildren].reverse().find((x) => BLOCK.has(x.type))
        const param = b ? cx.src.slice(c.startIndex, b.startIndex) : firstLine(c.text)
        return { label: short(param.replace(/[{:]\s*$/, ''), 36) || 'catch', body: b ? flowOf(stmtsOf(b), cx, depth + 1) : [] }
      })
      const fin = childOf(n, 'finally_clause', 'finally_block')
      const finBody = fin ? (field(fin, 'body') ?? childOf(fin, 'block', 'statement_block', 'statements') ?? fin) : null
      out.push({ t: 'try', line: line(n), body: body ? flowOf(stmtsOf(body), cx, depth + 1) : [], catches, ...(finBody ? { fin: flowOf(stmtsOf(finBody), cx, depth + 1) } : {}) })
    } else if (SWITCH.has(n.type)) out.push(switchStep(n, cx, depth))
    else if (RETURN.has(n.type) || (n.type === 'jump_expression' && /^return\b/.test(n.text))) {
      const calls = collectCalls(n, cx.lang)
      out.push({ t: 'return', text: short(firstLine(n.text), 40), line: line(n), ...(calls.length ? { calls } : {}) })
    } else if (THROW.has(n.type) || (n.type === 'jump_expression' && /^throw\b/.test(n.text))) {
      const calls = collectCalls(n, cx.lang)
      out.push({ t: 'throw', text: short(firstLine(n.text), 40), line: line(n), ...(calls.length ? { calls } : {}) })
    } else if (JUMP.has(n.type) || n.type === 'jump_expression') out.push({ t: 'jump', text: short(n.text, 20), line: line(n) })
    else {
      const calls = collectCalls(n, cx.lang)
      out.push({ t: 'stmt', text: short(firstLine(n.text)), line: line(n), ...(calls.length ? { calls } : {}) })
    }
  }
  return out
}

function ifBranches(n: N, cx: ExtractCtx, depth: number): { label: string; body: FlowStep[] }[] {
  const out: { label: string; body: FlowStep[] }[] = []
  let cur: N | null = n
  let guard = 0
  while (cur && guard++ < 40) {
    if (cx.lang === 'kotlin') {
      const parts = cur.namedChildren
      const cond = parts[0]
      const bodies = childrenOf(cur, 'control_structure_body')
      out.push({ label: short(stripParens(cond?.text ?? ''), 40), body: flowOf(stmtsOf(bodies[0]), cx, depth + 1) })
      const els = bodies[1]
      if (!els) break
      const inner = stmtsOf(els)
      if (inner.length === 1 && inner[0].type === 'if_expression') { cur = inner[0]; continue }
      out.push({ label: 'else', body: flowOf(inner, cx, depth + 1) }); break
    }
    const cond = field(cur, 'condition')
    const cons = field(cur, 'consequence')
    out.push({ label: short(stripParens(cond?.text ?? ''), 40), body: flowOf(stmtsOf(cons), cx, depth + 1) })
    if (cx.lang === 'python') {
      for (const c of cur.namedChildren) {
        if (c.type === 'elif_clause') out.push({ label: short(stripParens(field(c, 'condition')?.text ?? ''), 40), body: flowOf(stmtsOf(field(c, 'consequence')), cx, depth + 1) })
        else if (c.type === 'else_clause') out.push({ label: 'else', body: flowOf(stmtsOf(field(c, 'body') ?? childOf(c, 'block')), cx, depth + 1) })
      }
      break
    }
    let alt = field(cur, 'alternative')
    if (!alt) break
    if (alt.type === 'else_clause') alt = named(alt)[0] ?? null
    if (!alt) break
    if (IF.has(alt.type)) { cur = alt; continue }
    out.push({ label: 'else', body: flowOf(stmtsOf(alt), cx, depth + 1) })
    break
  }
  return out
}

function switchStep(n: N, cx: ExtractCtx, depth: number): FlowStep {
  const subj = field(n, 'value') ?? field(n, 'condition') ?? field(n, 'subject') ?? childOf(n, 'when_subject', 'parenthesized_expression')
  const body = field(n, 'body')
  const container = body ?? n
  const caseNodes: N[] = []
  const scan = (c: N, d: number) => { for (const x of c.namedChildren) { if (CASES.has(x.type)) caseNodes.push(x); else if (d < 2 && !BLOCK.has(x.type)) scan(x, d + 1) } }
  scan(container, 0)
  const cases = caseNodes.map((c) => {
    const labelNodes = new Set<N>()
    for (const f of ['value', 'pattern']) { const v = field(c, f); if (!v || (c.type === 'match_arm' && f === 'value')) continue; labelNodes.add(v) }
    for (const x of c.namedChildren) if (CASE_LABELS.has(x.type)) labelNodes.add(x)
    let label: string
    if (/default/.test(c.type) || /^(default|else)\b/.test(c.text.trim()) || c.text.trim().startsWith('_ =>')) label = 'default'
    else if (labelNodes.size) label = [...labelNodes].map((x) => x.text).join(', ')
    else label = firstLine(c.text).split(/=>|->|:/)[0]
    label = short(label.replace(/^case\s+/, ''), 30)
    let bodyNodes: N[]
    if (c.type === 'match_arm') { const v = field(c, 'value'); bodyNodes = v ? stmtsOf(v) : [] }
    else bodyNodes = named(c).filter((x) => !labelNodes.has(x) && !CASE_LABELS.has(x.type)).flatMap((x) => stmtsOf(x))
    return { label, body: flowOf(bodyNodes, cx, depth + 1) }
  })
  return { t: 'switch', label: short(stripParens(subj?.text ?? ''), 36), line: line(n), cases }
}

// ---------------------------------------------------------------------------------------------------- functions
function fnBody(n: N, lang: string): N | null {
  if (lang === 'kotlin') return childOf(n, 'function_body') ?? null
  return field(n, 'body')
}

function makeFn(n: N, name: string, owner: string | undefined, cx: ExtractCtx): FnFact {
  const body = fnBody(n, cx.lang)
  let flow: FlowStep[] = []
  if (body) {
    if (BLOCK.has(body.type)) flow = flowOf(stmtsOf(body), cx)
    else if (body.type === 'function_body' && cx.lang === 'kotlin') flow = flowOf(stmtsOf(childOf(body, 'statements') ?? body), cx)
    else { const calls = collectCalls(body, cx.lang); flow = [{ t: 'return', text: short(firstLine(body.text), 40), line: line(body), ...(calls.length ? { calls } : {}) }] }
  }
  const params = field(n, 'parameters') ?? childOf(n, 'formal_parameters', 'parameters', 'parameter_list', 'function_value_parameters')
  const bodyText = body?.text ?? n.text
  return {
    name, owner, line: line(n), endLine: endLine(n),
    sig: fnv(normWs(bodyText.replace(/\/\/[^\n]*|#[^\n{]*$/gm, ''))),
    params: params ? short(params.text, 60) : '',
    calls: body ? collectCalls(body, cx.lang) : [],
    flow,
    size: bodyText.split('\n').filter((l) => l.trim()).length
  }
}

// ---------------------------------------------------------------------------------------------------- per language
interface Out { imports: ImportFact[]; decls: DeclFact[]; fns: FnFact[]; states: StateFact[]; pkg?: string }

function member(name: string, kind: MemberFact['kind'], n: N, type?: string): MemberFact {
  return { name, kind, sig: fnv(normWs(n.text)), line: line(n), ...(type ? { type: short(type, 40) } : {}) }
}
function decl(name: string, kind: DeclKind, n: N, o: Partial<DeclFact> = {}): DeclFact {
  const members = o.members ?? []
  return { name, kind, line: line(n), endLine: endLine(n), ext: o.ext ?? [], impl: o.impl ?? [], members,
    sig: fnv(members.map((m) => `${m.kind}:${m.name}:${m.sig}`).join('|') + (o.ext ?? []).join(',') + (o.impl ?? []).join(',')),
    uses: o.uses ?? [...new Set(members.flatMap((m) => (m.kind === 'field' && m.type ? typeNames(m.type) : [])))].filter((t) => t !== name),
    ...(o.owner ? { owner: o.owner } : {}) }
}
const cleanType = (s: string): string => s.replace(/<.*$/s, '').replace(/\(.*$/s, '').trim()

// TypeScript / JavaScript / TSX
function tsFile(root: N, cx: ExtractCtx, o: Out): void {
  const visitClass = (n: N, ownerPrefix?: string) => {
    const name = field(n, 'name')?.text ?? 'default'
    const her = childOf(n, 'class_heritage')
    const ext: string[] = []; const impl: string[] = []
    if (her) {
      for (const c of her.namedChildren) {
        if (c.type === 'extends_clause') ext.push(...c.namedChildren.filter((x) => x.type !== 'type_arguments').map((x) => cleanType(x.text)))
        else if (c.type === 'implements_clause') impl.push(...c.namedChildren.map((x) => cleanType(x.text)))
        else ext.push(cleanType(c.text)) // JS: class_heritage directly holds the expression
      }
    }
    const members: MemberFact[] = []
    for (const m of named(field(n, 'body'))) {
      const mn = field(m, 'name')?.text
      if (!mn) continue
      if (m.type === 'method_definition' || m.type === 'abstract_method_signature' || m.type === 'method_signature') {
        members.push(member(mn, 'method', m))
        if (m.type === 'method_definition') o.fns.push(makeFn(m, mn, name, cx))
      } else if (m.type === 'public_field_definition' || m.type === 'field_definition' || m.type === 'property_signature') {
        const v = field(m, 'value')
        if (v && FN_LIKE.has(v.type)) { members.push(member(mn, 'method', m)); o.fns.push(makeFn(v, mn, name, cx)) }
        else members.push(member(mn, 'field', m, field(m, 'type')?.text.replace(/^:\s*/, '')))
      }
    }
    o.decls.push(decl(name, 'class', n, { ext, impl, members, owner: ownerPrefix }))
  }
  const visitVar = (d: N) => {
    for (const v of childrenOf(d, 'variable_declarator')) {
      const name = field(v, 'name')?.text
      const val = field(v, 'value')
      if (!name || !val) continue
      if (FN_LIKE.has(val.type)) o.fns.push(makeFn(val, name, undefined, cx))
      else if (val.type === 'call_expression') {
        // React: memo(() => …) / forwardRef(…) / useCallback at top level; xstate createMachine({...})
        const fnArg = named(field(val, 'arguments')).find((a) => FN_LIKE.has(a.type))
        if (fnArg) o.fns.push(makeFn(fnArg, name, undefined, cx))
        const machine = xstateMachine(val, name)
        if (machine) o.states.push(machine)
      } else if (val.type === 'class') visitClass(val)
    }
  }
  const visit = (n: N) => {
    switch (n.type) {
      case 'import_statement': {
        const src = field(n, 'source')
        if (!src) break
        const names: string[] = []
        const clause = childOf(n, 'import_clause')
        if (clause) for (const c of clause.namedChildren) {
          if (c.type === 'identifier') names.push(c.text)
          else if (c.type === 'namespace_import') names.push('* as ' + (c.namedChildren[0]?.text ?? ''))
          else if (c.type === 'named_imports') for (const s of childrenOf(c, 'import_specifier')) names.push((field(s, 'alias') ?? field(s, 'name'))?.text ?? '')
        }
        o.imports.push({ spec: unquote(src.text), names: names.filter(Boolean), line: line(n) })
        break
      }
      case 'export_statement': {
        const src = field(n, 'source')
        if (src) o.imports.push({ spec: unquote(src.text), names: [], line: line(n) })
        const d = field(n, 'declaration') ?? named(n).find((c) => c.type !== 'string')
        if (d) visit(d)
        break
      }
      case 'class_declaration': case 'abstract_class_declaration': visitClass(n); break
      case 'interface_declaration': {
        const name = field(n, 'name')?.text ?? '?'
        const extc = childOf(n, 'extends_type_clause', 'extends_clause')
        const members: MemberFact[] = []
        for (const m of named(field(n, 'body'))) {
          const mn = field(m, 'name')?.text
          if (!mn) continue
          members.push(member(mn, m.type === 'method_signature' ? 'method' : 'field', m, field(m, 'type')?.text.replace(/^:\s*/, '')))
        }
        o.decls.push(decl(name, 'interface', n, { ext: extc ? extc.namedChildren.map((x) => cleanType(x.text)) : [], members }))
        break
      }
      case 'type_alias_declaration': {
        const name = field(n, 'name')?.text ?? '?'
        const val = field(n, 'value')
        if (!val) break
        const lits = val.type === 'union_type' ? unionLiterals(val) : null
        if (lits && lits.length >= 2) {
          o.states.push({ name, kind: 'union', values: lits, line: line(n) })
          o.decls.push(decl(name, 'type', n, { members: lits.map((l) => ({ name: `'${l}'`, kind: 'value' as const, sig: l, line: line(n) })) }))
        } else if (val.type === 'object_type') {
          const members = named(val).map((m) => { const mn = field(m, 'name')?.text; return mn ? member(mn, m.type === 'method_signature' ? 'method' : 'field', m, field(m, 'type')?.text.replace(/^:\s*/, '')) : null }).filter(Boolean) as MemberFact[]
          o.decls.push(decl(name, 'type', n, { members }))
        } else o.decls.push(decl(name, 'type', n, { members: [{ name: short(val.text, 40), kind: 'value', sig: fnv(normWs(val.text)), line: line(n) }] }))
        break
      }
      case 'enum_declaration': {
        const name = field(n, 'name')?.text ?? '?'
        const vals = named(field(n, 'body')).map((m) => (m.type === 'enum_assignment' ? field(m, 'name')?.text : m.text) ?? '').filter(Boolean)
        o.states.push({ name, kind: 'enum', values: vals, line: line(n) })
        o.decls.push(decl(name, 'enum', n, { members: vals.map((v) => ({ name: v, kind: 'value' as const, sig: v, line: line(n) })) }))
        break
      }
      case 'function_declaration': case 'generator_function_declaration': {
        const name = field(n, 'name')?.text ?? 'default'
        o.fns.push(makeFn(n, name, undefined, cx))
        break
      }
      case 'lexical_declaration': case 'variable_declaration': visitVar(n); break
      case 'expression_statement': {
        // module.exports = function …, top-level xstate createMachine(...) etc.
        const e = n.namedChildren[0]
        if (e?.type === 'assignment_expression') {
          const r = field(e, 'right'); const l = field(e, 'left')
          if (r && l && FN_LIKE.has(r.type)) o.fns.push(makeFn(r, l.text.split('.').pop() ?? l.text, undefined, cx))
        }
        break
      }
    }
  }
  for (const n of root.namedChildren) visit(n)
  // require('x') / import('x')
  for (const c of root.descendantsOfType('call_expression')) {
    const f = field(c, 'function')
    if (!f || !(f.text === 'require' || f.type === 'import')) continue
    const a = named(field(c, 'arguments'))[0]
    if (a && (a.type === 'string' || a.type === 'template_string')) o.imports.push({ spec: unquote(a.text), names: [], line: line(c), kind: f.text === 'require' ? undefined : 'dynamic' })
  }
}

function unionLiterals(u: N): string[] | null {
  const out: string[] = []
  const walk = (n: N): boolean => {
    if (n.type === 'union_type') return n.namedChildren.every(walk)
    if (n.type === 'literal_type') { const s = n.namedChildren[0]; if (s?.type === 'string') { out.push(unquote(s.text)); return true } return false }
    if (n.type === 'parenthesized_type') return n.namedChildren.every(walk)
    return false
  }
  return walk(u) ? out : null
}

/** xstate: createMachine({ initial, states: { a: { on: { EV: 'b' | { target: 'b' } } } } }) */
function xstateMachine(call: N, varName: string): StateFact | null {
  const f = field(call, 'function')?.text ?? ''
  if (!/(^|\.)(createMachine|Machine|createActorMachine)$/.test(f)) return null
  const obj = named(field(call, 'arguments')).find((a) => a.type === 'object')
  if (!obj) return null
  const pairs = (o: N) => childrenOf(o, 'pair').map((p) => ({ key: unquote(field(p, 'key')?.text ?? ''), value: field(p, 'value') }))
  const top = pairs(obj)
  const statesObj = top.find((p) => p.key === 'states')?.value
  if (!statesObj || statesObj.type !== 'object') return null
  const initial = top.find((p) => p.key === 'initial')?.value
  const values: string[] = []; const transitions: { from: string; to: string; event: string }[] = []
  const targetOf = (v: N | null): string[] => {
    if (!v) return []
    if (v.type === 'string') return [unquote(v.text).replace(/^\./, '').split('.').pop()!]
    if (v.type === 'object') { const t = pairs(v).find((p) => p.key === 'target')?.value; return targetOf(t ?? null) }
    if (v.type === 'array') return v.namedChildren.flatMap((x) => targetOf(x))
    return []
  }
  for (const s of pairs(statesObj)) {
    values.push(s.key)
    if (s.value?.type !== 'object') continue
    for (const p of pairs(s.value)) {
      if (p.key === 'on' && p.value?.type === 'object') for (const ev of pairs(p.value)) for (const to of targetOf(ev.value)) transitions.push({ from: s.key, to, event: ev.key })
      if ((p.key === 'always' || p.key === 'after' || p.key === 'invoke') && p.value) {
        if (p.key === 'invoke' && p.value.type === 'object') for (const q of pairs(p.value)) { if (q.key === 'onDone' || q.key === 'onError') for (const to of targetOf(q.value)) transitions.push({ from: s.key, to, event: q.key }) }
        else for (const to of targetOf(p.value)) transitions.push({ from: s.key, to, event: p.key })
      }
    }
  }
  return { name: varName, kind: 'machine', values, line: line(call), initial: initial ? unquote(initial.text) : values[0], transitions }
}

// Python
function pyFile(root: N, cx: ExtractCtx, o: Out): void {
  const visitClass = (n: N, decorators: string) => {
    const name = field(n, 'name')?.text ?? '?'
    const supers = named(field(n, 'superclasses')).filter((x) => x.type !== 'keyword_argument').map((x) => x.text)
    const members: MemberFact[] = []
    const isEnum = supers.some((s) => /(^|\.)(Enum|IntEnum|StrEnum|Flag|IntFlag)$/.test(s))
    for (const raw of named(field(n, 'body'))) {
      const m = raw.type === 'decorated_definition' ? field(raw, 'definition') ?? raw : raw
      if (m.type === 'function_definition') {
        const mn = field(m, 'name')?.text ?? '?'
        members.push(member(mn, 'method', m))
        o.fns.push(makeFn(m, mn, name, cx))
        if (mn === '__init__') for (const a of m.descendantsOfType('assignment')) {
          const l = field(a, 'left')
          if (l?.type === 'attribute' && field(l, 'object')?.text === 'self') { const fn = field(l, 'attribute')!.text; if (!members.some((x) => x.name === fn)) members.push(member(fn, 'field', a, field(a, 'type')?.text)) }
        }
      } else if (m.type === 'expression_statement' && m.namedChildren[0]?.type === 'assignment') {
        const a = m.namedChildren[0]; const l = field(a, 'left')
        if (l?.type === 'identifier') members.push(member(l.text, isEnum ? 'value' : 'field', a, field(a, 'type')?.text))
      } else if (m.type === 'class_definition') visitClass(m, '')
    }
    if (isEnum) o.states.push({ name, kind: 'enum', values: members.filter((x) => x.kind === 'value').map((x) => x.name), line: line(n) })
    void decorators
    o.decls.push(decl(name, isEnum ? 'enum' : /dataclass/.test(decorators) ? 'record' : 'class', n, { ext: supers, members }))
  }
  for (const raw of root.namedChildren) {
    const decorators = raw.type === 'decorated_definition' ? raw.namedChildren.filter((c) => c.type === 'decorator').map((d) => d.text).join(' ') : ''
    const n = raw.type === 'decorated_definition' ? field(raw, 'definition') ?? raw : raw
    if (n.type === 'import_statement') {
      for (const c of n.namedChildren) {
        const dn = c.type === 'aliased_import' ? field(c, 'name') : c
        const alias = c.type === 'aliased_import' ? field(c, 'alias')?.text : undefined
        if (dn) o.imports.push({ spec: dn.text, names: [alias ?? dn.text.split('.')[0]], line: line(n) })
      }
    } else if (n.type === 'import_from_statement') {
      const mod = field(n, 'module_name')
      const names = n.namedChildren.filter((c) => c !== mod).map((c) => (c.type === 'aliased_import' ? field(c, 'alias')?.text ?? field(c, 'name')?.text : c.text)).filter(Boolean) as string[]
      if (mod) o.imports.push({ spec: mod.text, names, line: line(n) })
    } else if (n.type === 'class_definition') visitClass(n, decorators)
    else if (n.type === 'function_definition') o.fns.push(makeFn(n, field(n, 'name')?.text ?? '?', undefined, cx))
    else if (n.type === 'expression_statement' && n.namedChildren[0]?.type === 'assignment') {
      const a = n.namedChildren[0]
      const m = /Literal\[([^\]]+)\]/.exec(a.text)
      const l = field(a, 'left')?.text
      if (m && l) { const vals = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]); if (vals.length >= 2) o.states.push({ name: l, kind: 'union', values: vals, line: line(n) }) }
    }
  }
}

// Java
function javaFile(root: N, cx: ExtractCtx, o: Out): void {
  const pkg = childOf(root, 'package_declaration')
  if (pkg) o.pkg = pkg.namedChildren.find((c) => c.type !== 'annotation' && c.type !== 'marker_annotation')?.text
  for (const imp of childrenOf(root, 'import_declaration')) {
    const t = imp.text.replace(/^import\s+(static\s+)?/, '').replace(/;\s*$/, '').replace(/\s+/g, '')
    o.imports.push({ spec: t, names: [t.split('.').pop() ?? t], line: line(imp), ...(/^import\s+static/.test(imp.text) ? { kind: 'static' as const } : {}) })
  }
  const visit = (n: N, owner?: string) => {
    const kind: DeclKind | undefined = n.type === 'class_declaration' ? 'class' : n.type === 'interface_declaration' ? 'interface' : n.type === 'enum_declaration' ? 'enum' : n.type === 'record_declaration' ? 'record' : n.type === 'annotation_type_declaration' ? 'interface' : undefined
    if (!kind) return
    const name = field(n, 'name')?.text ?? '?'
    const ext: string[] = []; const impl: string[] = []
    const sc = field(n, 'superclass'); if (sc) ext.push(...sc.namedChildren.map((x) => cleanType(x.text)))
    const si = field(n, 'interfaces'); if (si) impl.push(...si.descendantsOfType('type_list').flatMap((tl) => tl.namedChildren.map((x) => cleanType(x.text))))
    const ei = childOf(n, 'extends_interfaces'); if (ei) ext.push(...ei.descendantsOfType('type_list').flatMap((tl) => tl.namedChildren.map((x) => cleanType(x.text))))
    const members: MemberFact[] = []
    const body = field(n, 'body')
    const items = body ? [...body.namedChildren, ...(childOf(body, 'enum_body_declarations')?.namedChildren ?? [])] : []
    if (n.type === 'record_declaration') for (const p of named(field(n, 'parameters'))) { const pn = field(p, 'name')?.text; if (pn) members.push(member(pn, 'field', p, field(p, 'type')?.text)) }
    for (const m of items) {
      if (m.type === 'method_declaration' || m.type === 'constructor_declaration') {
        const mn = field(m, 'name')?.text ?? name
        members.push(member(mn, 'method', m))
        if (field(m, 'body')) o.fns.push(makeFn(m, mn, name, cx))
      } else if (m.type === 'field_declaration' || m.type === 'constant_declaration') {
        const t = field(m, 'type')?.text
        for (const d of childrenOf(m, 'variable_declarator')) { const dn = field(d, 'name')?.text; if (dn) members.push(member(dn, 'field', m, t)) }
      } else if (m.type === 'enum_constant') members.push(member(field(m, 'name')?.text ?? m.text, 'value', m))
      else visit(m, name)
    }
    if (kind === 'enum') o.states.push({ name, kind: 'enum', values: members.filter((x) => x.kind === 'value').map((x) => x.name), line: line(n) })
    o.decls.push(decl(name, kind, n, { ext, impl, members, owner }))
  }
  for (const n of root.namedChildren) visit(n)
}

// Go
function goFile(root: N, cx: ExtractCtx, o: Out): void {
  o.pkg = childOf(root, 'package_clause')?.namedChildren[0]?.text
  for (const spec of root.descendantsOfType('import_spec')) {
    const p = field(spec, 'path'); const nm = field(spec, 'name')
    if (p) { const s = unquote(p.text); o.imports.push({ spec: s, names: [nm?.text ?? s.split('/').pop()!], line: line(spec) }) }
  }
  const structs = new Map<string, DeclFact>()
  for (const n of root.namedChildren) {
    if (n.type === 'type_declaration') {
      for (const ts of childrenOf(n, 'type_spec')) {
        const name = field(ts, 'name')?.text ?? '?'
        const t = field(ts, 'type')
        if (!t) continue
        if (t.type === 'struct_type') {
          const members: MemberFact[] = []
          for (const fd of t.descendantsOfType('field_declaration')) {
            const ft = field(fd, 'type')?.text
            const names = childrenOf(fd, 'field_identifier')
            if (names.length) for (const fi of names) members.push(member(fi.text, 'field', fd, ft))
            else if (ft) members.push(member(ft.replace(/^\*/, ''), 'field', fd, ft)) // embedded
          }
          const d = decl(name, 'struct', ts, { members, ext: members.filter((m) => m.type && m.name === m.type.replace(/^\*/, '')).map((m) => m.name) })
          structs.set(name, d); o.decls.push(d)
        } else if (t.type === 'interface_type') {
          const members = t.namedChildren.filter((c) => c.type === 'method_spec' || c.type === 'method_elem').map((m) => member(field(m, 'name')?.text ?? m.text, 'method', m))
          o.decls.push(decl(name, 'interface', ts, { members }))
        } else o.decls.push(decl(name, 'type', ts, { members: [{ name: short(t.text, 40), kind: 'value', sig: fnv(t.text), line: line(ts) }] }))
      }
    } else if (n.type === 'function_declaration') o.fns.push(makeFn(n, field(n, 'name')?.text ?? '?', undefined, cx))
    else if (n.type === 'method_declaration') {
      const recv = field(n, 'receiver')
      const owner = recv ? (recv.text.match(/\*?\s*([A-Z_a-z]\w*)\s*(\[.*\])?\s*\)$/)?.[1]) : undefined
      const mn = field(n, 'name')?.text ?? '?'
      o.fns.push(makeFn(n, mn, owner, cx))
      const s = owner && structs.get(owner)
      if (s) s.members.push(member(mn, 'method', n))
    } else if (n.type === 'const_declaration') {
      const specs = childrenOf(n, 'const_spec')
      const typed = specs.find((s) => field(s, 'type'))
      if (typed && specs.length >= 2 && /iota/.test(n.text)) {
        o.states.push({ name: field(typed, 'type')!.text, kind: 'enum', values: specs.map((s) => field(s, 'name')?.text ?? s.namedChildren[0]?.text ?? '').filter(Boolean), line: line(n) })
      }
    }
  }
  // methods declared before their struct
  for (const f of o.fns) if (f.owner) { const s = structs.get(f.owner); if (s && !s.members.some((m) => m.name === f.name)) s.members.push({ name: f.name, kind: 'method', sig: f.sig, line: f.line }) }
  for (const s of structs.values()) s.sig = fnv(s.members.map((m) => `${m.kind}:${m.name}:${m.sig}`).join('|'))
}

// Rust
function rustFile(root: N, cx: ExtractCtx, o: Out): void {
  const types = new Map<string, DeclFact>()
  const visit = (n: N) => {
    switch (n.type) {
      case 'use_declaration': { const a = field(n, 'argument'); if (a) o.imports.push({ spec: a.text.replace(/\s+/g, ''), names: [], line: line(n) }); break }
      case 'mod_item': { const nm = field(n, 'name')?.text; const body = field(n, 'body'); if (nm && !body) o.imports.push({ spec: nm, names: [nm], line: line(n), kind: 'mod' }); if (body) for (const c of body.namedChildren) visit(c); break }
      case 'struct_item': {
        const name = field(n, 'name')?.text ?? '?'
        const members: MemberFact[] = []
        for (const fd of n.descendantsOfType('field_declaration')) members.push(member(field(fd, 'name')?.text ?? '?', 'field', fd, field(fd, 'type')?.text))
        const d = decl(name, 'struct', n, { members }); types.set(name, d); o.decls.push(d); break
      }
      case 'enum_item': {
        const name = field(n, 'name')?.text ?? '?'
        const vals = n.descendantsOfType('enum_variant').map((v) => field(v, 'name')?.text ?? v.text)
        o.states.push({ name, kind: 'enum', values: vals, line: line(n) })
        const d = decl(name, 'enum', n, { members: n.descendantsOfType('enum_variant').map((v) => member(field(v, 'name')?.text ?? v.text, 'value', v)) }); types.set(name, d); o.decls.push(d); break
      }
      case 'trait_item': {
        const name = field(n, 'name')?.text ?? '?'
        const members = named(field(n, 'body')).filter((c) => c.type === 'function_signature_item' || c.type === 'function_item').map((c) => member(field(c, 'name')?.text ?? '?', 'method', c))
        for (const c of named(field(n, 'body'))) if (c.type === 'function_item') o.fns.push(makeFn(c, field(c, 'name')?.text ?? '?', name, cx))
        o.decls.push(decl(name, 'trait', n, { members })); break
      }
      case 'impl_item': {
        const ty = cleanType(field(n, 'type')?.text ?? '?')
        const tr = field(n, 'trait')?.text
        for (const c of named(field(n, 'body'))) if (c.type === 'function_item') {
          const fn = makeFn(c, field(c, 'name')?.text ?? '?', ty, cx); o.fns.push(fn)
          const t = types.get(ty); if (t) t.members.push({ name: fn.name, kind: 'method', sig: fn.sig, line: fn.line })
        }
        const t = types.get(ty); if (t && tr) t.impl.push(cleanType(tr))
        break
      }
      case 'function_item': o.fns.push(makeFn(n, field(n, 'name')?.text ?? '?', undefined, cx)); break
    }
  }
  for (const n of root.namedChildren) visit(n)
  for (const t of types.values()) t.sig = fnv(t.members.map((m) => `${m.kind}:${m.name}:${m.sig}`).join('|') + t.impl.join(','))
}

// C#
function csFile(root: N, cx: ExtractCtx, o: Out): void {
  for (const u of root.descendantsOfType('using_directive')) {
    const t = u.text.replace(/^using\s+(static\s+)?/, '').replace(/;\s*$/, '').trim()
    if (!/=/.test(t)) o.imports.push({ spec: t, names: [], line: line(u) })
  }
  const visit = (n: N, owner?: string) => {
    if (n.type === 'namespace_declaration' || n.type === 'file_scoped_namespace_declaration') {
      o.pkg = o.pkg ?? field(n, 'name')?.text
      for (const c of named(field(n, 'body') ?? n)) visit(c, owner)
      return
    }
    const kind: DeclKind | undefined = n.type === 'class_declaration' ? 'class' : n.type === 'interface_declaration' ? 'interface' : n.type === 'struct_declaration' ? 'struct' : n.type === 'record_declaration' || n.type === 'record_struct_declaration' ? 'record' : n.type === 'enum_declaration' ? 'enum' : undefined
    if (!kind) return
    const name = field(n, 'name')?.text ?? '?'
    const bases = (field(n, 'bases') ?? childOf(n, 'base_list'))?.namedChildren.map((x) => cleanType(x.text)) ?? []
    const ext = kind === 'interface' ? bases : bases.filter((b) => !/^I[A-Z]/.test(b))
    const impl = kind === 'interface' ? [] : bases.filter((b) => /^I[A-Z]/.test(b))
    const members: MemberFact[] = []
    for (const m of named(field(n, 'body'))) {
      if (m.type === 'method_declaration' || m.type === 'constructor_declaration') {
        const mn = field(m, 'name')?.text ?? name
        members.push(member(mn, 'method', m))
        if (field(m, 'body')) o.fns.push(makeFn(m, mn, name, cx))
      } else if (m.type === 'property_declaration') members.push(member(field(m, 'name')?.text ?? '?', 'field', m, field(m, 'type')?.text))
      else if (m.type === 'field_declaration') {
        const vd = childOf(m, 'variable_declaration')
        const t = vd ? field(vd, 'type')?.text : undefined
        for (const d of vd ? childrenOf(vd, 'variable_declarator') : []) members.push(member((field(d, 'name') ?? d.namedChildren[0])?.text ?? '?', 'field', m, t))
      } else if (m.type === 'enum_member_declaration') members.push(member(field(m, 'name')?.text ?? m.text, 'value', m))
      else visit(m, name)
    }
    if (kind === 'enum') o.states.push({ name, kind: 'enum', values: members.map((x) => x.name), line: line(n) })
    o.decls.push(decl(name, kind, n, { ext, impl, members, owner }))
  }
  for (const n of root.namedChildren) visit(n)
}

// Kotlin
function ktFile(root: N, cx: ExtractCtx, o: Out): void {
  const pkg = childOf(root, 'package_header'); if (pkg) o.pkg = pkg.namedChildren[0]?.text
  for (const h of root.descendantsOfType('import_header')) { const id = h.namedChildren[0]?.text; if (id) o.imports.push({ spec: id, names: [id.split('.').pop()!], line: line(h) }) }
  const fnName = (n: N) => childOf(n, 'simple_identifier')?.text ?? '?'
  const visit = (n: N, owner?: string) => {
    if (n.type === 'function_declaration') { o.fns.push(makeFn(n, fnName(n), owner, cx)); return }
    if (n.type !== 'class_declaration' && n.type !== 'object_declaration') return
    const name = childOf(n, 'type_identifier')?.text ?? '?'
    const isEnum = !!childOf(n, 'enum_class_body')
    const isIface = n.children.some((c) => c.type === 'interface')
    const isData = /\bdata\b/.test(childOf(n, 'modifiers')?.text ?? '')
    const kind: DeclKind = n.type === 'object_declaration' ? 'object' : isEnum ? 'enum' : isIface ? 'interface' : isData ? 'record' : 'class'
    const ext: string[] = []; const impl: string[] = []
    for (const d of childrenOf(n, 'delegation_specifier')) {
      const ci = childOf(d, 'constructor_invocation')
      if (ci) ext.push(cleanType(childOf(ci, 'user_type')?.text ?? ci.text)); else impl.push(cleanType(d.text))
    }
    const members: MemberFact[] = []
    for (const p of n.descendantsOfType('class_parameter')) if (childOf(p, 'binding_pattern_kind') && p.parent?.parent === n) members.push(member(childOf(p, 'simple_identifier')?.text ?? '?', 'field', p, childOf(p, 'user_type', 'nullable_type')?.text))
    const body = childOf(n, 'class_body', 'enum_class_body')
    for (const m of named(body)) {
      if (m.type === 'function_declaration') { const mn = fnName(m); members.push(member(mn, 'method', m)); o.fns.push(makeFn(m, mn, name, cx)) }
      else if (m.type === 'property_declaration') { const vd = childOf(m, 'variable_declaration'); members.push(member(childOf(vd ?? m, 'simple_identifier')?.text ?? '?', 'field', m, vd ? childOf(vd, 'user_type', 'nullable_type')?.text : undefined)) }
      else if (m.type === 'enum_entry') members.push(member(childOf(m, 'simple_identifier')?.text ?? m.text, 'value', m))
      else if (m.type === 'companion_object') for (const c of named(childOf(m, 'class_body'))) visit(c, name)
      else visit(m, name)
    }
    if (isEnum) o.states.push({ name, kind: 'enum', values: members.filter((x) => x.kind === 'value').map((x) => x.name), line: line(n) })
    o.decls.push(decl(name, kind, n, { ext, impl, members, owner }))
  }
  for (const n of root.namedChildren) visit(n)
}

// ---------------------------------------------------------------------------------------------------- regex extras
const ROUTE_RES: { re: RegExp; m: number; p: number }[] = [
  { re: /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']/g, m: 1, p: 2 },
  { re: /@(?:\w+)\.(get|post|put|delete|patch|route|websocket)\(\s*["']([^"']+)["']/g, m: 1, p: 2 },
  { re: /\[(?:Http)(Get|Post|Put|Delete|Patch)\(\s*"([^"]*)"\s*\)\]/g, m: 1, p: 2 },
  { re: /\[(Route)\(\s*"([^"]*)"\s*\)\]/g, m: 1, p: 2 },
  { re: /@(Get|Post|Put|Delete|Patch|All)\(\s*['"`]([^'"`]*)['"`]/g, m: 1, p: 2 },
  { re: /\b(?:app|router|server|api|r|e|g|mux|http|route|routes|v1|group)\.(get|post|put|delete|patch|all|GET|POST|PUT|DELETE|PATCH|HandleFunc|Handle)\(\s*['"`](\/[^'"`]*)['"`]/g, m: 1, p: 2 }
]
const EMIT_RE = /(?:\.|\b)(emit|publish|dispatch|trigger|invoke|send|dispatchEvent|produce)\(\s*['"`]([A-Za-z][\w:.\-/]{1,60})['"`]/g
const ON_RE = /(?:\.|\b)(on|once|subscribe|addEventListener|addListener|handle|listen|consume)\(\s*['"`]([A-Za-z][\w:.\-/]{1,60})['"`]/g
const DOM_EVENTS = set('click', 'change', 'input', 'keydown', 'keyup', 'mousedown', 'mouseup', 'mousemove', 'resize', 'scroll', 'focus', 'blur', 'submit', 'load', 'error', 'message', 'close', 'data', 'end', 'exit', 'ready-to-show', 'maximize', 'unmaximize', 'wheel', 'pointerdown', 'pointerup', 'pointermove', 'contextmenu', 'dragstart', 'drop', 'paste', 'copy', 'beforeunload', 'visibilitychange', 'storage', 'popstate', 'hashchange', 'keypress', 'dblclick', 'touchstart', 'touchend', 'selectionchange', 'open', 'connection', 'request', 'response', 'finish', 'drain', 'readable', 'spawn', 'disconnect', 'online', 'offline')

export function regexExtras(src: string): { routes: RouteFact[]; events: EventFact[] } {
  // line starts once, binary search per match (the old per-match scan was O(matches × file size))
  const starts = [0]; for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) starts.push(k + 1)
  const lineAt = (i: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= i) lo = m; else hi = m - 1 } return lo + 1 }
  const routes: RouteFact[] = []
  for (const { re, m, p } of ROUTE_RES) for (const x of src.matchAll(re)) routes.push({ method: x[m].toUpperCase().replace('HANDLEFUNC', 'ANY').replace('HANDLE', 'ANY').replace('REQUEST', 'ANY').replace('ROUTE', 'ANY'), path: x[p] || '/', line: lineAt(x.index ?? 0) })
  const events: EventFact[] = []
  for (const x of src.matchAll(EMIT_RE)) if (!DOM_EVENTS.has(x[2])) events.push({ dir: 'emit', name: x[2], line: lineAt(x.index ?? 0) })
  for (const x of src.matchAll(ON_RE)) if (!DOM_EVENTS.has(x[2])) events.push({ dir: 'on', name: x[2], line: lineAt(x.index ?? 0) })
  const seen = new Set<string>()
  return { routes: routes.filter((r) => { const k = r.method + r.path; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 200), events: events.slice(0, 300) }
}

/** imports for languages without a grammar (file-level graph only) */
export function shallowImports(src: string, lang: string): ImportFact[] {
  const out: ImportFact[] = []
  const add = (re: RegExp) => { for (const m of src.matchAll(re)) out.push({ spec: m[1], names: [], line: src.slice(0, m.index).split('\n').length }) }
  if (lang === 'c' || lang === 'cpp') add(/#include\s*"([^"]+)"/g)
  else if (lang === 'ruby') { add(/require_relative\s+['"]([^'"]+)['"]/g); add(/require\s+['"]([^'"]+)['"]/g) }
  else if (lang === 'php') { add(/^\s*use\s+([\w\\]+)\s*;/gm); add(/(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g) }
  else if (lang === 'swift' || lang === 'scala' || lang === 'dart') add(/^\s*import\s+['"]?([\w./:\-]+)['"]?/gm)
  else if (lang === 'vue' || lang === 'svelte') { add(/import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g); add(/import\s+['"]([^'"]+)['"]/g) }
  else if (lang === 'lua') add(/require\s*\(?\s*['"]([^'"]+)['"]/g)
  return out
}

export function extractFacts(root: N, cx: ExtractCtx): Omit<FileFacts, 'path' | 'lang' | 'lines' | 'hash' | 'routes' | 'events' | 'idents'> {
  const o: Out = { imports: [], decls: [], fns: [], states: [] }
  switch (cx.lang) {
    case 'typescript': case 'tsx': case 'javascript': tsFile(root, cx, o); break
    case 'python': pyFile(root, cx, o); break
    case 'java': javaFile(root, cx, o); break
    case 'go': goFile(root, cx, o); break
    case 'rust': rustFile(root, cx, o); break
    case 'csharp': csFile(root, cx, o); break
    case 'kotlin': ktFile(root, cx, o); break
  }
  return { imports: o.imports, decls: o.decls, fns: o.fns, states: o.states, ...(o.pkg ? { pkg: o.pkg } : {}) }
}
