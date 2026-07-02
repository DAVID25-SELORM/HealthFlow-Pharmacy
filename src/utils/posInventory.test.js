import { describe, expect, it } from 'vitest'
import { getInStockPosDrugs } from './posInventory'

describe('POS inventory visibility', () => {
  it('never exposes zero, missing, invalid, or negative stock', () => {
    expect(getInStockPosDrugs([
      { id: 'available', quantity: 3 },
      { id: 'zero', quantity: 0 },
      { id: 'missing' },
      { id: 'invalid', quantity: 'unknown' },
      { id: 'negative', quantity: -2 },
    ])).toEqual([{ id: 'available', quantity: 3 }])
  })

  it('accepts positive numeric strings returned by APIs and caches', () => {
    expect(getInStockPosDrugs([
      { id: 'string-stock', quantity: '1.5' },
    ])).toHaveLength(1)
  })
})
