#!/usr/bin/env node
/**
 * Download redistributable tools into build/bundled-tools for electron-builder extraResources.
 * - osv-scanner: official Windows amd64 release from google/osv-scanner
 * - ocr: @alibaba-group/ocr-win32-x64 native binary + ocr.cmd wrapper (Apache-2.0)
 *
 * Usage: node scripts/fetch-bundled-tools.mjs [--force]
 */
import { createWriteStream, existsSync, mkdirSync, writeFileSync, chmodSync, rmSync, renameSync, copyFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pipeline } from 'stream/promises'
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import https from 'https'
import http from 'http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outDir = join(root, 'build', 'bundled-tools')
const force = process.argv.includes('--force')

const OSV_VERSION = process.env.OSV_SCANNER_VERSION || 'v2.7.0'
const OSV_URL = `https://github.com/google/osv-scanner/releases/download/${OSV_VERSION}/osv-scanner_windows_amd64.exe`
const OCR_PKG = '@alibaba-group/ocr-win32-x64'
const OCR_VERSION = process.env.OCR_VERSION || '1.13.3'

function get(url, redirects = 8) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    lib.get(url, { headers: { 'User-Agent': 'GitLoom-bundler' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirects <= 0) return reject(new Error('too many redirects'))
        return get(res.headers.location, redirects - 1).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      resolve(res)
    }).on('error', reject)
  })
}

async function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = dest + '.part'
  const res = await get(url)
  await pipeline(res, createWriteStream(tmp))
  renameSync(tmp, dest)
}

function sha256File(p) {
  const h = createHash('sha256')
  h.update(readFileSync(p))
  return h.digest('hex')
}

async function fetchOsv() {
  const dest = join(outDir, 'osv-scanner.exe')
  if (existsSync(dest) && !force) {
    console.log(`[skip] osv-scanner.exe exists (${(readFileSync(dest).length / 1e6).toFixed(1)} MB)`)
    return dest
  }
  console.log(`[fetch] ${OSV_URL}`)
  await download(OSV_URL, dest)
  console.log(`[ok] osv-scanner.exe ${sha256File(dest)} (${(readFileSync(dest).length / 1e6).toFixed(1)} MB)`)
  return dest
}

async function fetchOcr() {
  const ocrDir = join(outDir, 'ocr')
  const exe = join(ocrDir, 'opencodereview.exe')
  const cmd = join(ocrDir, 'ocr.cmd')
  if (existsSync(exe) && existsSync(cmd) && !force) {
    console.log(`[skip] ocr/opencodereview.exe exists (${(readFileSync(exe).length / 1e6).toFixed(1)} MB)`)
    return ocrDir
  }
  mkdirSync(ocrDir, { recursive: true })
  const staging = join(outDir, '.ocr-staging')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  console.log(`[npm pack] ${OCR_PKG}@${OCR_VERSION}`)
  execSync(`npm pack ${OCR_PKG}@${OCR_VERSION} --pack-destination "${staging}"`, { stdio: 'inherit', cwd: staging })
  const tgz = join(staging, `alibaba-group-ocr-win32-x64-${OCR_VERSION}.tgz`)
  if (!existsSync(tgz)) throw new Error('npm pack did not produce expected tarball')
  execSync(`tar xzf "${tgz}" -C "${staging}"`, { stdio: 'inherit' })
  const packedExe = join(staging, 'package', 'bin', 'opencodereview.exe')
  if (!existsSync(packedExe)) throw new Error('opencodereview.exe missing in package')
  copyFileSync(packedExe, exe)
  writeFileSync(cmd, `@echo off\r\n"%~dp0opencodereview.exe" %*\r\n`)
  // Attribution
  writeFileSync(join(ocrDir, 'NOTICE.txt'), [
    'OpenCodeReview (ocr) — Apache License 2.0',
    `Package: ${OCR_PKG}@${OCR_VERSION}`,
    'https://www.npmjs.com/package/@alibaba-group/open-code-review',
    'https://github.com/alibaba/open-code-review',
    ''
  ].join('\n'))
  rmSync(staging, { recursive: true, force: true })
  console.log(`[ok] ocr/opencodereview.exe ${sha256File(exe)} (${(readFileSync(exe).length / 1e6).toFixed(1)} MB)`)
  return ocrDir
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'README.txt'), [
    'Bundled external check tools for GitLoom (fetched at build time).',
    `- osv-scanner.exe — Google OSV Scanner ${OSV_VERSION} (Windows amd64)`,
    `  https://github.com/google/osv-scanner`,
    `- ocr/ — OpenCodeReview native Windows binary ${OCR_VERSION} (Apache-2.0)`,
    `  @alibaba-group/ocr-win32-x64 / open-code-review`,
    'Semgrep is NOT bundled (app-managed install into userData on demand).',
    ''
  ].join('\n'))
  await fetchOsv()
  await fetchOcr()
  console.log(`[done] ${outDir}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
