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

describe('per-line NHIS coverage classification (POS)', () => {
  const line = (over) => ({ name: 'Item', quantity: 1, price: 10, ...over })
  const settle = (items, extra = {}) => calculateNhisSplitSettlement({ items, topUpPolicy: NHIS_TOP_UP_POLICIES.ALLOWED, ...extra })

  it('fully covered: 1.76 medicine moves entirely to the NHIS claim', () => {
    const r = settle([line({ price: 1.76, nhisCode: 'DOMPERTA1', nhisPrice: 1.76, nhisListed: true })])
    expect(r.lines[0].coverage).toBe('FULLY_COVERED')
    expect(r.retailTotal).toBe(1.76)
    expect(r.nhisCoveredAmount).toBe(1.76)
    expect(r.privateNonNhisAmount).toBe(0)
    expect(r.patientDueAmount).toBe(0)
  })

  it('partially covered: patient owes only the uncovered part', () => {
    const r = settle([line({ price: 10, nhisCode: 'X', nhisPrice: 7.5, nhisListed: true })])
    expect(r.lines[0].coverage).toBe('PARTIALLY_COVERED')
    expect(r.nhisCoveredAmount).toBe(7.5)
    expect(r.patientDueAmount).toBe(2.5)
  })

  it('not covered: a non-NHIS medicine is entirely private', () => {
    const r = settle([line({ price: 4 })])
    expect(r.lines[0].coverage).toBe('NOT_COVERED')
    expect(r.nhisCoveredAmount).toBe(0)
    expect(r.privateNonNhisAmount).toBe(4)
  })

  it('unresolved: listed as NHIS but no usable tariff is flagged, never silently covered or trusted', () => {
    for (const broken of [{ nhisPrice: null }, { nhisPrice: 0 }, { nhisPrice: 5, nhisCode: null }]) {
      const r = settle([line({ price: 1.76, nhisCode: 'ACETAZTA1', nhisListed: true, ...broken })])
      expect(r.lines[0].coverage).toBe('UNRESOLVED')
      expect(r.unresolvedLines).toHaveLength(1)
      expect(r.nhisCoveredAmount).toBe(0)
    }
  })

  it('mixed basket reconciles exactly (10 covered, 8 partly, 4 private)', () => {
    const r = settle([
      line({ name: 'A', price: 10, nhisCode: 'A', nhisPrice: 10, nhisListed: true }),
      line({ name: 'B', price: 8, nhisCode: 'B', nhisPrice: 5, nhisListed: true }),
      line({ name: 'C', price: 4 }),
    ], { topUpPolicy: NHIS_TOP_UP_POLICIES.ALLOWED })
    expect(r.retailTotal).toBe(22)
    expect(r.nhisCoveredAmount).toBe(15)
    expect(r.privateNonNhisAmount).toBe(4)
    expect(r.patientTopUpAmount).toBe(3)
    expect(r.patientDueAmount).toBe(7)
    expect(r.nhisCoveredAmount + r.patientDueAmount).toBe(r.netAmount)
    expect(r.lines.map((l) => l.coverage)).toEqual(['FULLY_COVERED', 'PARTIALLY_COVERED', 'NOT_COVERED'])
  })

  it('recalculates when quantity changes: unit tariff x quantity, capped at the line value', () => {
    const base = { price: 1.76, nhisCode: 'D', nhisPrice: 1.76, nhisListed: true }
    expect(settle([line({ ...base, quantity: 1 })]).nhisCoveredAmount).toBe(1.76)
    expect(settle([line({ ...base, quantity: 3 })]).nhisCoveredAmount).toBe(5.28)
    expect(settle([line({ ...base, quantity: 3 })]).patientDueAmount).toBe(0)
  })

  it('uses cent-safe arithmetic (no binary drift)', () => {
    const r = settle([line({ price: 0.1, quantity: 3, nhisCode: 'D', nhisPrice: 0.1, nhisListed: true }), line({ price: 0.2 })])
    expect(r.nhisCoveredAmount).toBe(0.3)
    expect(r.privateNonNhisAmount).toBe(0.2)
    expect(r.patientDueAmount).toBe(0.2)
  })

  it('ignores any caller-supplied covered amount; coverage comes only from code + tariff', () => {
    const r = settle([line({ price: 10, nhisCoveredAmount: 10, nhisCode: null, nhisPrice: null })])
    expect(r.nhisCoveredAmount).toBe(0)
    expect(r.privateNonNhisAmount).toBe(10)
  })

  it('never lets the patient pay for a covered amount (no double charge)', () => {
    const r = settle([line({ price: 1.76, nhisCode: 'D', nhisPrice: 1.76, nhisListed: true })])
    expect(r.patientDueAmount + r.nhisCoveredAmount).toBe(r.netAmount)
    expect(r.patientDueAmount).toBe(0)
  })
})
