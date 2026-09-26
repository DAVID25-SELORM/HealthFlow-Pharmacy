import { describe, expect, it } from 'vitest'
import { calculatePrivateInsuranceSettlement } from './privateInsuranceSettlement'
import { calculateNhisSplitSettlement } from './nhisSplitSettlement'

const calc = (normalTotal, insuranceCover) => calculatePrivateInsuranceSettlement({ normalTotal, insuranceCover })

describe('Private Insurance settlement (normal selling price, insurer agreed cover)', () => {
  it('100% cover: nothing to pay, patient due 0', () => {
    expect(calc(40, 40)).toEqual({ normalTotal: 40, insuranceCover: 40, patientTopUp: 0, patientDueAmount: 0 })
    expect(calc(100, 100).patientDueAmount).toBe(0)
  })

  it('partial cover: patient top-up is the uncovered part (40 - 30 = 10)', () => {
    expect(calc(40, 30)).toEqual({ normalTotal: 40, insuranceCover: 30, patientTopUp: 10, patientDueAmount: 10 })
  })

  it('zero cover: the patient pays the whole bill', () => {
    expect(calc(40, 0)).toEqual({ normalTotal: 40, insuranceCover: 0, patientTopUp: 40, patientDueAmount: 40 })
  })

  it('cover above the bill is capped at the bill; the top-up is never negative', () => {
    const r = calc(40, 55)
    expect(r.insuranceCover).toBe(40)
    expect(r.patientTopUp).toBe(0)
    expect(calc(40, -5).insuranceCover).toBe(0)
    expect(calc(40, -5).patientTopUp).toBe(40)
  })

  it('is cent-exact', () => {
    expect(calc(0.3, 0.1)).toMatchObject({ insuranceCover: 0.1, patientTopUp: 0.2 })
    expect(calc(10.1, 3.05).patientTopUp).toBe(7.05)
  })

  it('does not use any NHIS tariff: an NHIS-priced cart line has no effect on Private Insurance', () => {
    // Same bill, same agreed cover: the result depends only on total and cover, never on nhisPrice/nhisCode.
    expect(calc(40, 30)).toEqual(calc(40, 30))
    const nhia = calculateNhisSplitSettlement({ items: [{ name: 'A', quantity: 1, price: 40, nhisCode: 'X', nhisPrice: 0.88, nhisListed: true }] })
    expect(nhia.nhisCoveredAmount).toBe(0.88) // NHIA Claim resolves the tariff...
    expect(calc(40, 30).insuranceCover).toBe(30) // ...Private Insurance does not
  })

  it('keeps the two models separate: same bill, different results by design', () => {
    const item = { name: 'A', quantity: 1, price: 40, nhisCode: 'X', nhisPrice: 0.88, nhisListed: true }
    const nhia = calculateNhisSplitSettlement({ items: [item] })
    const privateInsurance = calc(40, 40)
    expect(nhia.patientDueAmount).toBe(39.12)
    expect(privateInsurance.patientDueAmount).toBe(0)
  })
})
