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

import { reconcilePrivateInsuranceInputs } from './privateInsuranceSettlement'

describe('typing in the linked Private Insurance boxes (regression: only the arrow keys worked)', () => {
  const r = (over) => reconcilePrivateInsuranceInputs({ total: 40, insuranceCover: '40.00', patientTopUp: '0.00', edited: '', ...over })

  it('never rewrites the cover the cashier is typing, including values equal to the bill and an empty box', () => {
    expect(r({ edited: 'cover', insuranceCover: '40.0', patientTopUp: '0.00' }).insuranceCover).toBe('40.0')
    expect(r({ edited: 'cover', insuranceCover: '4', patientTopUp: '' })).toEqual({ insuranceCover: '4', patientTopUp: '36.00' })
    expect(r({ edited: 'cover', insuranceCover: '', patientTopUp: '' })).toEqual({ insuranceCover: '', patientTopUp: '40.00' })
    expect(r({ edited: 'cover', insuranceCover: '3.', patientTopUp: '' }).insuranceCover).toBe('3.')
  })

  it('a partial cover updates the top-up (40 - 30 = 10) and a cover above the bill is capped at the bill', () => {
    expect(r({ edited: 'cover', insuranceCover: '30' })).toEqual({ insuranceCover: '30', patientTopUp: '10.00' })
    expect(r({ edited: 'cover', insuranceCover: '55' })).toEqual({ insuranceCover: '40.00', patientTopUp: '0.00' })
  })

  it('typing the top-up leaves that box alone and derives the cover from it', () => {
    expect(r({ edited: 'topup', patientTopUp: '1.', insuranceCover: '40.00' })).toEqual({ insuranceCover: '39.00', patientTopUp: '1.' })
    expect(r({ edited: 'topup', patientTopUp: '', insuranceCover: '' })).toEqual({ insuranceCover: '40.00', patientTopUp: '' })
    expect(r({ edited: 'topup', patientTopUp: '99' })).toEqual({ insuranceCover: '0.00', patientTopUp: '40.00' })
  })

  it('with nothing typed it defaults to the insurer covering the whole bill and follows a changed bill', () => {
    expect(r({ insuranceCover: '' })).toEqual({ insuranceCover: '40.00', patientTopUp: '0.00' })
    expect(r({ total: 30, insuranceCover: '40.00' })).toEqual({ insuranceCover: '30.00', patientTopUp: '0.00' })
  })
})
