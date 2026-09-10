import { describe, expect, it } from 'vitest'
import { hashBaselineSource } from './production-baseline-hash.mjs'

describe('production baseline fingerprint', () => {
  it('accepts the same source checked out on Windows and Linux', () => {
    expect(hashBaselineSource(Buffer.from('first\r\nsecond\r\n')))
      .toBe(hashBaselineSource('first\nsecond\n'))
  })
  it('still detects code and whitespace changes', () => {
    const original = hashBaselineSource('const allowed = false\n')
    expect(hashBaselineSource('const allowed = true\n')).not.toBe(original)
    expect(hashBaselineSource('const allowed = false \n')).not.toBe(original)
  })
})
