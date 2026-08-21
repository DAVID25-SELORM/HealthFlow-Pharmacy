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
  const patientTopUpsAllowed = policy !== NHIS_TOP_UP_POLICIES.NOT_ALLOWED

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
    const nhisCoveredAmount = eligible ? money(Math.min(tariffUnitPrice * quantity, netRetailAmount)) : 0
    const difference = money(netRetailAmount - nhisCoveredAmount)
    const patientTopUpAmount = eligible && patientTopUpsAllowed ? difference : 0
    const privateAmount = eligible ? 0 : netRetailAmount
    const policyAdjustmentAmount = eligible && !patientTopUpsAllowed ? difference : 0

    return {
      ...item,
      nhisSettlement: eligible ? (difference > 0 ? 'nhis_top_up' : 'nhis_covered') : 'private',
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
    lines,
  }
}
