import { expect, it } from 'vitest'
import { assertNhisCccForSavedState, assertNhisCccForProgress } from './nhisCccValidation.js'
it('allows incomplete drafts and attachments without advancing their status', () => {
  const draft = { status: 'draft', ccc_no: '', prescription_file_path: 'fixture.pdf' }
  expect(() => assertNhisCccForSavedState(draft)).not.toThrow()
  expect(draft.status).toBe('draft')
})
it.each(['served','claim_ready','submitted','fully_served','partially_served','approved','accepted','paid'])('blocks missing CCC in %s even with attachment', status => {
  expect(() => assertNhisCccForSavedState({ status, ccc_no: '', prescription_file_path: 'fixture.pdf' })).toThrow('CCC/CC code')
})
it('cannot hide served medicines in a draft', () => {
  expect(() => assertNhisCccForSavedState({ status: 'draft', nhis_claim_medicines: [{served_qty: 1}] })).toThrow('CCC/CC code')
})
it('requires CCC for explicit serving and allows normalized existing codes', () => {
  expect(() => assertNhisCccForProgress({})).toThrow('CCC/CC code')
  expect(() => assertNhisCccForProgress({ccc_no:'1234'})).toThrow('5 digits')
  expect(() => assertNhisCccForProgress({ccc_no:'CC-12345'})).not.toThrow()
})
