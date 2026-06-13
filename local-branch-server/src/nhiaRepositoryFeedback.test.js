import { expect, it } from 'vitest'
import { getNhiaMemberLookupFailureMessage } from './nhiaFeedback.js'

it('explains the inactive NHIA member result and next action', () => {
  expect(
    getNhiaMemberLookupFailureMessage({ status: 'INACTIVE', ccCode: null }),
  ).toBe(
    'Member details were found, but the NHIS membership is currently inactive. A CC code cannot be generated. Please ask the member to contact NHIA or renew their membership.'
  )
})

it('retains generic feedback for other NHIA lookup statuses', () => {
  expect(
    getNhiaMemberLookupFailureMessage({ status: 'NOT FOUND', ccCode: null }),
  ).toBe('NHIA member lookup did not return a CC code: NOT FOUND.')
})
