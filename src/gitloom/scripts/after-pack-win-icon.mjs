/**
 * electron-builder skips rcedit when win.signAndEditExecutable is false (common on
 * Linux to avoid wine/signing issues). That also means icon.ico never lands in
 * GitLoom.exe — Start Menu / desktop / taskbar show a blank default icon.
 *
 * afterPack: wine-run cached rcedit-x64 --set-icon on the packed exe.
 * Window title bar still uses extraResources/icon.png via BrowserWindow.icon.
 */
import { spawnSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ico = join(root, 'build/icon.ico')

function resolveRcedit() {
  const cache = join(homedir(), '.cache/electron-builder/winCodeSign')
  for (const name of ['rcedit-x64.exe', 'rcedit-ia32.exe']) {
    const pinned = join(cache, 'winCodeSign-2.6.0', name)
    if (existsSync(pinned)) return pinned
  }
  if (!existsSync(cache)) return null
  for (const d of readdirSync(cache).sort().reverse()) {
    for (const name of ['rcedit-x64.exe', 'rcedit-ia32.exe']) {
      const p = join(cache, d, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const exeName = `${context.packager.appInfo.productFilename}.exe`
  const exe = join(context.appOutDir, exeName)
  if (!existsSync(exe)) {
    console.warn('[after-pack-win-icon] exe not found:', exe)
    return
  }
  if (!existsSync(ico)) {
    console.warn('[after-pack-win-icon] icon.ico missing:', ico)
    return
  }
  const rcedit = resolveRcedit()
  if (!rcedit) {
    console.warn('[after-pack-win-icon] rcedit*.exe not in electron-builder cache')
    return
  }
  const wine = process.env.WINE || (existsSync('/usr/lib/wine/wine64') ? '/usr/lib/wine/wine64' : existsSync('/usr/bin/wine64') ? 'wine64' : 'wine')
  console.log(`[after-pack-win-icon] ${wine} ${rcedit} --set-icon → ${exe}`)
  const r = spawnSync(wine, [rcedit, exe, '--set-icon', ico], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, WINEDEBUG: '-all' },
  })
  if (r.status !== 0) {
    console.warn('[after-pack-win-icon] rcedit failed', r.status, (r.stderr || r.stdout || '').slice(0, 500))
    return
  }
  console.log('[after-pack-win-icon] icon embedded OK')
}
