import { describe, it, expect } from 'vitest'
import {
  scanDesignDebtInText, designMdFindings, looksLikeFrontend, extractCssVarUses, KNOWN_TOKEN_COLORS
} from '../src/main/health/designDebt'

describe('designDebt scan', () => {
  it('flags hardcoded hex and known token drift', () => {
    const text = `.btn { color: #7b74ff; background: #112233; }\n`
    const findings = scanDesignDebtInText('src/styles.css', text)
    expect(findings.some((f) => /硬编码|令牌|颜色/.test(f.title + (f.detail || '')))).toBe(true)
    expect(findings.every((f) => f.category === 'design')).toBe(true)
    expect(KNOWN_TOKEN_COLORS['#7b74ff']).toBeTruthy()
  })

  it('flags inline style in tsx', () => {
    const findings = scanDesignDebtInText('src/ui/Button.tsx', `export const B = () => <div style={{ color: 'red', padding: '24px' }}>x</div>`)
    expect(findings.length).toBeGreaterThan(0)
  })

  it('DESIGN.md missing / incomplete', () => {
    const missing = designMdFindings({ exists: false, content: '', repo: '/r' })
    expect(missing.some((f) => /DESIGN\.md/.test(f.title))).toBe(true)
    const thin = designMdFindings({ exists: true, content: '# Design\nhello\n', repo: '/r', usedTokens: ['--accent'] })
    expect(thin.some((f) => /令牌|间距|DESIGN/.test(f.title + (f.detail || '')))).toBe(true)
  })

  it('looksLikeFrontend + extractCssVarUses', () => {
    expect(looksLikeFrontend(['src/a.ts', 'src/Button.tsx'])).toBe(true)
    expect(looksLikeFrontend(['README.md'])).toBe(false)
    expect(extractCssVarUses('color: var(--accent); gap: var(--space-2)')).toEqual(
      expect.arrayContaining(['--accent', '--space-2'])
    )
  })
})
