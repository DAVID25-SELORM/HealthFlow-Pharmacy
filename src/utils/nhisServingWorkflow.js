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
