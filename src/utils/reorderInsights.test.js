import { describe, expect, it } from 'vitest'
import { STOCK_SEVERITY } from './reorderCentre'
import {
  FAST_MOVING_DAYS,
  LARGE_PRICE_CHANGE_PERCENT,
  MIN_HISTORY_DAYS,
  VELOCITY_STATUS,
  computeVelocity,
  describePriceChange,
  describeVelocity,
  formatPriceChange,
  formatUsagePerDay,
  getExpiryWarning,
  getReorderPriority,
  isFastMoving,
} from './reorderInsights'

describe('computeVelocity', () => {
  it('computes daily/weekly usage and days of stock from real sales', () => {
    const v = computeVelocity({ units_sold: 90, history_days: 90 }, 30)
    expect(v.status).toBe(VELOCITY_STATUS.OK)
    expect(v.avgDailyUsage).toBe(1)
    expect(v.avgWeeklyUsage).toBe(7)
    expect(v.daysOfStock).toBe(30)
  })

  it('says "not enough data" rather than guessing when history is short', () => {
    const v = computeVelocity({ units_sold: 4, history_days: MIN_HISTORY_DAYS - 1 }, 10)
    expect(v.status).toBe(VELOCITY_STATUS.INSUFFICIENT)
    expect(v.daysOfStock).toBeNull()
    expect(describeVelocity(v)).toBe('Not enough data')
  })

  it('treats a missing insight as not enough data', () => {
    expect(computeVelocity(null, 10).status).toBe(VELOCITY_STATUS.INSUFFICIENT)
    expect(computeVelocity({}, 10).status).toBe(VELOCITY_STATUS.INSUFFICIENT)
  })

  it('handles zero usage safely: no division by zero, reported as no recent sales', () => {
    const v = computeVelocity({ units_sold: 0, history_days: 90 }, 50)
    expect(v.status).toBe(VELOCITY_STATUS.NO_SALES)
    expect(v.daysOfStock).toBeNull()
    expect(describeVelocity(v)).toBe('No recent sales')
    expect(Number.isFinite(v.avgDailyUsage)).toBe(true)
  })

  it('shows zero days of stock when out of stock but selling', () => {
    const v = computeVelocity({ units_sold: 90, history_days: 90 }, 0)
    expect(v.daysOfStock).toBe(0)
    expect(describeVelocity(v)).toBe('Under 1 day')
  })

  it('describes and formats results readably', () => {
    const v = computeVelocity({ units_sold: 180, history_days: 90 }, 10) // 2/day, 5 days
    expect(describeVelocity(v)).toBe('5 days')
    expect(formatUsagePerDay(v)).toBe('2/day')
    expect(formatUsagePerDay(computeVelocity({ units_sold: 9, history_days: 90 }, 10))).toBe('0.1/day')
    expect(formatUsagePerDay(computeVelocity(null, 10))).toBe('—')
  })

  it('flags fast movers by days of stock', () => {
    expect(isFastMoving(computeVelocity({ units_sold: 90, history_days: 90 }, FAST_MOVING_DAYS))).toBe(true)
    expect(isFastMoving(computeVelocity({ units_sold: 90, history_days: 90 }, FAST_MOVING_DAYS + 1))).toBe(false)
    expect(isFastMoving(computeVelocity(null, 1))).toBe(false)
  })
})

describe('describePriceChange', () => {
  it('reports the change against the previous cost', () => {
    const change = describePriceChange(42, 39.5)
    expect(change).toMatchObject({ current: 42, previous: 39.5, direction: 'up', flagged: false })
    expect(change.changePercent).toBeCloseTo(6.3, 1)
    expect(formatPriceChange(change)).toBe('Last GHS 42.00 · Previous GHS 39.50 · +6.3%')
  })

  it('flags an unusually large change but never blocks', () => {
    expect(describePriceChange(60, 40).flagged).toBe(true) // +50%
    expect(describePriceChange(40, 60).flagged).toBe(true) // -33%
    expect(describePriceChange(48, 40).flagged).toBe(LARGE_PRICE_CHANGE_PERCENT <= 20) // exactly 20%
    expect(describePriceChange(41, 40).flagged).toBe(false)
  })

  it('shows only the last cost when there is no previous one, and nothing when there is no cost', () => {
    const only = describePriceChange(42, null)
    expect(only).toMatchObject({ previous: null, changePercent: null, flagged: false })
    expect(formatPriceChange(only)).toBe('Last cost GHS 42.00')
    expect(describePriceChange(null, 40)).toBeNull()
    expect(describePriceChange(0, 40)).toBeNull()
    expect(formatPriceChange(null)).toBe('')
  })

  it('marks a decrease as down', () => {
    expect(describePriceChange(38, 40).direction).toBe('down')
    expect(describePriceChange(40, 40).direction).toBe('flat')
  })
})

describe('getExpiryWarning', () => {
  const now = new Date('2026-09-23T10:00:00Z')

  it('warns how many units expire within how many days', () => {
    const w = getExpiryWarning({ quantity: 45, expiry_date: '2026-11-22' }, 60, now) // 60 days
    expect(w).toMatchObject({ kind: 'expiring', units: 45, daysLeft: 60 })
    expect(w.message).toBe('45 units expire within 60 days.')
  })

  it('stays quiet when expiry is beyond the window or there is no stock', () => {
    expect(getExpiryWarning({ quantity: 45, expiry_date: '2027-06-01' }, 60, now)).toBeNull()
    expect(getExpiryWarning({ quantity: 0, expiry_date: '2026-09-30' }, 60, now)).toBeNull()
    expect(getExpiryWarning({ quantity: 5 }, 60, now)).toBeNull()
  })

  it('reports stock that has already expired, and stock expiring today', () => {
    expect(getExpiryWarning({ quantity: 3, expiry_date: '2026-09-01' }, 30, now)).toMatchObject({ kind: 'expired' })
    expect(getExpiryWarning({ quantity: 1, expiry_date: '2026-09-23' }, 30, now).message).toBe('1 unit expire today.')
  })

  it('uses the configured window, falling back to 30 days', () => {
    const drug = { quantity: 10, expiry_date: '2026-10-30' } // 37 days
    expect(getExpiryWarning(drug, 30, now)).toBeNull()
    expect(getExpiryWarning(drug, 45, now)).not.toBeNull()
    expect(getExpiryWarning({ quantity: 10, expiry_date: '2026-10-10' }, undefined, now)).not.toBeNull()
  })

  it('ignores an unreadable date', () => {
    expect(getExpiryWarning({ quantity: 5, expiry_date: 'not a date' }, 30, now)).toBeNull()
  })
})

describe('getReorderPriority', () => {
  const fast = computeVelocity({ units_sold: 180, history_days: 90 }, 4) // 2 days left
  const slow = computeVelocity({ units_sold: 9, history_days: 90 }, 40)
  const unknown = computeVelocity(null, 4)

  it('P1: out of stock, whatever the speed', () => {
    expect(getReorderPriority(STOCK_SEVERITY.OUT_OF_STOCK, slow).level).toBe(1)
    expect(getReorderPriority(STOCK_SEVERITY.OUT_OF_STOCK, unknown).level).toBe(1)
  })

  it('P2: critical and fast moving', () => {
    expect(getReorderPriority(STOCK_SEVERITY.CRITICAL, fast)).toEqual({ level: 2, reasons: ['Critically low', 'Fast moving'] })
  })

  it('P3: critical but slow/unknown, or low and fast moving', () => {
    expect(getReorderPriority(STOCK_SEVERITY.CRITICAL, slow).level).toBe(3)
    expect(getReorderPriority(STOCK_SEVERITY.CRITICAL, unknown).level).toBe(3)
    expect(getReorderPriority(STOCK_SEVERITY.LOW, fast).level).toBe(3)
  })

  it('P4: low and slow moving or unknown speed, and unknown velocity never blocks a priority', () => {
    expect(getReorderPriority(STOCK_SEVERITY.LOW, slow)).toEqual({ level: 4, reasons: ['Low stock', 'Slow moving'] })
    expect(getReorderPriority(STOCK_SEVERITY.LOW, unknown)).toEqual({ level: 4, reasons: ['Low stock', 'Speed unknown'] })
  })

  it('has no priority when stock is fine', () => {
    expect(getReorderPriority(STOCK_SEVERITY.OK, fast)).toEqual({ level: null, reasons: [] })
  })
})
