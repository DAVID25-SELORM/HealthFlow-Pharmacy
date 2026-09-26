import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The POS page is too large to mount here; these pin the wiring that keeps a listed medicine with a
// missing tariff from being silently billed as private, and keep coverage line-level.
const source = readFileSync('src/pages/Sales.jsx', 'utf8').replace(/\r\n/g, '\n')

describe('POS NHIS coverage wiring', () => {
  it('carries the NHIS listing flag on the cart line, separate from the tariff', () => {
    expect(source).toContain('nhisListed: Boolean(drug.is_nhis_listed)')
    // covered-ness is still derived from code + tariff only, never from the listing flag
    expect(source).toContain("nhisCode: nhisPrice > 0 ? drug.nhis_code || null : null")
  })

  it('refuses to complete an NHIA claim sale while any line has a missing NHIS tariff', () => {
    const guard = source.slice(source.indexOf('nhisSettlement.unresolvedLines.length) {'))
    expect(guard.slice(0, 500)).toContain('NHIS tariff is missing for')
    expect(guard.slice(0, 600)).toContain('return')
  })

  it('shows each line\'s coverage in NHIA claim mode and warns about unresolved lines', () => {
    expect(source).toContain('NHIS tariff missing')
    expect(source).toContain('NHIS_LINE_COVERAGE.PARTIALLY_COVERED')
    expect(source).toContain('data-coverage={line.coverage}')
  })

  it('still sources the summary buckets from the shared settlement calculator (no second pricing path)', () => {
    expect(source).toContain('calculateNhisSplitSettlement({')
    expect(source).not.toMatch(/nhisCoveredAmount:\s*item\.price/)
  })
})

describe('POS NHIS top-up wiring', () => {
  it('no longer labels the uncovered difference as a waived policy adjustment', () => {
    expect(source).not.toContain('Policy adjustment (not charged)')
    expect(source).toContain('Top-up: GHS {nhisSettlement.patientTopUpAmount.toFixed(2)}')
    expect(source).toContain('Private / Non-NHIS: GHS {nhisSettlement.privateNonNhisAmount.toFixed(2)}')
    expect(source).toContain('Patient due now: GHS {nhisSettlement.patientDueAmount.toFixed(2)}')
  })

  it('stores the buckets separately and sends the patient payment method for the patient-pay portion', () => {
    expect(source).toContain('nhisCoveredAmount: saleIsNhiaClaim ? nhiaCoveredAmount : null')
    expect(source).toContain('nhisTopUpAmount: saleIsNhiaClaim ? nhisPatientTopUpAmount : null')
    expect(source).toContain('privateNonNhisAmount: saleIsNhiaClaim ? privateNonNhisAmount : null')
    expect(source).toContain('patientPaymentMethod: saleIsNhiaClaim && patientDueAmount > 0 ? patientTopUpMethod : null')
    expect(source).toContain('id="nhia-patient-payment-method"')
  })

  it('builds the NHIS claim from the covered tariff only (the top-up never reaches the claim) and blocks unreconciled buckets', () => {
    const claimBuilder = source.slice(source.indexOf(".filter((item) => item.nhisCoveredAmount > 0)"), source.indexOf(".filter((item) => item.nhisCoveredAmount > 0)") + 400)
    expect(claimBuilder).toContain('getNhisCoveredUnitPrice(item)')
    expect(claimBuilder).not.toContain('patientTopUpAmount')
    expect(source).toContain('getNhisSettlementImbalance(nhisSettlement) !== 0')
  })

  it('leaves other payment modes on their own path (the NHIA settlement only applies to NHIA claim sales)', () => {
    expect(source).toContain("const saleIsNhiaClaim = paymentMethod === 'nhia'")
    expect(source).toContain('const checkoutTotal = isNhiaClaimSale ? nhisSettlement.patientDueAmount : total')
  })
})
