import { describe, expect, it } from 'vitest'
import {
  GHANA_CARD_COUNTRY_PREFIXES,
  isGhanaCardNumber,
  normalizeNhiaMemberNumber,
  validateNhiaMemberNumberFormat,
} from './nhiaMemberNumber'
import { GHANA_CARD_COUNTRY_PREFIXES as LOCAL_SERVER_PREFIXES } from '../../local-branch-server/src/nhiaMemberNumber.js'

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

  it('formats a foreign national Ghana Card the same way, keeping the country code', () => {
    expect(normalizeNhiaMemberNumber('ken')).toBe('KEN-')
    expect(normalizeNhiaMemberNumber('KEN 7292382520')).toBe('KEN-729238252-0')
    expect(normalizeNhiaMemberNumber('SWZ-7297126385')).toBe('SWZ-729712638-5')
    expect(normalizeNhiaMemberNumber('swz7297126385')).toBe('SWZ-729712638-5')
  })

  it('does not treat other letters as a card prefix', () => {
    expect(normalizeNhiaMemberNumber('KXN7292382520')).toBe('KXN7292382520')
    expect(normalizeNhiaMemberNumber('nhis12345678')).toBe('NHIS12345678')
  })
})

describe('isGhanaCardNumber', () => {
  it('recognises GHA and foreign national country codes', () => {
    expect(isGhanaCardNumber('GHA-123456789-0')).toBe(true)
    expect(isGhanaCardNumber('SWZ-7297126385')).toBe(true)
    expect(isGhanaCardNumber('KEN 7292382520')).toBe(true)
    expect(isGhanaCardNumber('NGA-123456789-0')).toBe(true)
  })

  it('does not match NHIS numbers, typos or empty values', () => {
    expect(isGhanaCardNumber('12345678')).toBe(false)
    expect(isGhanaCardNumber('GAH-123456789-0')).toBe(false)
    expect(isGhanaCardNumber('NHIS12345678')).toBe(false)
    expect(isGhanaCardNumber('')).toBe(false)
    expect(isGhanaCardNumber(null)).toBe(false)
  })
})

describe('validateNhiaMemberNumberFormat', () => {
  it('accepts the foreign national Ghana Cards reported from the NHIS claims screen', () => {
    expect(validateNhiaMemberNumberFormat('SWZ-7297126385')).toBe('')
    expect(validateNhiaMemberNumberFormat('KEN 7292382520')).toBe('')
    expect(validateNhiaMemberNumberFormat('KEN-729238252-0')).toBe('')
  })

  it('still accepts GHA cards and 8-digit NHIS numbers', () => {
    expect(validateNhiaMemberNumberFormat('GHA-123456789-0')).toBe('')
    expect(validateNhiaMemberNumberFormat('12345678')).toBe('')
  })

  it('names the actual prefix when the digit count is wrong', () => {
    expect(validateNhiaMemberNumberFormat('KEN-72923825')).toBe(
      'Ghana Card number must contain exactly 10 digits after KEN.'
    )
    expect(validateNhiaMemberNumberFormat('GHA-12345')).toBe(
      'Ghana Card number must contain exactly 10 digits after GHA.'
    )
  })

  it('rejects letters after the prefix and unknown prefixes', () => {
    expect(validateNhiaMemberNumberFormat('KEN-72923825AB')).toBe(
      'Ghana Card number must start with KEN and contain only digits after the prefix.'
    )
    expect(validateNhiaMemberNumberFormat('KXN-7292382520')).toMatch(/must contain digits only/)
    expect(validateNhiaMemberNumberFormat('1234567')).toBe('NHIS member number must contain exactly 8 digits.')
  })
})

describe('country code list', () => {
  it('is the complete ISO 3166-1 alpha-3 list (249 codes)', () => {
    expect(GHANA_CARD_COUNTRY_PREFIXES.size).toBe(249)
    for (const code of ['GHA', 'KEN', 'SWZ', 'NGA', 'TGO', 'BFA', 'CIV', 'GBR', 'USA', 'ZWE']) {
      expect(GHANA_CARD_COUNTRY_PREFIXES.has(code)).toBe(true)
    }
    for (const code of GHANA_CARD_COUNTRY_PREFIXES) expect(code).toMatch(/^[A-Z]{3}$/)
  })

  it('matches the list used by the local branch server', () => {
    expect([...LOCAL_SERVER_PREFIXES].sort()).toEqual([...GHANA_CARD_COUNTRY_PREFIXES].sort())
  })
})
