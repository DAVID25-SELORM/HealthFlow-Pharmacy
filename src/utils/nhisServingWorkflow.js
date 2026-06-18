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

const normalizeNhisServingStatus = (status = '') =>
  String(status || '').trim().toLowerCase()

export const shouldFinalizeNhisServingReview = (status = '') =>
  NHIS_SERVING_REVIEW_FINALIZABLE_STATUSES.has(normalizeNhisServingStatus(status))

export const canMcaOpenNhisClaimForServing = (status = '') =>
  NHIS_MCA_OPENABLE_STATUSES.has(normalizeNhisServingStatus(status))

export const shouldApplyMcaEditWindowToClaim = (status = '') =>
  normalizeNhisServingStatus(status) === 'served'
