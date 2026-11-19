// State machines from static facts: union-of-literals types, enums and xstate configs; transitions are found where a
// state value is assigned/returned/set inside a `switch (state)` case or an `if (state === X)` branch (from = X),
// otherwise from = 任意状态.
import { posix } from 'path'
import type { FlowStep, StateFact } from './facts'
import type { SideModel } from './model'

export interface RawMachine { key: string; name: string; file: string; values: string[]; initial?: string; transitions: { from: string; to: string; event: string }[]; kind: StateFact['kind'] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const ANY = '*'

export function machinesOf(model: SideModel): RawMachine[] {
  const out: RawMachine[] = []
  for (const [file, f] of model.files) {
    for (const st of f.states) {
      const values = [...new Set(st.values)].filter(Boolean)
      if (values.length < 2 || values.length > 40) continue
      const m: RawMachine = { key: `${file}#${st.name}`, name: st.name, file, values, initial: st.initial ?? values[0], transitions: [...(st.transitions ?? [])], kind: st.kind }
      if (st.kind !== 'machine') m.transitions.push(...scanTransitions(model, file, st, values))
      // a plain value set (event names, kinds, colours…) is only a state machine if something moves between values
      if (!m.transitions.length && !/(state|status|phase|stage|step|mode|lifecycle)s?$/i.test(st.name)) continue
      out.push(m)
    }
  }
  return out
}

function scanTransitions(model: SideModel, file: string, st: StateFact, values: string[]): { from: string; to: string; event: string }[] {
  const q = st.kind === 'union'
  const vAlt = values.map(esc).join('|')
  // how a value is written: quoted literal for unions, Enum.Value / Enum::Value for enums
  const valRe = q ? `["'\`](${vAlt})["'\`]` : `\\b${esc(st.name)}(?:\\.|::)(${vAlt})\\b`
  const targetRes = [
    new RegExp(`(?:[^=!<>]=|:|\\breturn\\b|=>)\\s*(?:new\\s+)?${valRe}`),
    new RegExp(`\\b(?:set|transition|goTo|goto|moveTo|changeState|setState|update|to|enter)\\w*\\s*\\(\\s*(?:\\w+\\s*,\\s*)?${valRe}`, 'i')
  ]
  const condRe = new RegExp(`(?:===?|!==?|\\bis\\b|\\bin\\b|case|==)\\s*${valRe}|${valRe}\\s*(?:===?|==)`)
  const caseVal = (label: string): string | undefined => {
    const m = new RegExp(valRe).exec(label)
    if (m) return m[1]
    const bare = label.replace(/^\./, '').trim()
    return !q && values.includes(bare) ? bare : undefined
  }
  const related = [...model.files.keys()].filter((p) => p === file || model.imports.get(p)?.has(file))
  const out: { from: string; to: string; event: string }[] = []
  const seen = new Set<string>()
  const add = (from: string, to: string, event: string) => {
    if (from === to) return
    const k = `${from}>${to}|${event}`
    if (seen.has(k) || out.length > 80) return
    seen.add(k); out.push({ from, to, event })
  }
  for (const p of related) {
    for (const r of model.fnsByFile.get(p) ?? []) {
      const walk = (steps: FlowStep[], from: string, ev: string) => {
        for (const s of steps) {
          if (s.t === 'stmt' || s.t === 'return') {
            for (const re of targetRes) { const m = re.exec(s.text); if (m) { add(from, m[1], ev); break } }
          } else if (s.t === 'if') {
            for (const b of s.branches) { const m = condRe.exec(b.label); const lit = !m ? /["'`]([\w:-]{1,30})["'`]/.exec(b.label)?.[1] : undefined; walk(b.body, m ? (m[1] ?? m[2]) : from, lit ?? ev) }
          } else if (s.t === 'switch') {
            const labels = s.cases.map((c) => caseVal(c.label))
            const onState = labels.filter(Boolean).length >= Math.max(1, Math.ceil(s.cases.length / 2))
            s.cases.forEach((c, i) => walk(c.body, onState && labels[i] ? labels[i]! : from, onState ? ev : c.label.replace(/^['"`]|['"`]$/g, '')))
          } else if (s.t === 'loop') walk(s.body, from, ev)
          else if (s.t === 'try') { walk(s.body, from, ev); s.catches.forEach((c) => walk(c.body, from, ev)); if (s.fin) walk(s.fin, from, ev) }
        }
      }
      walk(r.f.flow, ANY, r.f.name)
    }
  }
  return out
}

export const machineTitle = (m: RawMachine) => `${m.name} · ${posix.basename(m.file)}`
