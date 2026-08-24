import { describe, expect, it } from 'vitest'
import { normalizeNhiaMemberNumber } from './nhiaMemberNumber'

describe('normalizeNhiaMemberNumber', () => {
  it('inserts Ghana Card hyphens as the card is typed', () => {
    expect(normalizeNhiaMemberNumber('g')).toBe('G')
    expect(normalizeNhiaMemberNumber('gh')).toBe('GH')
    expect(normalizeNhiaMemberNumber('gha')).toBe('GHA-')
    expect(normalizeNhiaMemberNumber('gha1234')).toBe('GHA-1234')
    expect(normalizeNhiaMemberNumber('gha123456789')).toBe('GHA-123456789')
    expect(normalizeNhiaMemberNumber('gha1234567890')).toBe('GHA-123456789-0')
  })

  it('keeps existing NHIS numeric member numbers unchanged', () => {
    expect(normalizeNhiaMemberNumber('12345678')).toBe('12345678')
  })
})
