import { describe, expect, it } from 'vitest'
import { formatNhiaDisplayDate } from './nhiaDisplayDates'

describe('formatNhiaDisplayDate', () => {
  it('shows ISO dates as dd/mm/yyyy like the NHIA portal', () => {
    expect(formatNhiaDisplayDate('2026-05-21')).toBe('21/05/2026')
    expect(formatNhiaDisplayDate('2027-05-20T00:00:00.000Z')).toBe('20/05/2027')
  })

  it('falls back when no date was returned', () => {
    expect(formatNhiaDisplayDate('')).toBe('Not returned')
    expect(formatNhiaDisplayDate(null)).toBe('Not returned')
    expect(formatNhiaDisplayDate(undefined, 'None')).toBe('None')
  })

  it('leaves text that is not an ISO date unchanged', () => {
    expect(formatNhiaDisplayDate('21/05/2026')).toBe('21/05/2026')
  })
})
