// Personal data should not be copied in full into the audit trail.
//
// The audit trail answers "who did what, to which record, and when". The record id
// already says which record, so full phone numbers, member numbers, Ghana Card
// numbers and clinical text do not need to be repeated inside the details.
//
// Deliberately NOT masked: `patient_name` and `full_name`. The Activity Log shows
// them as the "Patient" / "Staff member" subject, and that display is already
// restricted to people allowed to identify the person
// (see supabase/migrations/20260913120000_activity_log_subjects_and_scope.sql).

const REDACTED = '[REDACTED]'
const MAX_DEPTH = 4

// Identifiers: keep the last few characters so a reviewer can still tell two
// entries apart, but cannot read the whole number.
const PARTIAL_KEY = /(phone|telephone|mobile|member_?(no|number|id)|ghana_?card|national_?id|\bhin\b|(^|_)hin(_|$)|card_?(no|number)|nhis_?(no|number))/i

// Free text and clinical or contact detail: not needed in an audit entry at all.
const FULL_KEY = /(diagnos|clinical|(^|_)notes?(_|$)|address|date_of_birth|(^|_)dob(_|$)|allerg|symptom)/i

const KEEP_LAST = 3

const maskIdentifier = (value) => {
  const text = String(value ?? '').trim()
  if (!text) return value
  if (text.startsWith('*')) return text
  if (text.length <= KEEP_LAST) return '*'.repeat(text.length)
  return `${'*'.repeat(text.length - KEEP_LAST)}${text.slice(-KEEP_LAST)}`
}

export const maskAuditPersonalData = (value, depth = 0) => {
  if (depth > MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((entry) => maskAuditPersonalData(entry, depth + 1))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const isEmpty = entry === null || entry === undefined || entry === ''
      if (!isEmpty && typeof entry !== 'object' && typeof entry !== 'boolean') {
        if (FULL_KEY.test(key)) return [key, REDACTED]
        if (PARTIAL_KEY.test(key)) return [key, maskIdentifier(entry)]
      }
      if (!isEmpty && typeof entry === 'object' && FULL_KEY.test(key)) return [key, REDACTED]
      return [key, maskAuditPersonalData(entry, depth + 1)]
    })
  )
}
