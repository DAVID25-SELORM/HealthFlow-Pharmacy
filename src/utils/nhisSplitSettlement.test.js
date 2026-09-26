import { describe, expect, it } from 'vitest'
import {
  calculateNhisSplitSettlement,
  getNhisSaleBreakdown,
  getNhisSettlementImbalance,
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

  it('never waives the uncovered difference, whatever the legacy top-up policy says', () => {
    const result = calculateNhisSplitSettlement({
      items,
      topUpPolicy: NHIS_TOP_UP_POLICIES.NOT_ALLOWED,
    })

    expect(result.patientTopUpAmount).toBe(5)
    expect(result.privateNonNhisAmount).toBe(8)
    expect(result.policyAdjustmentAmount).toBe(0)
    expect(result.patientDueAmount).toBe(13)
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

describe('NHIS top-up rule: top-up = max(0, normal - NHIS covered)', () => {
  const nhis = (over) => ({ name: 'Item', quantity: 1, price: 40, nhisCode: 'ACETAZTA1', nhisPrice: 0.88, nhisListed: true, ...over })
  // Every policy value behaves the same: the difference is charged, never waived.
  const policies = Object.values(NHIS_TOP_UP_POLICIES)

  it.each(policies)('partial coverage (40.00 normal, 0.88 NHIS) -> top-up 39.12, patient due 39.12 [policy %s]', (topUpPolicy) => {
    const r = calculateNhisSplitSettlement({ items: [nhis()], topUpPolicy })
    expect(r.retailTotal).toBe(40)
    expect(r.nhisCoveredAmount).toBe(0.88)
    expect(r.patientTopUpAmount).toBe(39.12)
    expect(r.privateNonNhisAmount).toBe(0)
    expect(r.policyAdjustmentAmount).toBe(0)
    expect(r.patientDueAmount).toBe(39.12)
    expect(r.lines[0].coverage).toBe('PARTIALLY_COVERED')
    expect(getNhisSettlementImbalance(r)).toBe(0)
  })

  it('full coverage (40.00 normal, 40.00 NHIS) -> no top-up, nothing due', () => {
    const r = calculateNhisSplitSettlement({ items: [nhis({ nhisPrice: 40 })], topUpPolicy: NHIS_TOP_UP_POLICIES.NOT_ALLOWED })
    expect(r.nhisCoveredAmount).toBe(40)
    expect(r.patientTopUpAmount).toBe(0)
    expect(r.patientDueAmount).toBe(0)
    expect(r.lines[0].coverage).toBe('FULLY_COVERED')
  })

  it('an NHIS tariff above the normal amount never creates a negative top-up, a credit, or a bigger claim', () => {
    const r = calculateNhisSplitSettlement({ items: [nhis({ nhisPrice: 45 })] })
    expect(r.patientTopUpAmount).toBe(0)
    expect(r.patientDueAmount).toBe(0)
    expect(r.nhisCoveredAmount).toBe(40) // capped at the normal amount, never 45
    expect(r.lines.every((line) => line.patientTopUpAmount >= 0 && line.privateAmount >= 0)).toBe(true)
  })

  it('a non-NHIS item is PRIVATE, not top-up', () => {
    const r = calculateNhisSplitSettlement({ items: [{ name: 'Plain', quantity: 1, price: 5 }] })
    expect(r.patientTopUpAmount).toBe(0)
    expect(r.privateNonNhisAmount).toBe(5)
    expect(r.nhisCoveredAmount).toBe(0)
    expect(r.patientDueAmount).toBe(5)
  })

  it('mixed basket: normal 45.00 = NHIS 0.88 + top-up 39.12 + private 5.00; patient due 44.12', () => {
    const r = calculateNhisSplitSettlement({ items: [nhis(), { name: 'Private', quantity: 1, price: 5 }] })
    expect(r.retailTotal).toBe(45)
    expect(r.nhisCoveredAmount).toBe(0.88)
    expect(r.patientTopUpAmount).toBe(39.12)
    expect(r.privateNonNhisAmount).toBe(5)
    expect(r.patientDueAmount).toBe(44.12)
    expect(r.nhisCoveredAmount + r.patientTopUpAmount + r.privateNonNhisAmount).toBeCloseTo(r.netAmount, 10)
    expect(getNhisSettlementImbalance(r)).toBe(0)
  })

  it('recalculates on quantity change: 2 x (40 normal / 0.88 NHIS) = 80 / 1.76 / 78.24', () => {
    const one = calculateNhisSplitSettlement({ items: [nhis({ quantity: 1 })] })
    const two = calculateNhisSplitSettlement({ items: [nhis({ quantity: 2 })] })
    expect(one.patientTopUpAmount).toBe(39.12)
    expect(two.retailTotal).toBe(80)
    expect(two.nhisCoveredAmount).toBe(1.76)
    expect(two.patientTopUpAmount).toBe(78.24)
    expect(two.patientDueAmount).toBe(78.24)
  })

  it('removing the NHIS item leaves only the private amount; an empty basket is all zero', () => {
    const both = [nhis(), { name: 'Private', quantity: 1, price: 5 }]
    const withoutNhis = calculateNhisSplitSettlement({ items: both.slice(1) })
    expect(withoutNhis.patientTopUpAmount).toBe(0)
    expect(withoutNhis.patientDueAmount).toBe(5)
    const empty = calculateNhisSplitSettlement({ items: [] })
    expect([empty.nhisCoveredAmount, empty.patientTopUpAmount, empty.privateNonNhisAmount, empty.patientDueAmount]).toEqual([0, 0, 0, 0])
  })

  it('stays exact with awkward decimals and a basket discount (buckets always reconcile)', () => {
    const r = calculateNhisSplitSettlement({
      items: [nhis({ price: 0.3, nhisPrice: 0.1, quantity: 3 }), { name: 'Private', quantity: 1, price: 0.7 }],
      discount: 0.17,
    })
    expect(getNhisSettlementImbalance(r)).toBe(0)
    expect(r.patientDueAmount).toBe(Math.round((r.patientTopUpAmount + r.privateNonNhisAmount) * 100) / 100)
  })

  it('stored sale breakdown keeps the buckets separate, and the NHIS claim is only the covered amount', () => {
    const r = calculateNhisSplitSettlement({ items: [nhis(), { name: 'Private', quantity: 1, price: 5 }] })
    expect(getNhisSaleBreakdown(r)).toEqual({
      normalTotal: 45,
      nhisCoveredAmount: 0.88,
      topUpAmount: 39.12,
      privateNonNhisAmount: 5,
      policyAdjustmentAmount: 0,
      patientDueAmount: 44.12,
      nhisClaimAmount: 0.88, // NOT 40.00: the patient's top-up never inflates the reimbursement claim
    })
  })

  it('detects buckets that do not reconcile', () => {
    const r = calculateNhisSplitSettlement({ items: [nhis()] })
    expect(getNhisSettlementImbalance({ ...r, patientTopUpAmount: r.patientTopUpAmount + 1 })).not.toBe(0)
  })
})
