import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import Receipt from '../components/Receipt/Receipt'
import { formatSaleForReceipt } from '../services/receiptService'

// The POS page is too large to mount; these pin the wiring that keeps Private Insurance and NHIA Claim separate.
const source = readFileSync('src/pages/Sales.jsx', 'utf8').replace(/\r\n/g, '\n')

describe('POS wording and wiring: Private Insurance vs NHIA Claim', () => {
  it('labels the ordinary insurance option "Private Insurance" and keeps "NHIA Claim"', () => {
    expect(source).toContain('Private Insurance\n              </button>')
    expect(source).toContain('NHIA Claim\n              </button>')
    expect(source).not.toMatch(/>\s*Insurance\s*<\/button>/)
    expect(source).toContain("Coverage is based on the insurer's agreed amount, not NHIS tariffs.")
    expect(source).toContain('The NHIS tariff is applied automatically and a claim is created.')
  })

  it('Private Insurance never resolves NHIS tariffs: the mode-switch, linked inputs and defaults ignore NHIS', () => {
    const modeSwitch = source.slice(source.indexOf('const handlePaymentMethodChange'), source.indexOf('const handleInsuranceCoverageChange'))
    expect(modeSwitch).toContain("const coveredAmount = method === 'nhia' ? nhisSettlement.nhisCoveredAmount : total")
    expect(modeSwitch).not.toContain('isNhisPatient')
    expect(modeSwitch).not.toContain('canUseNhisTopups')
    const inputs = source.slice(source.indexOf('const handleInsuranceCoverageChange'), source.indexOf('const buildInsuranceSaleNotes'))
    expect(inputs).not.toContain('servingNhisPatient')
    expect(inputs).not.toContain('nhis')
    expect(source).toContain('const insuranceSplitAllowed = !isNhiaClaimSale')
    expect(source).toContain('const defaultCoverage = isNhiaClaimSale ? Math.min(nhisCoveredTotal, total) : total')
  })

  it('shows NHIS wording only in NHIA Claim mode; Private Insurance has its own summary', () => {
    expect(source).not.toContain('NHIS total: GHS')
    expect(source).not.toContain('NHIS top-up disabled')
    expect(source).toContain('Insurance cover: GHS {privateInsurance.insuranceCover.toFixed(2)}')
    expect(source).toContain('Patient top-up: GHS {privateInsuranceTopUp.toFixed(2)}')
    expect(source).toContain('{isNhiaClaimSale && Number.parseFloat(item.nhisPrice) > 0 && (')
    expect(source).toContain("{isNhiaClaimSale ? 'Patient NHIA' : 'Insurance Provider'}")
  })

  it('only the NHIA Claim path can create an NHIS claim (Private Insurance, even for an NHIS patient, cannot)', () => {
    const builder = source.slice(source.indexOf('const buildNhiaReviewClaim'), source.indexOf('const buildNhiaReviewClaim') + 400)
    expect(builder).toContain("if (paymentMethod !== 'nhia') {")
    expect(builder).toContain('return null')
    const privateClaim = source.slice(source.indexOf('const buildInsuranceClaimPayload'), source.indexOf('const buildNhiaReviewClaim'))
    expect(privateClaim).toContain("if (paymentMethod !== 'insurance' || coverage <= 0) {")
    expect(privateClaim).not.toContain('createNhisClaim')
    // every createNhisClaim call sits behind the NHIA-only review-claim builder
    const calls = source.split('createNhisClaim(').length - 1
    expect(calls).toBeGreaterThan(0)
    expect(source.split('buildNhiaReviewClaim({').length - 1).toBeGreaterThanOrEqual(calls)
  })

  it('records the settlement type on the sale receipt data', () => {
    expect(source).toContain("settlementType: saleIsNhiaClaim ? 'nhia' : 'private_insurance'")
  })
})

describe('receipts: Private Insurance vs NHIA Claim wording', () => {
  const baseSale = { saleNumber: 'S-1', saleDate: '2026-09-26T10:00:00Z', items: [], totalAmount: 40, discount: 0, netAmount: 40, amountPaid: 40, change: 0, soldBy: 'Cashier', patient: { full_name: 'A' } }
  const renderReceipt = (saleData) => render(<Receipt saleData={saleData} pharmacyInfo={{ currency: 'GHS' }} />)

  it('Private Insurance receipt says Insurance Covered / Patient Top-Up and never NHIS wording', () => {
    renderReceipt({
      ...baseSale, paymentMethod: 'insurance',
      insuranceDetails: { settlementType: 'private_insurance', provider: 'Star Assurance', insuranceId: 'P-1', coveredAmount: 30, patientTopUp: 10, privateNonNhisAmount: 0, policyAdjustmentAmount: 0, patientDueAmount: 10, patientTopUpMethod: 'cash' },
    })
    expect(screen.getByText('Insurance Covered')).toBeTruthy()
    expect(screen.getByText('Patient Top-Up')).toBeTruthy()
    expect(screen.getByText('Top-Up Paid By')).toBeTruthy()
    expect(screen.queryByText('NHIS Covered')).toBeNull()
    expect(screen.queryByText('NHIS Top-Up')).toBeNull()
  })

  it('NHIA Claim receipt keeps NHIS Covered / NHIS Top-Up / Private / Non-NHIS', () => {
    renderReceipt({
      ...baseSale, paymentMethod: 'nhia',
      insuranceDetails: { settlementType: 'nhia', provider: 'NHIS', insuranceId: '123', coveredAmount: 0.88, patientTopUp: 39.12, privateNonNhisAmount: 5, policyAdjustmentAmount: 0, patientDueAmount: 44.12, patientTopUpMethod: 'cash' },
    })
    expect(screen.getByText('NHIS Covered')).toBeTruthy()
    expect(screen.getByText('NHIS Top-Up')).toBeTruthy()
    expect(screen.getByText('Private / Non-NHIS')).toBeTruthy()
  })

  it('a reprinted Private Insurance sale keeps its own semantics (built from the insurance columns)', () => {
    const receipt = formatSaleForReceipt(
      { sale_number: 'S-9', total_amount: 40, net_amount: 40, payment_method: 'insurance', insurance_covered_amount: 30, insurance_top_up_amount: 10, insurance_top_up_payment_method: 'momo' },
      [],
      { insurance_provider: 'Star Assurance', insurance_id: 'P-1' }
    )
    expect(receipt.insuranceDetails).toMatchObject({
      settlementType: 'private_insurance', provider: 'Star Assurance', coveredAmount: 30, patientTopUp: 10, patientDueAmount: 10, patientTopUpMethod: 'momo',
    })
  })

  it('a reprinted NHIA sale is still an NHIA settlement', () => {
    const receipt = formatSaleForReceipt(
      { sale_number: 'S-8', total_amount: 40, net_amount: 40, payment_method: 'insurance', nhis_covered_amount: 0.88, nhis_top_up_amount: 39.12 },
      [],
      { insurance_provider: 'NHIS', insurance_id: '123' }
    )
    expect(receipt.insuranceDetails.settlementType).toBe('nhia')
  })

  it('a cash sale has no insurance section', () => {
    expect(formatSaleForReceipt({ sale_number: 'S-1', payment_method: 'cash', total_amount: 5, net_amount: 5 }, []).insuranceDetails).toBeNull()
  })
})
