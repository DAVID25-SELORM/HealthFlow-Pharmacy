const NHIS_SERVING_REVIEW_FINALIZABLE_STATUSES = new Set([
  'returned_for_review',
  'partially_served',
  'fully_served',
])

export const shouldFinalizeNhisServingReview = (status = '') =>
  NHIS_SERVING_REVIEW_FINALIZABLE_STATUSES.has(String(status || '').trim().toLowerCase())

