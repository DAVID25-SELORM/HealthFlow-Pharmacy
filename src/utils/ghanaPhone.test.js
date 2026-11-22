import { describe, expect, it } from 'vitest'
import { isLikelyGhanaPhone, normalizePhoneInput } from './ghanaPhone'

describe('normalizePhoneInput', () => {
  it('removes spaces, dashes and brackets', () => {
    expect(normalizePhoneInput(' 024 765-4381 ')).toBe('0247654381')
    expect(normalizePhoneInput('(024) 765 4381')).toBe('0247654381')
  })

  it('keeps a leading plus', () => {
    expect(normalizePhoneInput('+233 24 765 4381')).toBe('+233247654381')
  })

  it('returns an empty string for blank or missing values', () => {
    expect(normalizePhoneInput('')).toBe('')
    expect(normalizePhoneInput(null)).toBe('')
    expect(normalizePhoneInput(undefined)).toBe('')
  })
})

describe('isLikelyGhanaPhone', () => {
  it('accepts local and international Ghana numbers', () => {
    expect(isLikelyGhanaPhone('0247654381')).toBe(true)
    expect(isLikelyGhanaPhone('024 765 4381')).toBe(true)
    expect(isLikelyGhanaPhone('233247654381')).toBe(true)
    expect(isLikelyGhanaPhone('+233247654381')).toBe(true)
  })

  it('rejects numbers that are too short, too long or not numbers', () => {
    expect(isLikelyGhanaPhone('024765')).toBe(false)
    expect(isLikelyGhanaPhone('02476543812')).toBe(false)
    expect(isLikelyGhanaPhone('abc')).toBe(false)
    expect(isLikelyGhanaPhone('')).toBe(false)
  })
})
