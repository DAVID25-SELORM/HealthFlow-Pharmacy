// Compatibility baseline: the genuine May Claim-IT export supplied as the
// structural and serialization reference. No unverified June artifact is used.
// No patient, provider, or signer values belong here.
export const CLAIM_IT_PROFILE = Object.freeze({
  serializerVersion: 'claimit-compat-v1',
  profile: 'claimit-2025053123',
  serviceVersion: '2023-02-01.250531',
  medicineVersion: '2025-05-01.250531',
  policyVersion: 'cgs.2022-12-01.250531',
  appVersion: Object.freeze({
    version: 'Head', build: '2025053123', type: 'head',
    sha1: 'bebe76e96864d0f25d3514e5916816aadc34cff4',
    client: '1.0.0.3', mode: 'standalone', cpuType: 'x64',
  }),
})

export const CLAIM_IT_CLAIM_FIELD_ORDER = Object.freeze([
  'guid', 'isException', 'claimCheckCode', 'preAuthorizationCodes', 'physicianID',
  'specialtyAttended', 'totalCost', 'procCost', 'diagCost', 'inveCost', 'medCost',
  'principalGDRG', 'alternativeGDRG', 'autoSummaryGDRG', 'autoSummaryCost',
  'memberAge', 'memberAgeGroup', 'isImported', 'refID', 'medVersion', 'servVersion',
  'policyVersion', 'isDirty', 'status', 'claimType', 'submissionTime', 'extraData',
  'addedOn', 'addedByname', 'addedByuserID', 'addedByrole', 'modifiedOn',
  'modifiedByname', 'modifiedByuserID', 'modifiedByrole', 'signedOn',
  'signedByname', 'signedByuserID', 'signedByrole', 'memberNo', 'cardSerialNo',
  'surname', 'otherNames', 'dateOfBirth', 'gender', 'hospitalRecNo', 'isDependant',
  'prescriptionLevelID', 'credentialCode', 'accred_effectiveDate', 'accred_providerID',
  'accred_ccd_agencyCode', 'accred_ccd_regionCode', 'accred_ccd_districtCode',
  'accred_ccd_ownershipCode', 'accred_ccd_sequenceNumber', 'accred_ccd_facilityTypeCode',
  'accred_ccd_prescriptionLevelCode', 'accred_ccd_cateringStatusCode',
  'accred_ccd_effectiveDate', 'facilityTypeCode', 'ownershipTypeCode', 'cateringStatusCode',
  'refclaimCheckCode', 'reffacilityID', 'reffacilityName', 'minDOSP', 'maxDOSP',
  'serviceProvisionDates', 'specialtiesAttended', 'durationOfSpell', 'typeOfService',
  'isUnbundled', 'includesPharmacy', 'typeOfAttendance', 'serviceOutcome',
])

export function orderedRecord(record, fields = CLAIM_IT_CLAIM_FIELD_ORDER) {
  if (Object.keys(record).length !== fields.length || fields.some((key) => !Object.hasOwn(record, key))) {
    throw new Error('Claim-IT schema mismatch: missing or unexpected fields')
  }
  return Object.fromEntries(fields.map((key) => [key, record[key]]))
}

// Match the May reference: medicine-only exports carry a null service version;
// service-bearing claims carry the configured service tariff version.
export function claimItServiceVersion({ serviceCount = 0, configuredVersion = '' } = {}) {
  return serviceCount > 0 ? (configuredVersion || CLAIM_IT_PROFILE.serviceVersion) : null
}

// Base-ten integer arithmetic. Round half away from zero only at the requested
// currency boundary, never during addition of unrounded values.
export function decimalUnits(value, scale = 2) {
  const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?$/)
  if (!match || !Number.isInteger(scale) || scale < 0 || scale > 8) throw new Error('Invalid decimal amount')
  const fraction = match[3] || ''
  let units = BigInt(match[2]) * 10n ** BigInt(scale) + BigInt(fraction.slice(0, scale).padEnd(scale, '0') || '0')
  if (Number(fraction[scale] || 0) >= 5) units += 1n
  return match[1] ? -units : units
}

export function formatUnits(units, scale = 2) {
  const sign = units < 0n ? '-' : ''
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0')
  return scale ? `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}` : `${sign}${digits}`
}

export const decimalAmount = (value, scale = 2) => formatUnits(decimalUnits(value, scale), scale)
export const sumAmounts = (values, scale = 2) => formatUnits(values.reduce((sum, value) => sum + decimalUnits(value, scale), 0n), scale)

export function accreditationIssues({ generated, expiry, effective, today }) {
  const issues = []
  for (const [key, value] of Object.entries({ generated, expiry, effective })) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      issues.push(`ACCREDITATION_INVALID_${key.toUpperCase()}`)
    }
  }
  if (generated && today && generated > today) issues.push('ACCREDITATION_GENERATED_IN_FUTURE')
  if (generated && expiry && generated > expiry) issues.push('ACCREDITATION_GENERATED_AFTER_EXPIRY')
  if (effective && expiry && effective > expiry) issues.push('ACCREDITATION_EFFECTIVE_AFTER_EXPIRY')
  // Equality is suspicious, not proof that an external record is wrong.
  if (generated && generated === expiry) issues.push('ACCREDITATION_DATE_REVIEW_REQUIRED')
  return issues
}

export const SIGNER_FIELDS = Object.freeze(['signedOn', 'signedByname', 'signedByuserID', 'signedByrole'])
export const LEGACY_UNSIGNED_CLAIM = 'LEGACY_UNSIGNED_CLAIM'

// Signing is a HealthFlow audit requirement, NOT a Claim-IT compatibility
// requirement: the accepted June export carried null signer fields on every claim.
// Never throw and never invent a signer; report so the UI/audit can surface it.
export function classifyClaimSignature(claim) {
  const missing = SIGNER_FIELDS.filter((key) => !String(claim?.[key] ?? '').trim())
  const invalidTimestamp = !missing.includes('signedOn') && !Number.isFinite(Date.parse(claim.signedOn))
  const future = !missing.includes('signedOn') && !invalidTimestamp && Date.parse(claim.signedOn) > Date.now()
  const warnings = []
  if (missing.length) warnings.push(LEGACY_UNSIGNED_CLAIM)
  if (invalidTimestamp) warnings.push('SIGNED_ON_INVALID')
  if (future) warnings.push('SIGNED_ON_IN_FUTURE')
  return { complete: missing.length === 0 && !invalidTimestamp && !future, missing, warnings }
}
