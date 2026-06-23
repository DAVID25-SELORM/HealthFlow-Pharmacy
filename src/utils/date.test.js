import { describe, expect, it } from 'vitest'
import { formatAppDateKey, formatLocalDate, getFirstDayOfLocalMonth } from './date'

describe('date utilities', () => {
  it('formats a local date as YYYY-MM-DD', () => {
    expect(formatLocalDate(new Date(2026, 3, 16, 14, 30, 0))).toBe('2026-04-16')
  })

  it('returns the first day of the local month', () => {
    expect(getFirstDayOfLocalMonth(new Date(2026, 3, 16, 14, 30, 0))).toBe('2026-04-01')
  })

  it('formats app date keys in the configured app calendar day', () => {
    expect(formatAppDateKey('2026-06-23T01:30:00.000Z')).toBe('2026-06-23')
  })

  it('preserves existing date-only values', () => {
    expect(formatAppDateKey('2026-06-23')).toBe('2026-06-23')
  })
})
