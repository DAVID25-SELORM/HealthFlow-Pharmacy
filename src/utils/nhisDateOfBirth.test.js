import { describe, expect, it } from 'vitest'
import {
  formatNhisDateOfBirthInput,
  normalizeNhisDateOfBirth,
} from './nhisDateOfBirth'

describe('NHIS date of birth input', () => {
  it('does not convert partial typing into 1 January 2001', () => {
    expect(normalizeNhisDateOfBirth('1')).toBe('')
    expect(formatNhisDateOfBirthInput('1')).toBe('1')
    expect(formatNhisDateOfBirthInput('01/')).toBe('01/')
  })

  it('accepts complete day/month/year and ISO dates', () => {
    expect(normalizeNhisDateOfBirth('15/08/1992')).toBe('1992-08-15')
    expect(normalizeNhisDateOfBirth('1992-08-15')).toBe('1992-08-15')
    expect(normalizeNhisDateOfBirth('1992-08-15T00:00:00Z')).toBe('1992-08-15')
    expect(formatNhisDateOfBirthInput('1992-08-15')).toBe('15/08/1992')
  })

  it('rejects invalid and ambiguous dates', () => {
    expect(normalizeNhisDateOfBirth('31/02/2001')).toBe('')
    expect(normalizeNhisDateOfBirth('August 15, 1992')).toBe('')
  })
})
