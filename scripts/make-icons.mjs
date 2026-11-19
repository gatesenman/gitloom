// Render build/logo.svg into PNG / ICO / ICNS for all platforms.
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build/logo.svg'), 'utf8')
const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()

mkdirSync(join(root, 'build/icons'), { recursive: true })
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const pngs = {}
for (const s of sizes) {
  pngs[s] = render(s)
  writeFileSync(join(root, `build/icons/${s}x${s}.png`), pngs[s])
}
writeFileSync(join(root, 'build/icon.png'), pngs[1024])
// Windows ICO (16-256)
writeFileSync(join(root, 'build/icon.ico'), await pngToIco([pngs[16], pngs[24], pngs[32], pngs[48], pngs[64], pngs[128], pngs[256]]))
// macOS ICNS (PNG-encoded entries)
const entries = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]
const chunks = entries.map(([type, s]) => {
  const data = pngs[s]
  const head = Buffer.alloc(8)
  head.write(type, 0, 'ascii')
  head.writeUInt32BE(data.length + 8, 4)
  return Buffer.concat([head, data])
})
const body = Buffer.concat(chunks)
const header = Buffer.alloc(8)
header.write('icns', 0, 'ascii')
header.writeUInt32BE(body.length + 8, 4)
writeFileSync(join(root, 'build/icon.icns'), Buffer.concat([header, body]))
mkdirSync(join(root, 'screenshots'), { recursive: true })
writeFileSync(join(root, 'screenshots/logo.png'), pngs[512])
console.log('icons written:', sizes.join(', '), '+ icon.ico + icon.icns')
