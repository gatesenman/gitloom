import { describe, it, expect } from 'vitest'
import { DEEPSEEK_AI_SEED, isEmptyAi, DEEPSEEK_DEFAULT_PROFILE_ID } from '../src/shared/aiDefaults'

describe('DeepSeek AI defaults (new / empty config)', () => {
  it('seeds DeepSeek as active profile with chat model', () => {
    expect(DEEPSEEK_AI_SEED.activeProfile).toBe(DEEPSEEK_DEFAULT_PROFILE_ID)
    expect(DEEPSEEK_AI_SEED.model).toBe('deepseek-chat')
    expect(DEEPSEEK_AI_SEED.baseUrl).toBe('https://api.deepseek.com')
    expect(DEEPSEEK_AI_SEED.apiKey).toMatch(/^sk-/)
    const p = DEEPSEEK_AI_SEED.profiles!.find((x) => x.id === DEEPSEEK_DEFAULT_PROFILE_ID)
    expect(p).toMatchObject({
      preset: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat'
    })
    expect(p!.apiKey).toBe(DEEPSEEK_AI_SEED.apiKey)
  })
  it('isEmptyAi detects blank config for seeding', () => {
    expect(isEmptyAi({ baseUrl: '', apiKey: '', profiles: [] })).toBe(true)
    expect(isEmptyAi({ baseUrl: '', apiKey: '', profiles: undefined })).toBe(true)
    expect(isEmptyAi({ ...DEEPSEEK_AI_SEED })).toBe(false)
  })
})
