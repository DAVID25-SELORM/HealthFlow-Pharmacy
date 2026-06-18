const DEFAULT_RETURN_ALERT_WINDOW_HOURS = 24
const DEFAULT_RETURN_ALERT_ROLES = ['admin', 'claims_officer', 'assistant']
export const NHIS_RETURN_ALERT_REASONS = [
  'Follow-up treatment',
  'Doctor changed medicine',
  'Patient complaint',
  'Emergency',
  'Other',
]

const normalizeText = (value) => String(value || '').trim()
const normalizeLower = (value) => normalizeText(value).toLowerCase()
const digitsOnly = (value) => normalizeText(value).replace(/\D/g, '')

const normalizeMemberNumber = (value) => normalizeText(value).toUpperCase().replace(/\s+/g, '')
const normalizePhone = (value) => {
  const digits = digitsOnly(value)
  return digits.length >= 9 ? digits.slice(-9) : ''
}

const toDate = (value) => {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const getClaimDate = (claim = {}) =>
  toDate(
    claim.service_date_from ||
      claim.serviceDateFrom ||
      claim.service_date ||
      claim.serviceDate ||
      claim.created_at ||
      claim.createdAt
  )

export const normalizeNhisReturnAlertSettings = (settings = {}) => {
  const windowHours = Number(
    settings.nhisReturnAlertWindowHours ??
      settings.nhis_return_alert_window_hours ??
      DEFAULT_RETURN_ALERT_WINDOW_HOURS
  )
  const roles = Array.isArray(settings.allowedRoles)
    ? settings.allowedRoles
    : Array.isArray(settings.nhisReturnAlertAllowedRoles)
    ? settings.nhisReturnAlertAllowedRoles
    : Array.isArray(settings.nhis_return_alert_allowed_roles)
      ? settings.nhis_return_alert_allowed_roles
      : DEFAULT_RETURN_ALERT_ROLES

  return {
    enabled: settings.nhisReturnAlertEnabled ?? settings.nhis_return_alert_enabled ?? true,
    windowHours: [6, 12, 24, 48].includes(windowHours) ? windowHours : DEFAULT_RETURN_ALERT_WINDOW_HOURS,
    requireReason: settings.nhisReturnAlertRequireReason ?? settings.nhis_return_alert_require_reason ?? true,
    allowedRoles: roles.map(normalizeLower).filter(Boolean),
  }
}

export const getNhisPatientReturnIdentifiers = (patient = {}) => {
  const hin = normalizeMemberNumber(patient.hin || patient.nhis_hin)
  const memberNo = normalizeMemberNumber(
    patient.memberNo ||
      patient.member_no ||
      patient.nhis_member_no ||
      patient.insurance_id
  )
  const ghanaCard = memberNo.startsWith('GHA') ? memberNo : ''
  const phone = normalizePhone(patient.phone || patient.mobile || patient.contact)

  return {
    hin,
    memberNo,
    ghanaCard,
    phone,
  }
}

const getClaimIdentifiers = (claim = {}) =>
  getNhisPatientReturnIdentifiers({
    hin: claim.hin,
    memberNo: claim.member_no || claim.memberNo,
    nhis_member_no: claim.nhis_member_no,
    insurance_id: claim.insurance_id,
    phone: claim.phone || claim.patient_phone || claim.patients?.phone,
  })

const getMatchType = (currentIdentifiers, previousIdentifiers) => {
  if (currentIdentifiers.hin && currentIdentifiers.hin === previousIdentifiers.hin) return 'HIN'
  if (currentIdentifiers.memberNo && currentIdentifiers.memberNo === previousIdentifiers.memberNo) return 'NHIS membership number'
  if (currentIdentifiers.ghanaCard && currentIdentifiers.ghanaCard === previousIdentifiers.ghanaCard) return 'Ghana Card number'
  if (currentIdentifiers.phone && currentIdentifiers.phone === previousIdentifiers.phone) return 'phone'
  return ''
}

const getMedicineCode = (medicine = {}) =>
  normalizeMemberNumber(medicine.drugCode || medicine.drug_code || medicine.nhiaCode || medicine.nhia_code)

const getMedicineSummaryKey = (medicine = {}) => normalizeMemberNumber(medicine.code) || normalizeLower(medicine.name)

export const summarizeNhisMedicines = (medicines = []) =>
  (Array.isArray(medicines) ? medicines : []).map((medicine) => ({
    code: getMedicineCode(medicine),
    name: normalizeText(medicine.description || medicine.drugName || medicine.drug_name || medicine.name || 'Medicine'),
    quantity: Number(medicine.dispensed_qty ?? medicine.dispensedQty ?? medicine.quantity ?? 0),
  }))

const getClaimMedicines = (claim = {}) =>
  claim.nhis_claim_medicines || claim.medicines || claim.items || []

const compareMedicines = (previousMedicines = [], currentMedicines = []) => {
  const previousKeys = new Set(summarizeNhisMedicines(previousMedicines).map(getMedicineSummaryKey).filter(Boolean))
  const currentSummaries = summarizeNhisMedicines(currentMedicines)
  const repeated = currentSummaries.filter((medicine) => previousKeys.has(getMedicineSummaryKey(medicine)))
  return {
    sameMedicationRepeated: repeated.length > 0,
    repeatedMedicines: repeated,
  }
}

export const findNhisPatientReturnAlert = ({
  currentPatient = {},
  currentMedicines = [],
  claims = [],
  now = new Date(),
  settings = {},
  editingClaimId = '',
} = {}) => {
  const normalizedSettings = normalizeNhisReturnAlertSettings(settings)
  if (!normalizedSettings.enabled) return null

  const currentIdentifiers = getNhisPatientReturnIdentifiers(currentPatient)
  const hasStrongIdentifier = Boolean(currentIdentifiers.hin || currentIdentifiers.memberNo || currentIdentifiers.ghanaCard)
  const hasFallbackIdentifier = Boolean(currentIdentifiers.phone)
  if (!hasStrongIdentifier && !hasFallbackIdentifier) return null

  const currentDate = toDate(now) || new Date()
  const windowMs = normalizedSettings.windowHours * 60 * 60 * 1000
  const matches = (Array.isArray(claims) ? claims : [])
    .filter((claim) => normalizeText(claim.id) !== normalizeText(editingClaimId))
    .map((claim) => {
      const previousDate = getClaimDate(claim)
      if (!previousDate) return null
      const diffMs = currentDate.getTime() - previousDate.getTime()
      if (diffMs < 0 || diffMs > windowMs) return null
      const matchType = getMatchType(currentIdentifiers, getClaimIdentifiers(claim))
      if (!matchType) return null
      const medicineComparison = compareMedicines(getClaimMedicines(claim), currentMedicines)
      return {
        previousClaim: claim,
        previousVisitAt: previousDate.toISOString(),
        currentVisitAt: currentDate.toISOString(),
        hoursSincePrevious: Math.round((diffMs / (60 * 60 * 1000)) * 10) / 10,
        minutesSincePrevious: Math.round(diffMs / (60 * 1000)),
        matchType,
        previousMedicines: summarizeNhisMedicines(getClaimMedicines(claim)),
        currentMedicines: summarizeNhisMedicines(currentMedicines),
        ...medicineComparison,
      }
    })
    .filter(Boolean)
    .sort((left, right) => new Date(right.previousVisitAt) - new Date(left.previousVisitAt))

  return matches[0] || null
}

export const canContinueNhisReturnAlert = (role, settings = {}) => {
  const normalizedSettings = normalizeNhisReturnAlertSettings(settings)
  return normalizedSettings.allowedRoles.includes(normalizeLower(role))
}
