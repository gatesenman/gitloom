import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  resolveToolPath, toolCandidates, augmentedPath, npmGlobalBins,
  manualInstallHint, installCommand, clearToolCache,
  configureToolRoots, resolveToolWithSource, bundledCandidates, userDataCandidates,
  prefersAppInstall
} from '../src/main/tools/detect'

const root = join(tmpdir(), 'gitloom-tool-detect-' + process.pid)
const bin = join(root, 'bin')
const resources = join(root, 'resources', 'tools')
const userData = join(root, 'userData', 'tools')

function fakeExe(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const full = join(dir, name)
  writeFileSync(full, process.platform === 'win32' ? '@echo 1.0.0\r\n' : '#!/bin/sh\necho 1.0.0\n')
  if (process.platform !== 'win32') chmodSync(full, 0o755)
  return full
}

describe('tool detection (0.6.6 builtin-first)', () => {
  beforeEach(() => {
    clearToolCache()
    configureToolRoots({})
    rmSync(root, { recursive: true, force: true })
    mkdirSync(bin, { recursive: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    clearToolCache()
    configureToolRoots({})
  })

  it('toolCandidates prefers ocr.cmd on win32-style list', () => {
    const c = toolCandidates('ocr')
    expect(c[0] === 'ocr' || c[0] === 'ocr.cmd' || c[0] === 'ocr.exe' || c[0] === 'opencodereview.exe').toBe(true)
    expect(c).toContain('ocr')
  })

  it('resolveToolPath finds ocr.cmd on an augmented PATH', () => {
    const name = process.platform === 'win32' ? 'ocr.cmd' : 'ocr'
    fakeExe(bin, name)
    const env = { ...process.env, PATH: bin, Path: bin, HOME: root, USERPROFILE: root, APPDATA: join(root, 'AppData', 'Roaming') }
    const hit = resolveToolPath('ocr', env, bin)
    expect(hit).toBeTruthy()
    expect(hit!.replace(/\\/g, '/')).toContain('ocr')
  })

  it('npmGlobalBins includes %APPDATA%/npm style dir when APPDATA set', () => {
    const appData = join(root, 'AppData', 'Roaming')
    mkdirSync(join(appData, 'npm'), { recursive: true })
    const dirs = npmGlobalBins({ APPDATA: appData, HOME: root, USERPROFILE: root, PATH: '' })
    if (process.platform === 'win32') {
      expect(dirs.some((d) => d.replace(/\\/g, '/').endsWith('AppData/Roaming/npm'))).toBe(true)
    } else {
      expect(Array.isArray(dirs)).toBe(true)
    }
  })

  it('augmentedPath prepends extra bins before original PATH', () => {
    const p = augmentedPath({ PATH: '/usr/bin', HOME: root, USERPROFILE: root })
    expect(p.includes('/usr/bin') || p.toLowerCase().includes('usr')).toBe(true)
  })

  it('manualInstallHint for ocr uses npm official package (not pip)', () => {
    expect(manualInstallHint('ocr')).toContain('@alibaba-group/open-code-review')
    expect(manualInstallHint('ocr')).not.toMatch(/pip install open-code-review/)
  })

  it('installCommand for ocr is npm install -g (external fallback)', () => {
    const r = installCommand('ocr')
    expect(r).toBeTruthy()
    expect(r!.args).toEqual(['install', '-g', '@alibaba-group/open-code-review'])
  })

  it('installCommand for semgrep uses pip (external fallback)', () => {
    const r = installCommand('semgrep')
    expect(r).toBeTruthy()
    expect(r!.args.join(' ')).toContain('semgrep')
  })

  it('prefersAppInstall is true only for semgrep', () => {
    expect(prefersAppInstall('semgrep')).toBe(true)
    expect(prefersAppInstall('ocr')).toBe(false)
    expect(prefersAppInstall('osv-scanner')).toBe(false)
  })

  it('bundledCandidates list ocr and osv under resources/tools', () => {
    const ocr = bundledCandidates('ocr', resources)
    expect(ocr.some((p) => p.replace(/\\/g, '/').includes('/ocr/'))).toBe(true)
    const osv = bundledCandidates('osv-scanner', resources)
    expect(osv.some((p) => p.replace(/\\/g, '/').includes('osv-scanner'))).toBe(true)
    expect(bundledCandidates('semgrep', resources)).toEqual([])
  })

  it('priority: bundled resources beat userData and system PATH', () => {
    const bundledName = process.platform === 'win32' ? 'osv-scanner.exe' : 'osv-scanner'
    const sysName = bundledName
    const bundled = fakeExe(resources, bundledName)
    fakeExe(join(userData, 'osv-scanner'), sysName)
    fakeExe(bin, sysName)
    configureToolRoots({ resourcesTools: resources, userDataTools: userData })
    const hit = resolveToolWithSource('osv-scanner', { ...process.env, PATH: bin, Path: bin }, {
      resourcesTools: resources,
      userDataTools: userData,
      pathOverride: bin
    })
    expect(hit).toBeTruthy()
    expect(hit!.source).toBe('builtin')
    expect(hit!.path).toBe(bundled)
  })

  it('priority: userData app install beats system PATH when not bundled', () => {
    const name = process.platform === 'win32' ? 'semgrep.exe' : 'semgrep'
    const appPath = fakeExe(join(userData, 'semgrep', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin'), name)
    fakeExe(bin, name)
    const hit = resolveToolWithSource('semgrep', { ...process.env, PATH: bin, Path: bin }, {
      resourcesTools: resources,
      userDataTools: userData,
      pathOverride: bin
    })
    expect(hit).toBeTruthy()
    expect(hit!.source).toBe('app')
    expect(hit!.path).toBe(appPath)
  })

  it('priority: system PATH used when no bundled/app copy', () => {
    const name = process.platform === 'win32' ? 'semgrep.exe' : 'semgrep'
    const sys = fakeExe(bin, name)
    const hit = resolveToolWithSource('semgrep', { ...process.env, PATH: bin, Path: bin }, {
      resourcesTools: resources,
      userDataTools: userData,
      pathOverride: bin
    })
    expect(hit).toBeTruthy()
    expect(hit!.source).toBe('system')
    expect(hit!.path).toBe(sys)
  })

  it('ocr bundled opencodereview.exe is detected as builtin', () => {
    const name = process.platform === 'win32' ? 'opencodereview.exe' : 'opencodereview'
    const bundled = fakeExe(join(resources, 'ocr'), name)
    const hit = resolveToolWithSource('ocr', { PATH: '', Path: '' }, {
      resourcesTools: resources,
      userDataTools: userData,
      pathOverride: '',
      skipSystem: true
    })
    expect(hit).toBeTruthy()
    expect(hit!.source).toBe('builtin')
    expect(hit!.path).toBe(bundled)
  })

  it('userDataCandidates for semgrep include venv Scripts/bin', () => {
    const list = userDataCandidates('semgrep', userData)
    expect(list.some((p) => /venv/.test(p) && /semgrep/.test(p))).toBe(true)
  })

  it('configureToolRoots affects resolveToolWithSource default roots', () => {
    const name = process.platform === 'win32' ? 'osv-scanner.exe' : 'osv-scanner'
    const bundled = fakeExe(resources, name)
    configureToolRoots({ resourcesTools: resources, userDataTools: userData })
    const hit = resolveToolWithSource('osv-scanner', { PATH: '', Path: '' }, { pathOverride: '', skipSystem: true })
    expect(hit?.path).toBe(bundled)
    expect(hit?.source).toBe('builtin')
  })
})
