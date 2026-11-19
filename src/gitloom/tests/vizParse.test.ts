// tree-sitter fact extraction, one realistic file per grammar (9 languages) + shallow fallback + language registry
import { describe, it, expect, beforeAll } from 'vitest'
import { FactParser } from '../src/main/viz/parser'
import { langOf, hasGrammar, GRAMMAR_FILES } from '../src/main/viz/langs'
import { parseCallee, regexExtras } from '../src/main/viz/extract'
import { SNIPPETS } from './fixtures/vizSnippets'
import type { FileFacts } from '../src/main/viz/facts'

const p = new FactParser('node_modules/tree-sitter-wasms/out', 'node_modules/web-tree-sitter/tree-sitter.wasm')
const F: Record<string, FileFacts> = {}
beforeAll(async () => { for (const [lang, s] of Object.entries(SNIPPETS)) F[lang] = await p.parse(s.path, lang, s.src) }, 60000)
const fn = (l: string, name: string) => F[l].fns.find((f) => (f.owner ? f.owner + '.' : '') + f.name === name)
const calls = (l: string, name: string) => fn(l, name)?.calls.map((c) => (c.recv ? c.recv + '.' : '') + c.name) ?? []
const decl = (l: string, name: string) => F[l].decls.find((d) => d.name === name)

describe('viz parsers (tree-sitter)', () => {
  it('registry: extensions, excluded paths, 9 grammars', () => {
    expect(langOf('a/b.ts')).toBe('typescript'); expect(langOf('x.tsx')).toBe('tsx'); expect(langOf('x.py')).toBe('python')
    expect(langOf('x.d.ts')).toBeUndefined(); expect(langOf('node_modules/a/b.js')).toBeUndefined(); expect(langOf('a.min.js')).toBeUndefined()
    expect(langOf('README.md')).toBeUndefined(); expect(langOf('main.rb')).toBe('ruby'); expect(hasGrammar('ruby')).toBe(false)
    expect(GRAMMAR_FILES.length).toBe(9)
  })
  it('every grammar parses without falling back to shallow', () => {
    for (const l of Object.keys(SNIPPETS)) { expect(F[l].shallow, l).toBeFalsy(); expect(F[l].error, l).toBeFalsy(); expect(F[l].fns.length, l).toBeGreaterThan(0) }
  })
  it('TypeScript: imports, class members, calls, union state, emit event', () => {
    expect(F.typescript.imports.map((i) => i.spec)).toEqual(['../db/store', './model'])
    expect(decl('typescript', 'OrderService')?.members.map((m) => m.name)).toEqual(['n', 'pay', 'notify'])
    expect(calls('typescript', 'OrderService.pay')).toEqual(expect.arrayContaining(['save', 'this.notify']))
    expect(F.typescript.states[0]).toMatchObject({ name: 'OrderStatus', kind: 'union', values: ['new', 'paid', 'shipped'] })
    expect(F.typescript.events.map((e) => e.name)).toContain('order.paid')
    expect(fn('typescript', 'OrderService.pay')!.flow.some((s) => s.t === 'if')).toBe(true)
  })
  it('TSX: component function + calls through JSX handlers', () => {
    expect(calls('tsx', 'Page')).toEqual(expect.arrayContaining(['total', 'load']))
  })
  it('JavaScript: ES import + require, try/catch flow', () => {
    expect(F.javascript.imports.map((i) => i.spec).sort()).toEqual(['fs', 'path'])
    expect(fn('javascript', 'read')!.flow.some((s) => s.t === 'try')).toBe(true)
    expect(decl('javascript', 'Cache')).toBeTruthy()
  })
  it('Python: relative import, inheritance, enum state, method calls', () => {
    expect(F.python.imports.map((i) => i.spec)).toContain('.db')
    expect(decl('python', 'Admin')?.ext).toContain('User')
    expect(F.python.states[0]).toMatchObject({ name: 'Status', kind: 'enum', values: ['ACTIVE', 'DELETED'] })
    expect(calls('python', 'Admin.ban')).toContain('session.save')
  })
  it('Java: package, implements, enum, field type usage', () => {
    expect(F.java.pkg).toBe('com.shop')
    expect(decl('java', 'PaymentGateway')?.impl).toContain('Gateway')
    expect(F.java.states[0].values).toEqual(['NEW', 'PAID', 'FAILED'])
    expect(calls('java', 'PaymentGateway.pay')).toContain('repo.save')
  })
  it('Go: package, struct methods (receiver owner), qualified calls', () => {
    expect(F.go.pkg).toBe('api')
    expect(F.go.imports.map((i) => i.spec)).toEqual(['fmt', 'shop/internal/store'])
    expect(fn('go', 'Handler.Get')).toBeTruthy(); expect(calls('go', 'Handler.Get')).toContain('fmt.Errorf')
  })
  it('Rust: use/mod imports, impl methods, enum', () => {
    expect(F.rust.imports.map((i) => i.spec)).toEqual(expect.arrayContaining(['std::collections::HashMap', 'store']))
    expect(fn('rust', 'Cache.get')).toBeTruthy()
    expect(F.rust.states[0].values).toEqual(['Idle', 'Busy'])
  })
  it('C#: namespace, base class, enum, throw', () => {
    expect(F.csharp.pkg).toBe('Shop.Orders')
    expect(decl('csharp', 'OrderController')?.ext.concat(decl('csharp', 'OrderController')!.impl)).toContain('ControllerBase')
    expect(calls('csharp', 'OrderController.Get')).toContain('svc.Find')
  })
  it('Kotlin: package, class + top-level fn, calls', () => {
    expect(F.kotlin.pkg).toBe('app')
    expect(calls('kotlin', 'Repo.load')).toContain('api.fetch')
    expect(fn('kotlin', 'helper')).toBeTruthy()
  })
  it('deterministic: same source → identical facts and hash', async () => {
    const a = await p.parse('x.ts', 'typescript', SNIPPETS.typescript.src)
    const b = await p.parse('x.ts', 'typescript', SNIPPETS.typescript.src)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const c = await p.parse('x.ts', 'typescript', SNIPPETS.typescript.src.replace('save(o)', 'save(o, true)'))
    expect(c.hash).not.toBe(a.hash); expect(c.fns.find((f) => f.name === 'pay')!.sig).not.toBe(a.fns.find((f) => f.name === 'pay')!.sig)
  })
  it('shallow languages: regex imports only', async () => {
    const r = await p.parse('a.rb', 'ruby', "require 'json'\nrequire_relative 'lib/x'\n")
    expect(r.shallow).toBe(true); expect(r.imports.length).toBeGreaterThan(0)
  })
  it('parseCallee + routes/events regexes', () => {
    expect(parseCallee('this.repo.save')).toMatchObject({ name: 'save' })
    const x = regexExtras("router.get('/orders/:id', h)\n@PostMapping(\"/pay\")\nbus.emit('order.paid')\nemit('order.cancelled', o)\nel.on('click', f)\nform.submit('x')")
    expect(x.routes.map((r) => r.method + ' ' + r.path)).toEqual(expect.arrayContaining(['GET /orders/:id', 'POST /pay']))
    expect(x.events.map((e) => e.name)).toEqual(['order.paid', 'order.cancelled'])
    expect(x.events[1].line).toBe(4)
  })
})
