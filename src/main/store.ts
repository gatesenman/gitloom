// Persistent JSON store for settings + workspace. Secrets encrypted with Electron safeStorage when available.
import { app, safeStorage } from 'electron'
import { promises as fsp, readFileSync, existsSync, mkdirSync } from 'fs'
import * as path from 'path'
import type { AppSettings, WorkspaceState, AIProfile } from '../shared/types'
import { migrateAI, syncLegacy } from './aiClient'
import { DEEPSEEK_AI_SEED, isEmptyAi } from '../shared/aiDefaults'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  ai: {
    ...DEEPSEEK_AI_SEED,
    temperature: 0.2,
    language: 'zh',
    commitStyle: 'conventional',
    profiles: DEEPSEEK_AI_SEED.profiles!.map((p) => ({ ...p })),
    tasks: {},
    fallback: []
  },
  diffMode: 'split',
  graphLimit: 800,
  autoFetchMinutes: 0,
  gitPath: 'git',
  scanDepth: 6,
  scanIgnore: ['node_modules', '.venv', 'venv', 'dist', 'target', 'build', 'out', 'vendor', '.cache', '__pycache__', '.next', '.nuxt', '.gradle', '.idea', 'Pods', '.terraform', 'coverage', 'bower_components'],
  density: 'comfortable',
  concurrency: 6,
  watch: true,
  aiEnvForHooks: true,
  fontSize: 13,
  forge: { githubToken: '', gitlabToken: '', gitlabBaseUrl: 'https://gitlab.com' },
  aiChatPersist: true
}

type Enc = { apiKeyEnc?: string; githubTokenEnc?: string; gitlabTokenEnc?: string }
interface StoreShape {
  settings: AppSettings & { ai: AppSettings['ai'] & { apiKeyEnc?: string }; forge?: AppSettings['forge'] & { githubTokenEnc?: string; gitlabTokenEnc?: string } }
  workspace: WorkspaceState
}

function dec(b64?: string): string {
  if (!b64 || !safeStorage.isEncryptionAvailable()) return ''
  try { return safeStorage.decryptString(Buffer.from(b64, 'base64')) } catch { return '' }
}
function enc(plain: string): string {
  return safeStorage.encryptString(plain).toString('base64')
}

export class Store {
  file: string
  data: StoreShape
  constructor(dir = process.env.GITLOOM_DATA_DIR || app.getPath('userData')) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'gitloom.json')
    let d: Partial<StoreShape> = {}
    try { d = JSON.parse(readFileSync(this.file, 'utf8')) } catch { /* first run */ }
    this.data = {
      settings: {
        ...DEFAULT_SETTINGS, ...(d.settings ?? {}),
        ai: { ...DEFAULT_SETTINGS.ai, ...(d.settings?.ai ?? {}) },
        forge: { ...DEFAULT_SETTINGS.forge!, ...(d.settings?.forge ?? {}) }
      },
      workspace: { repos: [], active: null, ...(d.workspace ?? {}) }
    }
    const aiEnc = this.data.settings.ai.apiKeyEnc
    if (aiEnc) this.data.settings.ai.apiKey = dec(aiEnc) || this.data.settings.ai.apiKey
    const f = this.data.settings.forge!
    if (f.githubTokenEnc) f.githubToken = dec(f.githubTokenEnc) || f.githubToken
    if (f.gitlabTokenEnc) f.gitlabToken = dec(f.gitlabTokenEnc) || f.gitlabToken
    for (const p of (this.data.settings.ai.profiles ?? []) as (AIProfile & { apiKeyEnc?: string })[]) {
      if (p.apiKeyEnc) p.apiKey = dec(p.apiKeyEnc) || p.apiKey || ''
      delete p.apiKeyEnc
    }
    // 0.4.2: single OpenAI-compatible endpoint → provider profiles
    const { apiKeyEnc: keep, ...ai } = this.data.settings.ai
    let next = syncLegacy(migrateAI(ai))
    // Empty / first-run: bake DeepSeek defaults (overridable in 设置)
    if (isEmptyAi(next)) {
      next = { ...next, ...DEFAULT_SETTINGS.ai, profiles: DEFAULT_SETTINGS.ai.profiles!.map((p) => ({ ...p })), activeProfile: DEFAULT_SETTINGS.ai.activeProfile }
    }
    this.data.settings.ai = { ...next, ...(keep ? { apiKeyEnc: keep } : {}) }
  }

  get settings(): AppSettings {
    const { apiKeyEnc: _e, ...ai } = this.data.settings.ai
    const forge = this.data.settings.forge ?? DEFAULT_SETTINGS.forge!
    const { githubTokenEnc: _g, gitlabTokenEnc: _l, ...forgeClean } = forge as typeof forge & Enc
    return { ...this.data.settings, ai, forge: forgeClean }
  }
  get workspace(): WorkspaceState { return this.data.workspace }

  async setSettings(s: AppSettings): Promise<void> {
    this.data.settings = { ...s, ai: syncLegacy({ ...s.ai }), forge: { ...(s.forge ?? DEFAULT_SETTINGS.forge!) } }
    await this.save()
  }
  async setWorkspace(w: WorkspaceState): Promise<void> { this.data.workspace = w; await this.save() }

  private async save(): Promise<void> {
    const copy: StoreShape = JSON.parse(JSON.stringify(this.data))
    if (safeStorage.isEncryptionAvailable()) {
      if (copy.settings.ai.apiKey) {
        copy.settings.ai.apiKeyEnc = enc(copy.settings.ai.apiKey)
        copy.settings.ai.apiKey = ''
      } else delete copy.settings.ai.apiKeyEnc
      for (const p of (copy.settings.ai.profiles ?? []) as (AIProfile & { apiKeyEnc?: string })[]) {
        if (p.apiKey) { p.apiKeyEnc = enc(p.apiKey); p.apiKey = '' } else delete p.apiKeyEnc
      }
      const f = copy.settings.forge!
      if (f.githubToken) { f.githubTokenEnc = enc(f.githubToken); f.githubToken = '' } else delete f.githubTokenEnc
      if (f.gitlabToken) { f.gitlabTokenEnc = enc(f.gitlabToken); f.gitlabToken = '' } else delete f.gitlabTokenEnc
    }
    await fsp.writeFile(this.file, JSON.stringify(copy, null, 2), { mode: 0o600 })
  }
}
