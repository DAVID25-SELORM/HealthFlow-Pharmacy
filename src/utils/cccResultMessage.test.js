// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { cccResultMessage, cccProviderName } from './cccResultMessage'

describe('CCC outcome messages', () => {
 it('distinguishes cached legacy attendance from a new provider request', () => {
  expect(cccResultMessage({source:'api',reused:true})).toBe('Saved CCC reused from an earlier confirmed attendance (Existing NHIA API). No new request was sent to NHIA.')
 })
 it('identifies a live NeHFAMS response which reuses the same CCC', () => {
  expect(cccResultMessage({source:'nehfams',memberDetails:{newCcc:false}})).toBe('NHIA NeHFAMS confirmed the existing CCC for this attendance.')
 })
 it.each(['nehfams','api','otac','claimit_bridge'])('identifies a new response from %s', source => {
  expect(cccResultMessage({source,memberDetails:{newCcc:true}})).toBe(`CCC received from ${cccProviderName(source)}.`)
 })
 it('does not infer a provider for an old record with no source', () => {
  expect(cccResultMessage({reused:true})).toContain('(NHIA). No new request')
 })
})
