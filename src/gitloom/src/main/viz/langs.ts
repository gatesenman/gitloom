// Language registry: extension → tree-sitter grammar. Grammars come from `tree-sitter-wasms` (prebuilt WASM, MIT).
export interface LangInfo { id: string; grammar?: string; label: string }

export const LANGS: Record<string, LangInfo> = {
  typescript: { id: 'typescript', grammar: 'tree-sitter-typescript.wasm', label: 'TypeScript' },
  tsx: { id: 'tsx', grammar: 'tree-sitter-tsx.wasm', label: 'TSX' },
  javascript: { id: 'javascript', grammar: 'tree-sitter-javascript.wasm', label: 'JavaScript' },
  python: { id: 'python', grammar: 'tree-sitter-python.wasm', label: 'Python' },
  java: { id: 'java', grammar: 'tree-sitter-java.wasm', label: 'Java' },
  go: { id: 'go', grammar: 'tree-sitter-go.wasm', label: 'Go' },
  rust: { id: 'rust', grammar: 'tree-sitter-rust.wasm', label: 'Rust' },
  csharp: { id: 'csharp', grammar: 'tree-sitter-c_sharp.wasm', label: 'C#' },
  kotlin: { id: 'kotlin', grammar: 'tree-sitter-kotlin.wasm', label: 'Kotlin' },
  // shallow (imports via regex, file-level graph only)
  c: { id: 'c', label: 'C' }, cpp: { id: 'cpp', label: 'C++' }, ruby: { id: 'ruby', label: 'Ruby' }, php: { id: 'php', label: 'PHP' },
  swift: { id: 'swift', label: 'Swift' }, scala: { id: 'scala', label: 'Scala' }, vue: { id: 'vue', label: 'Vue' }, svelte: { id: 'svelte', label: 'Svelte' },
  dart: { id: 'dart', label: 'Dart' }, lua: { id: 'lua', label: 'Lua' }
}

const EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  py: 'python', pyi: 'python', java: 'java', go: 'go', rs: 'rust', cs: 'csharp', kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', rb: 'ruby', php: 'php', swift: 'swift', scala: 'scala',
  vue: 'vue', svelte: 'svelte', dart: 'dart', lua: 'lua'
}

export function langOf(path: string): string | undefined {
  if (/\.d\.ts$/.test(path)) return undefined
  if (/(^|\/)(node_modules|vendor|dist|build|out|target|\.git|__pycache__|\.venv|venv)\//.test(path)) return undefined
  if (/\.min\.js$/.test(path)) return undefined
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return m ? EXT[m[1].toLowerCase()] : undefined
}
export const hasGrammar = (lang: string): boolean => !!LANGS[lang]?.grammar
export const GRAMMAR_FILES = [...new Set(Object.values(LANGS).map((l) => l.grammar).filter(Boolean))] as string[]
