import { describe, expect, it } from 'vitest'
import { getClaimMonthRange } from './claimMonthRange'

describe('claims selected month boundaries', () => {
  it.each([
    [2026, 1, '2026-01-01', '2026-01-31'],
    [2026, 2, '2026-02-01', '2026-02-28'],
    [2024, 2, '2024-02-01', '2024-02-29'],
    [2026, 4, '2026-04-01', '2026-04-30'],
    [2026, 12, '2026-12-01', '2026-12-31'],
  ])('covers the whole month for %s-%s', (year, month, from, to) => {
    expect(getClaimMonthRange(year, month)).toEqual({ from, to })
  })
})
