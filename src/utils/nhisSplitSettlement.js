export const NHIS_TOP_UP_POLICIES = Object.freeze({
  NOT_ALLOWED: 'not_allowed',
  ALLOWED: 'allowed',
  REQUIRED_WHEN_NHIS_BELOW_SELLING_VALUE: 'required_when_nhis_below_selling_value',
})

const money = (value) => Math.round((Number(value) || 0) * 100) / 100

export const normalizeNhisTopUpPolicy = (value, { legacyTopUpsEnabled = false } = {}) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (Object.values(NHIS_TOP_UP_POLICIES).includes(normalized)) {
    return normalized
  }

  return legacyTopUpsEnabled
    ? NHIS_TOP_UP_POLICIES.ALLOWED
    : NHIS_TOP_UP_POLICIES.NOT_ALLOWED
}

// A medicine flagged as NHIS-listed whose tariff cannot be resolved must never be silently treated
// as private (or as covered): staff have to see it and fix the mapping.
export const NHIS_LINE_COVERAGE = Object.freeze({
  FULLY_COVERED: 'FULLY_COVERED',
  PARTIALLY_COVERED: 'PARTIALLY_COVERED',
  NOT_COVERED: 'NOT_COVERED',
  UNRESOLVED: 'UNRESOLVED',
})

export const isNhisSettlementEligible = (item) => {
  const code = String(item?.nhisCode ?? item?.nhis_code ?? '').trim()
  const tariff = Number(item?.nhisPrice ?? item?.nhis_price)
  return Boolean(code) && Number.isFinite(tariff) && tariff > 0
}

/**
 * Splits a POS basket into immutable financial buckets. No caller may provide
 * a covered amount: the catalog code and tariff determine it per line.
 */
export const calculateNhisSplitSettlement = ({
  items = [],
  discount = 0,
  topUpPolicy,
  legacyTopUpsEnabled = false,
} = {}) => {
  const policy = normalizeNhisTopUpPolicy(topUpPolicy, { legacyTopUpsEnabled })
  const retailTotal = money(items.reduce((sum, item) =>
    sum + Math.max(0, Number(item?.price) || 0) * Math.max(0, Number(item?.quantity) || 0), 0))
  const appliedDiscount = money(Math.min(Math.max(0, Number(discount) || 0), retailTotal))

  let allocatedDiscount = 0
  const lines = items.map((item, index) => {
    const quantity = Math.max(0, Number(item?.quantity) || 0)
    const unitPrice = Math.max(0, Number(item?.price) || 0)
    const retailAmount = money(unitPrice * quantity)
    // Allocate the final rounding remainder to the final line so the buckets
    // always reconcile exactly to the POS net total.
    const lineDiscount = index === items.length - 1
      ? money(appliedDiscount - allocatedDiscount)
      : money(retailTotal > 0 ? appliedDiscount * (retailAmount / retailTotal) : 0)
    allocatedDiscount = money(allocatedDiscount + lineDiscount)
    const netRetailAmount = money(retailAmount - lineDiscount)
    const tariffUnitPrice = Math.max(0, Number(item?.nhisPrice ?? item?.nhis_price) || 0)
    const eligible = isNhisSettlementEligible(item)
    // NHIS is deducted first, capped at the line's normal amount (an NHIS tariff above the selling price never
    // credits the patient or inflates the claim).
    const nhisCoveredAmount = eligible ? money(Math.min(tariffUnitPrice * quantity, netRetailAmount)) : 0
    // Business rule: on an NHIS-covered line, TOP-UP = max(0, normal amount - NHIS covered amount). It is charged to
    // the patient, never waived. A non-NHIS line is PRIVATE, not top-up, so reports can tell them apart.
    const difference = Math.max(0, money(netRetailAmount - nhisCoveredAmount))
    const patientTopUpAmount = eligible ? difference : 0
    const privateAmount = eligible ? 0 : netRetailAmount
    const listedInNhis = Boolean(item?.nhisListed ?? item?.is_nhis_listed)
    const coverage = eligible
      ? (difference > 0 ? NHIS_LINE_COVERAGE.PARTIALLY_COVERED : NHIS_LINE_COVERAGE.FULLY_COVERED)
      : (listedInNhis ? NHIS_LINE_COVERAGE.UNRESOLVED : NHIS_LINE_COVERAGE.NOT_COVERED)
    // Kept only for stored-sale compatibility: the uncovered difference is a top-up now, never an automatic waiver.
    const policyAdjustmentAmount = 0

    return {
      ...item,
      nhisSettlement: eligible ? (difference > 0 ? 'nhis_top_up' : 'nhis_covered') : 'private',
      coverage,
      retailAmount,
      discountAmount: lineDiscount,
      netRetailAmount,
      nhisCoveredAmount,
      patientTopUpAmount,
      privateAmount,
      policyAdjustmentAmount,
    }
  })

  const sum = (field) => money(lines.reduce((total, line) => total + line[field], 0))
  const nhisCoveredAmount = sum('nhisCoveredAmount')
  const patientTopUpAmount = sum('patientTopUpAmount')
  const privateNonNhisAmount = sum('privateAmount')
  const policyAdjustmentAmount = sum('policyAdjustmentAmount')
  const netAmount = money(retailTotal - appliedDiscount)

  return {
    policy,
    retailTotal,
    discountAmount: appliedDiscount,
    netAmount,
    nhisCoveredAmount,
    patientTopUpAmount,
    privateNonNhisAmount,
    policyAdjustmentAmount,
    patientDueAmount: money(patientTopUpAmount + privateNonNhisAmount),
    unresolvedLines: lines.filter((line) => line.coverage === NHIS_LINE_COVERAGE.UNRESOLVED),
    lines,
  }
}

/**
 * NORMAL TOTAL = NHIS COVERED + TOP-UP + PRIVATE/NON-NHIS (+ any legacy policy adjustment), to the cent, and
 * PATIENT DUE = TOP-UP + PRIVATE/NON-NHIS. Returns the discrepancy (0 when the buckets reconcile).
 */
export const getNhisSettlementImbalance = (settlement) => {
  const buckets = money(
    settlement.nhisCoveredAmount + settlement.patientTopUpAmount + settlement.privateNonNhisAmount + settlement.policyAdjustmentAmount
  )
  const bucketImbalance = money(settlement.netAmount - buckets)
  const dueImbalance = money(settlement.patientDueAmount - (settlement.patientTopUpAmount + settlement.privateNonNhisAmount))
  return Math.abs(bucketImbalance) > 0 ? bucketImbalance : dueImbalance
}

/**
 * The separately stored components of an NHIA claim sale. The NHIS claim amount is ONLY the covered amount:
 * the patient's top-up and private items never reach the reimbursement claim.
 */
export const getNhisSaleBreakdown = (settlement) => ({
  normalTotal: settlement.netAmount,
  nhisCoveredAmount: settlement.nhisCoveredAmount,
  topUpAmount: settlement.patientTopUpAmount,
  privateNonNhisAmount: settlement.privateNonNhisAmount,
  policyAdjustmentAmount: settlement.policyAdjustmentAmount,
  patientDueAmount: settlement.patientDueAmount,
  nhisClaimAmount: settlement.nhisCoveredAmount,
})
