import { describe, expect, it } from 'vitest'
import { formatSaleForReceipt } from './receiptService'

describe('formatSaleForReceipt', () => {
  it('preserves NHIS split settlement amounts for a reprinted receipt', () => {
    const receipt = formatSaleForReceipt(
      {
        sale_number: 'SALE-001',
        sale_date: '2026-08-21T10:00:00.000Z',
        total_amount: 60,
        discount: 0,
        net_amount: 60,
        payment_method: 'insurance',
        amount_paid: 25,
        change_given: 0,
        nhis_covered_amount: 30,
        nhis_top_up_amount: 10,
        private_non_nhis_amount: 15,
        nhis_policy_adjustment_amount: 5,
        patient_payment_method: 'momo',
      },
      [],
      { insurance_provider: 'NHIS', insurance_id: 'MEMBER-1' },
      'Cashier'
    )

    expect(receipt.insuranceDetails).toEqual(expect.objectContaining({
      coveredAmount: 30,
      patientTopUp: 10,
      privateNonNhisAmount: 15,
      policyAdjustmentAmount: 5,
      patientDueAmount: 25,
      patientTopUpMethod: 'momo',
    }))
  })
})
