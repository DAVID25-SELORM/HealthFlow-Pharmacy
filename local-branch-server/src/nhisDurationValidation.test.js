import { describe, expect, it } from 'vitest'
import { assertNhisDurationForSavedState, isValidNhisDuration } from './nhisDurationValidation.js'
describe('duration save enforcement shared by browser and offline server', () => {
  it.each([null, '', '   ', '60', '2W', '2 week'])('rejects invalid duration %s outside Draft', duration => {
    for (const status of ['served', 'pending_dispensary', 'claim_ready', 'submitted']) {
      expect(() => assertNhisDurationForSavedState({ status, medicines: [{ duration }] })).toThrow('valid duration')
    }
    expect(() => assertNhisDurationForSavedState({ status: 'draft', medicines: [{ duration }] })).not.toThrow()
    expect(() => assertNhisDurationForSavedState({ status: 'draft', medicines: [{ duration, served_qty: 1 }] })).toThrow()
  })
  it('preserves structured clinical values through serialization and unrelated edits', () => {
    const original = { status: 'served', nhis_claim_medicines: [{ duration: '2 weeks', dose: '1' }] }
    const reloaded = JSON.parse(JSON.stringify(original))
    reloaded.nhis_claim_medicines[0].dose = '2'
    assertNhisDurationForSavedState(reloaded)
    expect(reloaded.nhis_claim_medicines[0].duration).toBe('2 weeks')
    expect(isValidNhisDuration('2 weeks')).toBe(true)
    reloaded.nhis_claim_medicines[0].duration = ''
    expect(() => assertNhisDurationForSavedState(reloaded)).toThrow()
  })
})
