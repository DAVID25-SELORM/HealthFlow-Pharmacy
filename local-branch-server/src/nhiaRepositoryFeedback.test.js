import assert from 'node:assert/strict'
import test from 'node:test'
import { getNhiaMemberLookupFailureMessage } from './nhiaFeedback.js'

test('inactive NHIA member feedback explains the result and next action', () => {
  assert.equal(
    getNhiaMemberLookupFailureMessage({ status: 'INACTIVE', ccCode: null }),
    'Member details were found, but the NHIS membership is currently inactive. A CC code cannot be generated. Please ask the member to contact NHIA or renew their membership.'
  )
})

test('other NHIA lookup statuses retain the generic feedback', () => {
  assert.equal(
    getNhiaMemberLookupFailureMessage({ status: 'NOT FOUND', ccCode: null }),
    'NHIA member lookup did not return a CC code: NOT FOUND.'
  )
})
