import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('claim form date defaults', () => {
  it('keeps NHIS blank claim and medicine defaults fresh per form reset', () => {
    const source = readSource('./Nhis.jsx')

    expect(source).toMatch(/const makeBlankClaim = \(\) => \(\{[\s\S]*serviceDate:\s+getNhisCalendarDate\(\)/)
    expect(source).toMatch(/const makeBlankMedicine = \(\) => \(\{[\s\S]*dispensaryDate:\s+getNhisCalendarDate\(\)/)
    expect(source).not.toMatch(/const BLANK_CLAIM = \{[\s\S]*serviceDate:\s+getNhisCalendarDate\(\)/)
    expect(source).not.toMatch(/const BLANK_MEDICINE = \{[\s\S]*dispensaryDate:\s+getNhisCalendarDate\(\)/)
    expect(source).not.toContain('setClaimForm(BLANK_CLAIM)')
    expect(source).not.toContain('setMedForm(BLANK_MEDICINE)')
  })

  it('keeps ordinary claim default dates out of module-level constants', () => {
    const source = readSource('./Claims.jsx')
    const blankFormBody = source.match(/const blankForm = \{([\s\S]*?)\n\}/)?.[1] || ''

    expect(source).toMatch(/const makeBlankForm = \(\) => \(\{ \.\.\.blankForm, serviceDate: formatAppDateKey\(\) \}\)/)
    expect(blankFormBody).not.toContain('serviceDate')
    expect(source).toContain('useState(makeBlankForm)')
  })
})
