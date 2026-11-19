// Language-neutral facts extracted from one source file (one blob). Cached by blob sha / content hash.

export type DeclKind = 'class' | 'interface' | 'type' | 'enum' | 'struct' | 'trait' | 'object' | 'record'

export interface ImportFact { spec: string; names: string[]; line: number; kind?: 'mod' | 'static' | 'dynamic' }
export interface MemberFact { name: string; kind: 'field' | 'method' | 'value'; sig: string; line: number; type?: string }
export interface DeclFact {
  name: string
  kind: DeclKind
  line: number
  endLine: number
  ext: string[]
  impl: string[]
  members: MemberFact[]
  sig: string
  /** type names referenced by fields (composition) */
  uses: string[]
  owner?: string
}
export interface CallFact { name: string; recv?: string; line: number; isNew?: boolean }
export type FlowStep =
  | { t: 'stmt'; text: string; line: number; calls?: CallFact[] }
  | { t: 'if'; line: number; branches: { label: string; body: FlowStep[] }[] }
  | { t: 'loop'; label: string; line: number; body: FlowStep[]; calls?: CallFact[] }
  | { t: 'switch'; label: string; line: number; cases: { label: string; body: FlowStep[] }[] }
  | { t: 'try'; line: number; body: FlowStep[]; catches: { label: string; body: FlowStep[] }[]; fin?: FlowStep[] }
  | { t: 'return' | 'throw'; text: string; line: number; calls?: CallFact[] }
  | { t: 'jump'; text: string; line: number }

export interface FnFact {
  name: string
  owner?: string
  line: number
  endLine: number
  /** hash of the normalized body */
  sig: string
  params: string
  calls: CallFact[]
  flow: FlowStep[]
  /** non-blank lines */
  size: number
}
export interface StateFact {
  name: string
  kind: 'union' | 'enum' | 'machine'
  values: string[]
  line: number
  initial?: string
  transitions?: { from: string; to: string; event: string }[]
}
export interface RouteFact { method: string; path: string; line: number }
export interface EventFact { dir: 'emit' | 'on'; name: string; line: number }

export interface FileFacts {
  path: string
  lang: string
  pkg?: string
  imports: ImportFact[]
  decls: DeclFact[]
  fns: FnFact[]
  states: StateFact[]
  routes: RouteFact[]
  events: EventFact[]
  /** capitalised identifiers referenced in the file (type-reference resolution for Java/C#/Kotlin/Go) */
  idents: string[]
  lines: number
  hash: string
  /** no grammar: imports only (regex) */
  shallow?: boolean
  error?: string
}

/** FNV-1a 32-bit, hex — fast, deterministic content signature (not security relevant). */
export function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
export const normWs = (s: string): string => s.replace(/\s+/g, ' ').trim()
