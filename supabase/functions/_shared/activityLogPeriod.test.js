import { describe, expect, it } from 'vitest'
import { resolveActivityLogPeriod } from './activityLogPeriod.ts'

describe('activity calendar period', () => {
  it.each([
    [2026, 9, '2026-09-01', '2026-09-30'],
    [2024, 2, '2024-02-01', '2024-02-29'],
    [2026, 12, '2026-12-01', '2026-12-31'],
    [2026, '', '2026-01-01', '2026-12-31'],
  ])('resolves year %s month %s on the server', (year, month, fromDate, toDate) => {
    expect(resolveActivityLogPeriod({ period: 'month', year, month, fromDate: '1999-01-01' })).toEqual({ fromDate, toDate })
  })
  it('preserves presets and custom range precedence', () => {
    const now = new Date('2026-01-15T01:00:00Z')
    expect(resolveActivityLogPeriod({ period: 'previous_month' }, now)).toEqual({ fromDate: '2025-12-01', toDate: '2025-12-31' })
    expect(resolveActivityLogPeriod({ period: 'today' }, now)).toEqual({ fromDate: '2026-01-15', toDate: '2026-01-15' })
    expect(resolveActivityLogPeriod({ period: 'custom', month: 9, fromDate: '2026-08-01', toDate: '2026-08-10' })).toEqual({ fromDate: '2026-08-01', toDate: '2026-08-10' })
    expect(resolveActivityLogPeriod({ period: 'all', fromDate: '2026-01-01' })).toEqual({ fromDate: '', toDate: '' })
  })
  it.each([{ period: 'month', year: 2026, month: 13 }, { fromDate: '2026-02-30' }, { fromDate: '2026-09-30', toDate: '2026-09-01' }])('rejects invalid periods', (payload) => {
    expect(() => resolveActivityLogPeriod(payload)).toThrow()
  })
})
