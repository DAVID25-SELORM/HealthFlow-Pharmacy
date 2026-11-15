// Same normalisation as normalizeNhisCcCode in nhisService.js (digits only), kept local
// so this rule stays a small, dependency-free module.
const normalizeNhisCcCode = (value) => String(value ?? '').replace(/\D/g, '')

// NHIS-006: an NHIS sale at the point of sale needs a valid 5-digit CCC/CC code.
// Cashiers cannot complete the sale without one. A manager, admin or claims
// officer can complete it without a code when NHIA is unavailable, but must give
// a short reason, which is written into the review claim notes for audit.
// (NHIS-005 is the matching rule for the claim form.)
export const NHIS_POS_CCC_OVERRIDE_ROLES = Object.freeze(['admin', 'super_admin', 'claims_officer', 'branch_manager'])
export const NHIS_POS_CCC_OVERRIDE_REASON_MIN_LENGTH = 5
export const NHIS_POS_CCC_OVERRIDE_REASON_MAX_LENGTH = 200

const normalizeRole = (role) => String(role || '').trim().toLowerCase()

// The active role is authoritative: do not inherit a more privileged assigned role.
export const canOverrideNhisPosCcc = (role) => NHIS_POS_CCC_OVERRIDE_ROLES.includes(normalizeRole(role))

export const normalizeNhisPosCccOverrideReason = (reason) =>
  String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, NHIS_POS_CCC_OVERRIDE_REASON_MAX_LENGTH)

export const getNhisPosCccIssue = ({ cccNo = '', role = '', overrideReason = '' } = {}) => {
  const digits = normalizeNhisCcCode(cccNo)

  if (digits) {
    return digits.length === 5 ? '' : 'CCC / CC Code must contain exactly 5 digits.'
  }

  if (canOverrideNhisPosCcc(role)) {
    return normalizeNhisPosCccOverrideReason(overrideReason).length >= NHIS_POS_CCC_OVERRIDE_REASON_MIN_LENGTH
      ? ''
      : `CCC / CC Code is required for an NHIS sale. Enter the 5-digit code from NHIA, or give a reason (at least ${NHIS_POS_CCC_OVERRIDE_REASON_MIN_LENGTH} characters) to complete without it.`
  }

  return 'CCC / CC Code is required for an NHIS sale. Enter the 5-digit code from NHIA. If NHIA is unavailable, ask a manager, admin or claims officer to complete the sale.'
}

// The line added to the review claim notes when a sale is completed without a code.
export const buildNhisPosCccOverrideNote = ({ cccNo = '', role = '', overrideReason = '', actorLabel = '' } = {}) => {
  if (normalizeNhisCcCode(cccNo)) return ''
  if (!canOverrideNhisPosCcc(role)) return ''

  const reason = normalizeNhisPosCccOverrideReason(overrideReason)
  if (reason.length < NHIS_POS_CCC_OVERRIDE_REASON_MIN_LENGTH) return ''

  const actor = String(actorLabel ?? '').replace(/\s+/g, ' ').trim()
  return `CC code completed without a code at POS by ${normalizeRole(role)}${actor ? ` (${actor})` : ''}. Reason: ${reason}`
}
