import { describe, expect, it } from 'vitest'
import { getEffectiveSellingPrice } from './drugPricing'

describe('drugPricing', () => {
  it('does not return negative selling prices for inventory valuation', () => {
    expect(getEffectiveSellingPrice({ price: -999 })).toBe(0)
  })

  it('falls back to NHIS catalog price when retail price is invalid', () => {
    expect(getEffectiveSellingPrice({
      price: -999,
      is_nhis_listed: true,
      nhis_price: 14.47,
    })).toBe(14.47)
  })
})
