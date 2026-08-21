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
  assignedRoles = [],
} = {}) => {
  const roles = [activeRole, ...(Array.isArray(assignedRoles) ? assignedRoles : [])]
  return roles.some((role) => PRIVILEGED_CORRECTION_ROLES.has(normalizeRole(role)))
}

// Corrections remain available throughout the internal workflow, but never
// silently rewrite a claim once its external submission is final.
export const canCorrectNhisClaimStatus = (status = '') =>
  !FINAL_EXTERNAL_NHIS_STATUSES.has(normalizeRole(status))
