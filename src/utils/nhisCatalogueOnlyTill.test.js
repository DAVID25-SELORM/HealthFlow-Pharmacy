import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calculateNhisSplitSettlement } from './nhisSplitSettlement'
import {
  getNhisCatalogueOnlyNotListedMessage,
  isNhisCatalogueDrug,
  isNhisCatalogueOnlyPolicy,
  moveCartFromNhis,
  moveCartToNhis,
} from './nhisCatalogueOnlyTill'

const listed = { id: 'a', name: 'Amoxicillin 500mg', price: 12, retailPrice: 12, nhisPrice: 8, nhisCode: 'AMOXICIL1', quantity: 2, available: 10 }
const brand = { id: 'b', name: 'Brand Syrup', price: 30, nhisPrice: null, nhisCode: null, quantity: 1, available: 5 }

describe('which pharmacies sell NHIS catalogue medicines only (NHIS-009)', () => {
  it('applies when the top-up policy is not allowed, including the default and the legacy flag off', () => {
    expect(isNhisCatalogueOnlyPolicy({ topUpPolicy: 'not_allowed' })).toBe(true)
    expect(isNhisCatalogueOnlyPolicy({})).toBe(true)
    expect(isNhisCatalogueOnlyPolicy({ topUpPolicy: undefined, legacyTopUpsEnabled: false })).toBe(true)
  })

  it('does not apply when top-ups are allowed or required, or the legacy top-up flag is on', () => {
    expect(isNhisCatalogueOnlyPolicy({ topUpPolicy: 'allowed' })).toBe(false)
    expect(isNhisCatalogueOnlyPolicy({ topUpPolicy: 'required_when_nhis_below_selling_value' })).toBe(false)
    expect(isNhisCatalogueOnlyPolicy({ topUpPolicy: '', legacyTopUpsEnabled: true })).toBe(false)
  })
})

describe('what counts as an NHIS catalogue medicine', () => {
  it('needs an NHIS code and a usable tariff', () => {
    expect(isNhisCatalogueDrug({ nhis_code: 'PARACET1' }, 4.5)).toBe(true)
    expect(isNhisCatalogueDrug({ nhis_code: 'PARACET1' }, 0)).toBe(false)
    expect(isNhisCatalogueDrug({ nhis_code: '' }, 4.5)).toBe(false)
    expect(isNhisCatalogueDrug({}, 4.5)).toBe(false)
    expect(isNhisCatalogueDrug(null, 4.5)).toBe(false)
  })
})

describe('switching a cart to NHIS', () => {
  it('keeps catalogue lines at the catalogue amount and sets other lines aside at their selling price', () => {
    const moved = moveCartToNhis([listed, brand], [])

    expect(moved.cart).toHaveLength(1)
    expect(moved.cart[0]).toMatchObject({ id: 'a', price: 8, retailPrice: 12, quantity: 2 })
    expect(moved.held).toHaveLength(1)
    expect(moved.held[0]).toMatchObject({ id: 'b', price: 30, quantity: 1 })
    expect(moved.keptNames).toEqual(['Brand Syrup'])
  })

  it('remembers the selling price of a line that had none stored, and does not overwrite one that was', () => {
    const plain = { ...listed, retailPrice: undefined, price: 12 }
    expect(moveCartToNhis([plain], []).cart[0].retailPrice).toBe(12)
    const already = { ...listed, price: 8, retailPrice: 12 }
    expect(moveCartToNhis([already], []).cart[0].retailPrice).toBe(12)
  })

  it('covers the whole catalogue line: the patient owes nothing and there is no top-up', () => {
    const { cart } = moveCartToNhis([listed], [])
    const settlement = calculateNhisSplitSettlement({ items: cart, topUpPolicy: 'not_allowed' })

    expect(settlement.nhisCoveredAmount).toBe(16)
    expect(settlement.netAmount).toBe(16)
    expect(settlement.patientTopUpAmount).toBe(0)
    expect(settlement.privateNonNhisAmount).toBe(0)
    expect(settlement.patientDueAmount).toBe(0)
  })

  it('merges with lines already set aside instead of duplicating them', () => {
    const moved = moveCartToNhis([{ ...brand, quantity: 2 }], [{ ...brand, quantity: 1 }])
    expect(moved.held).toHaveLength(1)
    expect(moved.held[0].quantity).toBe(3)
  })

  it('never exceeds the stock available when merging', () => {
    const moved = moveCartToNhis([{ ...brand, quantity: 4 }], [{ ...brand, quantity: 4 }])
    expect(moved.held[0].quantity).toBe(5)
  })

  it('handles an empty or missing cart', () => {
    expect(moveCartToNhis([], [])).toEqual({ cart: [], held: [], keptNames: [] })
    expect(moveCartToNhis(undefined, undefined)).toEqual({ cart: [], held: [], keptNames: [] })
  })
})

describe('leaving NHIS', () => {
  it('puts catalogue lines back to their selling price and returns the lines kept for cash', () => {
    const toNhis = moveCartToNhis([listed, brand], [])
    const back = moveCartFromNhis(toNhis.cart, toNhis.held)

    expect(back.cart.map((line) => [line.id, line.price, line.quantity])).toEqual([['a', 12, 2], ['b', 30, 1]])
    expect(back.restoredNames).toEqual(['Brand Syrup'])
  })

  it('round-trips without changing any quantity or price', () => {
    const start = [listed, brand]
    const toNhis = moveCartToNhis(start, [])
    const back = moveCartFromNhis(toNhis.cart, toNhis.held)
    const key = (line) => [line.id, line.price, line.quantity]
    expect(back.cart.map(key).sort()).toEqual(start.map(key).sort())
  })

  it('leaves a cart with nothing set aside as it was, at the selling price', () => {
    const back = moveCartFromNhis([{ ...listed, price: 8 }], [])
    expect(back.cart[0].price).toBe(12)
    expect(back.restoredNames).toEqual([])
  })
})

describe('messages', () => {
  it('tells the cashier to sell a non-catalogue medicine as a separate cash sale', () => {
    expect(getNhisCatalogueOnlyNotListedMessage('Brand Syrup')).toBe('Brand Syrup is not on the NHIS list. Sell it as a separate cash sale.')
  })
})

describe('point-of-sale wiring (source check)', () => {
  const sales = readFileSync(resolve(process.cwd(), 'src/pages/Sales.jsx'), 'utf8')

  it('filters the medicine list to the NHIS catalogue only under NHIS at a pharmacy without top-ups', () => {
    expect(sales).toContain('isNhisCatalogueOnlyPolicy({')
    expect(sales).toContain('const nhisCatalogueOnlyActive = nhisCatalogueOnly && paymentMethod === \'nhia\'')
    expect(sales).toContain('inStock.filter((drug) => isNhisCatalogueDrug(drug, getNhisCatalogPrice(drug)))')
  })

  it('refuses a non-catalogue medicine at add-to-cart, for example from a barcode scan', () => {
    const start = sales.indexOf('const addToCart = (drug) =>')
    const guard = sales.indexOf('getNhisCatalogueOnlyNotListedMessage(drug.name)')
    expect(guard).toBeGreaterThan(start)
    expect(guard - start).toBeLessThan(1200)
  })

  it('moves lines when the payment method changes, and returns them after the sale', () => {
    expect(sales).toContain('moveCartToNhis(cart, heldCashItems)')
    expect(sales).toContain('moveCartFromNhis(cart, heldCashItems)')
    expect(sales.match(/returnHeldCashItemsAfterSale\(\)/g) || []).toHaveLength(5)
  })

  it('keeps the lines set aside in the unfinished-sale draft', () => {
    expect(sales).toContain('cart, heldCashItems, patientId, paymentMethod')
    expect(sales).toContain('draft.heldCashItems')
  })
})
