const NHIS_SERVING_REVIEW_FINALIZABLE_STATUSES = new Set([
  'returned_for_review',
  'partially_served',
  'fully_served',
])

const NHIS_MCA_OPENABLE_STATUSES = new Set([
  'pending_serving',
  'serving_in_progress',
  'returned_for_review',
  'served',
])

const NHIS_DIRECT_SERVING_ROLES = new Set([
  'admin',
  'super_admin',
  'claims_officer',
])

const NHIS_DIRECT_SERVING_STATUSES = new Set([
  'draft',
  'pending_serving',
  'serving_in_progress',
  'returned_for_review',
  'claim_ready',
  'served',
])

const CLAIM_LEVEL_MCA_INFO_PATTERNS = [
  /^Patient /i,
  /^Folder number/i,
  /^Prescribing facility/i,
  /^Prescriber /i,
  /^Date of dispensing\/service/i,
  /^NHIS member number/i,
  /^Ghana Card/i,
  /^NHIA CCC/i,
  /^CCC/i,
  /^Diagnosis/i,
  /^Attach the scanned prescription/i,
  /^Set the NHIA/i,
  /^Pharmacy NHIS claims cannot include/i,
]

const CLAIMS_OFFICER_MEDICINE_COMPLETION_PATTERNS = [
  /^Medicine \d+: dose is (required|missing)/i,
  /^Medicine \d+: dosage schedule\/frequency is (required|missing)/i,
  /^Medicine \d+: duration is (required|missing)/i,
]

const MEDICINE_LEVEL_MCA_PATTERNS = [
  /^Add at least one medicine/i,
  /^Medicine \d+:/i,
  /^High: duplicate medicine/i,
  /^High: Medicine \d+:/i,
  /^High: .*medicine/i,
]

const normalizeNhisServingStatus = (status = '') =>
  String(status || '').trim().toLowerCase()

export const isMcaMedicineIssue = (issue = '') => {
  const normalized = String(issue || '').trim()
  if (!normalized) return false
  if (CLAIM_LEVEL_MCA_INFO_PATTERNS.some((pattern) => pattern.test(normalized))) return false
  if (CLAIMS_OFFICER_MEDICINE_COMPLETION_PATTERNS.some((pattern) => pattern.test(normalized))) return false
  return MEDICINE_LEVEL_MCA_PATTERNS.some((pattern) => pattern.test(normalized))
}

export const splitMcaReadinessIssues = (readiness = {}) => {
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : []
  const warnings = Array.isArray(readiness.warnings) ? readiness.warnings : []
  const medicineBlockers = blockers.filter(isMcaMedicineIssue)
  const claimCompletionBlockers = blockers.filter((issue) => !isMcaMedicineIssue(issue))
  const medicineWarnings = warnings.filter(isMcaMedicineIssue)
  const claimCompletionWarnings = warnings.filter((issue) => !isMcaMedicineIssue(issue))

  return {
    medicineBlockers,
    medicineWarnings,
    claimCompletionBlockers,
    claimCompletionWarnings,
    canSaveMedicines: medicineBlockers.length === 0,
  }
}

export const shouldFinalizeNhisServingReview = (status = '') =>
  NHIS_SERVING_REVIEW_FINALIZABLE_STATUSES.has(normalizeNhisServingStatus(status))

export const isNhisClaimDirectlyServed = (claim = {}) =>
  Boolean(claim?.direct_served_at || claim?.directServedAt)

export const canNhisClaimBeServedDirectly = ({ claim = null, role = '' } = {}) => {
  if (!NHIS_DIRECT_SERVING_ROLES.has(normalizeNhisServingStatus(role))) return false
  if (!claim) return true
  if (isNhisClaimDirectlyServed(claim)) return false
  return NHIS_DIRECT_SERVING_STATUSES.has(normalizeNhisServingStatus(claim.status))
}

export const canCorrectDirectServedNhisMedicine = ({ claim = null, role = '' } = {}) =>
  NHIS_DIRECT_SERVING_ROLES.has(normalizeNhisServingStatus(role)) &&
  isNhisClaimDirectlyServed(claim)

export const markNhisMedicineFullyServed = (medicine = {}) => {
  const prescribedQty = toNumber(
    medicine?.prescribedQty ??
    medicine?.prescribed_qty ??
    medicine?.dispensedQty ??
    medicine?.dispensed_qty
  )

  return {
    ...medicine,
    prescribedQty,
    servedQty: prescribedQty,
    dispensedQty: prescribedQty,
    servingStatus: normalizeMedicineLineServingStatus('fully_served', prescribedQty, prescribedQty),
    reasonIfNotFullyServed: '',
  }
}

export const canMcaOpenNhisClaimForServing = (claimOrStatus = '') => {
  if (claimOrStatus && typeof claimOrStatus === 'object') {
    if (isNhisClaimDirectlyServed(claimOrStatus)) return false
    return NHIS_MCA_OPENABLE_STATUSES.has(
      normalizeNhisServingStatus(claimOrStatus.status)
    )
  }
  return NHIS_MCA_OPENABLE_STATUSES.has(normalizeNhisServingStatus(claimOrStatus))
}

export const shouldApplyMcaEditWindowToClaim = (status = '') =>
  normalizeNhisServingStatus(status) === 'served'

const toNumber = (value) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const normalizeMedicineLineServingStatus = (value, prescribedQty = 0, servedQty = 0) => {
  const status = normalizeNhisServingStatus(value)
  if (['not_available', 'not_served'].includes(status)) return status
  if (status === 'fully_served' && servedQty >= prescribedQty) return 'fully_served'
  if (status === 'partially_served' && servedQty > 0 && servedQty < prescribedQty) return 'partially_served'
  if (servedQty <= 0) return 'pending'
  return servedQty >= prescribedQty ? 'fully_served' : 'partially_served'
}

export const markNhisMedicinesServedDirectly = (
  medicines = [],
  { actorId = '', servedAt = new Date().toISOString() } = {}
) =>
  (Array.isArray(medicines) ? medicines : []).map((medicine) => {
    const prescribedQty = toNumber(
      medicine?.prescribedQty ??
      medicine?.prescribed_qty ??
      medicine?.dispensedQty ??
      medicine?.dispensed_qty
    )
    const existingServedQty = toNumber(medicine?.servedQty ?? medicine?.served_qty)
    const servedQty = existingServedQty > 0 ? existingServedQty : prescribedQty
    const unitPrice = toNumber(medicine?.unitPrice ?? medicine?.unit_price)

    return {
      ...medicine,
      prescribedQty,
      servedQty,
      dispensedQty: servedQty,
      servingStatus: normalizeMedicineLineServingStatus('fully_served', prescribedQty, servedQty),
      servedByMca: medicine?.servedByMca || medicine?.served_by_mca || actorId || '',
      servedAt: medicine?.servedAt || medicine?.served_at || servedAt,
      totalAmount: unitPrice * servedQty,
    }
  })
