import { describe, expect, it } from 'vitest'
import { formatLocalDate, getFirstDayOfLocalMonth } from './date'

describe('date utilities', () => {
  it('formats a local date as YYYY-MM-DD', () => {
    expect(formatLocalDate(new Date(2026, 3, 16, 14, 30, 0))).toBe('2026-04-16')
  })

  it('returns the first day of the local month', () => {
    expect(getFirstDayOfLocalMonth(new Date(2026, 3, 16, 14, 30, 0))).toBe('2026-04-01')
  })
})
