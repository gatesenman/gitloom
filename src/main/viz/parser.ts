// Loads web-tree-sitter + grammars from a directory and turns a source string into FileFacts.
// Used inside the analysis worker (and directly by unit tests).
import Parser from 'web-tree-sitter'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { extractFacts, regexExtras, shallowImports } from './extract'
import { fnv, type FileFacts } from './facts'
import { LANGS, hasGrammar } from './langs'

export class FactParser {
  private ready: Promise<void> | null = null
  private langs = new Map<string, Parser.Language | null>()
  private parser: Parser | null = null
  constructor(private grammarDir: string, private runtimeWasm?: string) {}

  init(): Promise<void> {
    if (!this.ready) {
      const wasm = this.runtimeWasm && existsSync(this.runtimeWasm) ? readFileSync(this.runtimeWasm) : undefined
      this.ready = Parser.init(wasm ? { wasmBinary: wasm } : undefined).then(() => { this.parser = new Parser() })
    }
    return this.ready
  }

  private async lang(id: string): Promise<Parser.Language | null> {
    if (this.langs.has(id)) return this.langs.get(id)!
    const g = LANGS[id]?.grammar
    let l: Parser.Language | null = null
    if (g) {
      const p = join(this.grammarDir, g)
      if (existsSync(p)) l = await Parser.Language.load(readFileSync(p))
    }
    this.langs.set(id, l)
    return l
  }

  async parse(path: string, lang: string, src: string): Promise<FileFacts> {
    await this.init()
    const base: FileFacts = { path, lang, imports: [], decls: [], fns: [], states: [], routes: [], events: [], idents: [], lines: src.split('\n').length, hash: fnv(src) }
    const { routes, events } = regexExtras(src)
    base.routes = routes; base.events = events
    base.idents = [...new Set(src.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? [])].slice(0, 600)
    if (!hasGrammar(lang) || src.length > 1_500_000) return { ...base, imports: shallowImports(src, lang), shallow: true }
    const L = await this.lang(lang)
    if (!L || !this.parser) return { ...base, imports: shallowImports(src, lang), shallow: true }
    this.parser.setLanguage(L)
    const tree = this.parser.parse(src)
    try {
      return { ...base, ...extractFacts(tree.rootNode, { lang, src }) }
    } catch (e) {
      return { ...base, shallow: true, error: String((e as Error)?.message ?? e) }
    } finally { tree.delete() }
  }
}
