import { describe, expect, it } from 'vitest'
import {
  calculateNhisSplitSettlement,
  NHIS_TOP_UP_POLICIES,
} from './nhisSplitSettlement'

describe('calculateNhisSplitSettlement', () => {
  const items = [
    { name: 'Covered', quantity: 2, price: 10, nhisCode: 'NH-1', nhisPrice: 10 },
    { name: 'Top-up', quantity: 1, price: 20, nhisCode: 'NH-2', nhisPrice: 15 },
    { name: 'Private', quantity: 1, price: 8 },
  ]

  it('separates covered, top-up and private lines without overclaiming', () => {
    const result = calculateNhisSplitSettlement({
      items,
      topUpPolicy: NHIS_TOP_UP_POLICIES.ALLOWED,
    })

    expect(result.nhisCoveredAmount).toBe(35)
    expect(result.patientTopUpAmount).toBe(5)
    expect(result.privateNonNhisAmount).toBe(8)
    expect(result.patientDueAmount).toBe(13)
    expect(result.policyAdjustmentAmount).toBe(0)
    expect(result.lines.map((line) => line.nhisSettlement)).toEqual([
      'nhis_covered',
      'nhis_top_up',
      'private',
    ])
  })

  it('never creates a patient top-up when policy disallows it', () => {
    const result = calculateNhisSplitSettlement({
      items,
      topUpPolicy: NHIS_TOP_UP_POLICIES.NOT_ALLOWED,
    })

    expect(result.patientTopUpAmount).toBe(0)
    expect(result.privateNonNhisAmount).toBe(8)
    expect(result.policyAdjustmentAmount).toBe(5)
    expect(result.patientDueAmount).toBe(8)
  })

  it('reconciles all buckets after a basket discount', () => {
    const result = calculateNhisSplitSettlement({
      items,
      discount: 4.01,
      topUpPolicy: NHIS_TOP_UP_POLICIES.ALLOWED,
    })
    const bucketTotal = result.nhisCoveredAmount + result.patientTopUpAmount +
      result.privateNonNhisAmount + result.policyAdjustmentAmount

    expect(Number(bucketTotal.toFixed(2))).toBe(result.netAmount)
  })
})
