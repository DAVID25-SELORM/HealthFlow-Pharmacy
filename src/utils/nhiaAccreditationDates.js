// Accreditation date rules shared by Settings, Offline Sync and the export path.
//
// The three accreditation dates are independent facts on the NHIA accreditation
// record and are NEVER derived from each other (West Point legitimately has
// effective 2025-12-01, generated 2025-12-29, expiry 2027-12-01):
//   effective  - derived from the credential code (not stored separately)
//   generated  - stored: nhia_configuration.accreditation_date_generated
//   expiry     - stored: nhia_configuration.accreditation_expiry_date
// Nothing in this module normalizes one date into another or supplies a fallback.
// A missing generated date is reported, never filled in.

export const ACCREDITATION_GENERATED_MISSING = 'ACCREDITATION_GENERATED_MISSING'
export const ACCREDITATION_GENERATED_INVALID = 'ACCREDITATION_GENERATED_INVALID'
export const ACCREDITATION_EXPIRY_MISSING = 'ACCREDITATION_EXPIRY_MISSING'
export const ACCREDITATION_EXPIRY_INVALID = 'ACCREDITATION_EXPIRY_INVALID'
export const ACCREDITATION_DATE_REVIEW_REQUIRED = 'ACCREDITATION_DATE_REVIEW_REQUIRED'
export const ACCREDITATION_GENERATED_IN_FUTURE = 'ACCREDITATION_GENERATED_IN_FUTURE'
export const ACCREDITATION_GENERATED_AFTER_EXPIRY = 'ACCREDITATION_GENERATED_AFTER_EXPIRY'
export const ACCREDITATION_GENERATED_BEFORE_EFFECTIVE = 'ACCREDITATION_GENERATED_BEFORE_EFFECTIVE'

export const ACCREDITATION_GENERATED_MISSING_MESSAGE =
  "NHIA accreditation generated/issue date is missing. Open Settings → NHIA configuration and enter the date shown on the facility's NHIA accreditation record."
export const ACCREDITATION_EXPIRY_MISSING_MESSAGE =
  "NHIA accreditation expiry date is missing. Open Settings → NHIA configuration and enter the expiry date shown on the facility's NHIA accreditation record."
export const ACCREDITATION_GENERATED_HELPER_TEXT =
  'Enter the accreditation generated/issue date exactly as shown on the NHIA accreditation record.'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const MIN_YEAR = 2000
const MAX_YEAR = 2100

const text = (value) => String(value ?? '').trim()

// Strict calendar check: a real YYYY-MM-DD date in a plausible range.
export const isValidAccreditationDate = (value) => {
  const match = ISO_DATE.exec(text(value))
  if (!match) return false
  const [, year, month, day] = match.map(Number)
  if (year < MIN_YEAR || year > MAX_YEAR) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

// The credential code's ninth segment is the accreditation effective date as
// DDMMYY (e.g. ...-011025 => 2025-10-01). Display only; it is not stored separately.
export const getAccreditationEffectiveDateFromCredentialCode = (credentialCode = '') => {
  const code = text(credentialCode).split('-')[8] || ''
  if (!/^\d{6}$/.test(code)) return ''
  const iso = `20${code.slice(4, 6)}-${code.slice(2, 4)}-${code.slice(0, 2)}`
  return isValidAccreditationDate(iso) ? iso : ''
}

const todayIso = () => new Date().toISOString().slice(0, 10)

/**
 * @param {{generated?: string, expiry?: string, effective?: string, today?: string, requireGenerated?: boolean, requireExpiry?: boolean}} input
 * @returns {Array<{code: string, severity: 'error'|'warning', message: string, diagnostic: string, field: 'generated'|'expiry'}>}
 *   Errors are missing/malformed values. Everything else is a warning: it never
 *   corrects or blocks anything on its own.
 */
export function getAccreditationDateIssues({
  generated = '', expiry = '', effective = '', today = todayIso(), requireGenerated = false, requireExpiry = false,
} = {}) {
  const [g, e, f] = [text(generated), text(expiry), text(effective)]
  const issues = []
  const add = (code, severity, field, message, diagnostic = message) => issues.push({ code, severity, field, message, diagnostic })

  if (!g) {
    if (requireGenerated) add(ACCREDITATION_GENERATED_MISSING, 'error', 'generated', ACCREDITATION_GENERATED_MISSING_MESSAGE)
  } else if (!isValidAccreditationDate(g)) {
    add(ACCREDITATION_GENERATED_INVALID, 'error', 'generated', 'The accreditation generated/issue date is not a valid date.')
  }
  if (!e) {
    if (requireExpiry) add(ACCREDITATION_EXPIRY_MISSING, 'error', 'expiry', ACCREDITATION_EXPIRY_MISSING_MESSAGE)
  } else if (!isValidAccreditationDate(e)) {
    add(ACCREDITATION_EXPIRY_INVALID, 'error', 'expiry', 'The accreditation expiry date is not a valid date.')
  }

  const gValid = isValidAccreditationDate(g)
  if (gValid && isValidAccreditationDate(e) && g === e) {
    // Suspicious, not proven wrong: verify against the source record. Never auto-corrected.
    add(ACCREDITATION_DATE_REVIEW_REQUIRED, 'warning', 'generated',
      'Generated date is the same as expiry date. Please verify this against the NHIA accreditation record.',
      'Generated date matches expiry date. Verify against original NHIA accreditation record.')
  }
  if (gValid && isValidAccreditationDate(e) && g > e) {
    add(ACCREDITATION_GENERATED_AFTER_EXPIRY, 'warning', 'generated',
      'Generated date is after the expiry date. Please verify both dates against the NHIA accreditation record.')
  }
  if (gValid && text(today) && g > today) {
    add(ACCREDITATION_GENERATED_IN_FUTURE, 'warning', 'generated',
      'Generated date is in the future. Please verify it against the NHIA accreditation record.')
  }
  if (gValid && isValidAccreditationDate(f) && g < f) {
    add(ACCREDITATION_GENERATED_BEFORE_EFFECTIVE, 'warning', 'generated',
      'Generated date is earlier than the accreditation effective date. Please verify it against the NHIA accreditation record.')
  }
  return issues
}

// Human-readable text for a technical export-configuration field name, so normal
// users never see internal identifiers.
export const CLAIMIT_MISSING_FIELD_LABELS = Object.freeze({
  accreditationDateGenerated: 'accreditation generated/issue date',
  accreditationExpiryDate: 'accreditation expiry date',
  facilityName: 'facility name',
  providerNumber: 'provider number',
  facilityCode: 'facility code',
  credentialCode: 'CLAIM-it credential code',
  providerClassLevel: 'hospital provider class/level',
  pharmacyFacilityLevel: 'pharmacy service level',
  providerLevelCode: 'provider level code',
  claimsOfficerName: 'claims officer name',
})

const CONFIG_HINT = "Open Settings → NHIA configuration and complete them from the facility's NHIA accreditation record."

export function describeIncompleteClaimItConfiguration(missing = []) {
  const fields = [...new Set(missing)]
  if (fields.length === 1 && fields[0] === 'accreditationDateGenerated') return ACCREDITATION_GENERATED_MISSING_MESSAGE
  if (fields.length === 1 && fields[0] === 'accreditationExpiryDate') return ACCREDITATION_EXPIRY_MISSING_MESSAGE
  const labels = fields.map((field) => CLAIMIT_MISSING_FIELD_LABELS[field] || field.replace(/\(.*\)/, '').trim())
  const dateNote = fields.includes('accreditationDateGenerated')
    ? ' The accreditation generated/issue date is the date shown on the NHIA accreditation record.' : ''
  return `CLAIM-it CXF export needs complete NHIA configuration. Missing: ${labels.join(', ')}. ${CONFIG_HINT}${dateNote}`
}
