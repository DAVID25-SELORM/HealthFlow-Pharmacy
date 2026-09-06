const PRIVILEGED_CORRECTION_ROLES = new Set(['admin', 'claims_officer'])

const FINAL_EXTERNAL_NHIS_STATUSES = new Set([
  'submitted',
  'paid',
  'approved',
  'accepted',
])

const normalizeRole = (role) => String(role || '').trim().toLowerCase()

export const canPrivilegedCorrectNhisClaim = ({
  activeRole = '',
} = {}) => {
  // Every tier-access request sends the selected active role and the server
  // enforces that role. Do not silently inherit a more privileged assigned
  // role while the user is actively working as an Assistant or Billing user.
  return PRIVILEGED_CORRECTION_ROLES.has(normalizeRole(activeRole))
}

// Corrections remain available throughout the internal workflow, but never
// silently rewrite a claim once its external submission is final.
export const canCorrectNhisClaimStatus = (status = '') =>
  !FINAL_EXTERNAL_NHIS_STATUSES.has(normalizeRole(status))
