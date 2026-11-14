import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NHIS_CCC_REQUIRED_TO_SAVE_INTENTS,
  NHIS_CCC_REQUIRED_TO_SAVE_MESSAGE,
  getNhisCccSaveIssue,
} from './nhisCccSaveRule'

describe('getNhisCccSaveIssue (NHIS-005)', () => {
  it.each(['save_details', 'dispatch'])('blocks %s when the CC code is empty', (intent) => {
    expect(getNhisCccSaveIssue({ cccNo: '' }, { intent })).toBe(NHIS_CCC_REQUIRED_TO_SAVE_MESSAGE)
    expect(getNhisCccSaveIssue({}, { intent })).toBe(NHIS_CCC_REQUIRED_TO_SAVE_MESSAGE)
    expect(getNhisCccSaveIssue({ cccNo: '   ' }, { intent })).toBe(NHIS_CCC_REQUIRED_TO_SAVE_MESSAGE)
    expect(getNhisCccSaveIssue({ cccNo: null }, { intent })).toBe(NHIS_CCC_REQUIRED_TO_SAVE_MESSAGE)
  })

  it.each(['save_details', 'dispatch'])('allows %s with a valid 5-digit code, however it was entered', (intent) => {
    expect(getNhisCccSaveIssue({ cccNo: '12345' }, { intent })).toBe('')
    expect(getNhisCccSaveIssue({ ccc_no: '01234' }, { intent })).toBe('')
    expect(getNhisCccSaveIssue({ ccCode: '54321' }, { intent })).toBe('')
    expect(getNhisCccSaveIssue({ cc_code: '99999' }, { intent })).toBe('')
  })

  it('still rejects a code that is not exactly 5 digits', () => {
    expect(getNhisCccSaveIssue({ cccNo: '1234' }, { intent: 'save_details' })).toBe('CCC/CC code must contain exactly 5 digits.')
    expect(getNhisCccSaveIssue({ cccNo: '123456' }, { intent: 'dispatch' })).toBe('CCC/CC code must contain exactly 5 digits.')
  })

  it('names manual entry in the message so staff know what to do when generation is down', () => {
    expect(NHIS_CCC_REQUIRED_TO_SAVE_MESSAGE).toMatch(/type the 5-digit code/)
  })

  it('does not apply to other actions', () => {
    expect(NHIS_CCC_REQUIRED_TO_SAVE_INTENTS).toEqual(['save_details', 'dispatch'])
    expect(getNhisCccSaveIssue({ cccNo: '' }, { intent: 'serve_directly' })).toBe('')
    expect(getNhisCccSaveIssue({ cccNo: '' }, { intent: '' })).toBe('')
    expect(getNhisCccSaveIssue({ cccNo: '' })).toBe('')
  })

  it('does not block a user whose CC code field is locked, who cannot supply it', () => {
    expect(getNhisCccSaveIssue({ cccNo: '' }, { intent: 'save_details', fieldLocked: true })).toBe('')
    expect(getNhisCccSaveIssue({ cccNo: '' }, { intent: 'dispatch', fieldLocked: true })).toBe('')
  })
})

describe('claim form wiring (source check)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/pages/Nhis.jsx'), 'utf8')

  it('runs the rule inside handleSubmitClaim before the confirmation step', () => {
    const importIndex = source.indexOf("from '../utils/nhisCccSaveRule'")
    const callIndex = source.indexOf('getNhisCccSaveIssue(claimForm, { intent, fieldLocked: cccFieldLocked })')
    const reviewIndex = source.indexOf('setClaimActionReview({ intent, duplicateWarnings })')

    expect(importIndex).toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    expect(reviewIndex).toBeGreaterThan(callIndex)
  })

  it('locks the rule out only for a manual-control field the role cannot edit', () => {
    expect(source).toContain("const cccFieldLocked = claimControlMode === 'manual' && !canManuallyEditCcCode")
  })

  it('marks the CC code field as required in every control mode', () => {
    expect(source).toContain('<label>CCC / CC Code *</label>')
  })
})
