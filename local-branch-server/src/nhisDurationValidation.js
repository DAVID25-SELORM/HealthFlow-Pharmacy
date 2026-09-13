// Shared save-time rule. Draft intake may be incomplete, serving may not.
export const isValidNhisDuration = (value) => {
  const match = String(value ?? '').trim().match(/^([1-9]\d*) (day|days|week|weeks|month|months)$/)
  if (!match || !Number.isSafeInteger(Number(match[1]))) return false
  return Number(match[1]) === 1 ? ['day', 'week', 'month'].includes(match[2]) : ['days', 'weeks', 'months'].includes(match[2])
}
export const assertNhisDurationForSavedState = (claim = {}) => {
  const medicines = claim.nhis_claim_medicines || claim.medicines || []
  const serving = ['fully_served', 'partially_served'].includes(claim.serving_status ?? claim.servingStatus)
    || medicines.some(m => Number(m.served_qty ?? m.servedQty ?? 0) > 0 || ['fully_served', 'partially_served'].includes(m.serving_status ?? m.servingStatus))
  if (claim.status === 'draft' && !serving) return
  medicines.forEach((medicine, index) => {
    if (!isValidNhisDuration(medicine.duration)) {
      const error = new Error(`Medicine ${index + 1}: valid duration is required before completing or serving this claim. Keep incomplete intake as Draft.`)
      error.status = 422
      error.code = 'NHIS_DURATION_REQUIRED'
      throw error
    }
  })
}
