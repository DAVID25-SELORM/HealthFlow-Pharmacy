import { describe, expect, it } from 'vitest'
import { normalizePharmacyClaimLines } from './claimPricing.js'

describe('pharmacy claim pricing', () => {
  it('ignores client totals and calculates medicine and service totals', () => {
    expect(normalizePharmacyClaimLines({
      isHospital: true,
      medicines: [{ quantity: 2, unitPrice: 3.5, totalPrice: 1 }],
      services: [{ quantity: 2, unitPrice: 5, totalAmount: 999 }],
    })).toMatchObject({
      medicines: [{ quantity: 2, unitPrice: 3.5, totalPrice: 7 }],
      services: [{ quantity: 2, unitPrice: 5, totalPrice: 10, totalAmount: 10 }],
      totalAmount: 17,
    })
  })

  it('rejects invalid quantities and prices', () => {
    expect(() => normalizePharmacyClaimLines({
      medicines: [{ quantity: 0, unitPrice: 3 }],
    })).toThrow('Medicine quantity must be greater than zero.')
    expect(() => normalizePharmacyClaimLines({
      medicines: [{ quantity: 1, unitPrice: -1 }],
    })).toThrow('Medicine unit price cannot be negative.')
  })
})
