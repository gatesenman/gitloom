// Write a hook template to a file (used by demo script / docs): node scripts/export-hook.mjs llmwiki out.sh
import { readFileSync, writeFileSync } from 'fs'
const src = readFileSync(new URL('../src/main/git/hookTemplates.ts', import.meta.url), 'utf8')
const id = process.argv[2] ?? 'llmwiki'
const name = { llmwiki: 'LLMWIKI', conventional: 'CONVENTIONAL' }[id]
const m = new RegExp('const ' + name + ' = `([\\s\\S]*?)`\\n\\n').exec(src)
const body = m[1].replace(/\\`/g, '`').replace(/\\\$\{/g, '${').replace(/\\\\/g, '\\')
writeFileSync(process.argv[3] ?? `${id}.sh`, body, { mode: 0o755 })
