// Shared by the browser and local server; the cloud enforces the same rule in SQL.
export const getNhisCccTransitionIssue = (claim = {}) => {
  const value = String(claim.cccNo ?? claim.ccc_no ?? claim.ccCode ?? claim.cc_code ?? '').replace(/\D/g, '')
  if (!value) return 'CCC/CC code is required before completing or serving this NHIS claim.'
  return /^[0-9]{5}$/.test(value) ? '' : 'CCC/CC code must contain exactly 5 digits.'
}
export const assertNhisCccForProgress = (claim) => {
  const issue = getNhisCccTransitionIssue(claim)
  if (issue) { const error = new Error(issue); error.status = 422; error.code = 'NHIS_CCC_REQUIRED'; throw error }
}
export const assertNhisCccForSavedState = (claim = {}) => {
  const protectedStates = ['served', 'claim_ready', 'partially_served', 'fully_served', 'submitted', 'approved', 'accepted', 'paid']
  const hasServedMedicines = (claim.nhis_claim_medicines || []).some(medicine => Number(medicine.served_qty ?? medicine.servedQty ?? 0) > 0 || ['fully_served', 'partially_served'].includes(medicine.serving_status ?? medicine.servingStatus))
  if (hasServedMedicines || protectedStates.includes(claim.status) || ['fully_served', 'partially_served'].includes(claim.serving_status ?? claim.servingStatus)) assertNhisCccForProgress(claim)
}
