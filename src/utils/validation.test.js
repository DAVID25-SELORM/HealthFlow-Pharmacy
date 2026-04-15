import {
  assertNonNegativeNumber,
  assertRequiredText,
  sanitizeSearchTerm,
  toNumber,
} from './validation'

describe('validation utilities', () => {
  it('parses numbers with fallback', () => {
    expect(toNumber('12.5')).toBe(12.5)
    expect(toNumber('not-a-number', 9)).toBe(9)
  })

  it('validates required text', () => {
    expect(assertRequiredText('  HealthFlow  ', 'Name')).toBe('HealthFlow')
    expect(() => assertRequiredText('   ', 'Name')).toThrow('Name is required.')
  })

  it('validates non-negative numeric values', () => {
    expect(assertNonNegativeNumber('4.2', 'Amount')).toBe(4.2)
    expect(() => assertNonNegativeNumber('-1', 'Amount')).toThrow('Amount must be a non-negative number.')
  })

  it('sanitizes wildcard characters from search terms', () => {
    expect(sanitizeSearchTerm('ibuprofen_%500')).toBe('ibuprofen500')
  })
})
