import crypto from 'node:crypto'
import https from 'node:https'
import { createId, db, json, nowIso, parseJson } from './db.js'
import { config } from './config.js'
import { getNhiaMemberLookupFailureMessage } from './nhiaFeedback.js'
import { getOfflineRecord } from './offlineRecordsRepository.js'

const CLAIM_STATUSES = new Set([
  'draft',
  'ready',
  'submitted',
  'accepted',
  'rejected',
  'paid',
  'failed',
])

const CREDENTIAL_MODES = new Set([
  'api_key',
  // ✅ NHIA API ARCHITECTURE PATCH START
  'claimit_token',
  'bearer_token',
  'basic_auth',
  'oauth_client',
  'custom',
  // ✅ NHIA API ARCHITECTURE PATCH END
])

const EXPORT_FORMATS = new Set(['cxf', 'json', 'xml'])
const INTEGRATION_MODE_ALIASES = {
  cxf_export: 'claimit_export',
  claimit_export: 'claimit_export',
  claimit_assisted: 'claimit_assisted',
  claimit_local_bridge: 'claimit_bridge',
  claimit_bridge: 'claimit_bridge',
  direct_nhia: 'direct_nhia_api',
  direct_nhia_api: 'direct_nhia_api',
  hybrid: 'hybrid',
}
const DEFAULT_NHIS_MEMBER_DIGITS = 8
const DEFAULT_GHANA_CARD_DIGITS = 10
const DEFAULT_NHIA_API_BASE_URL = 'https://elig.nhia.gov.gh:5000'
const DEFAULT_CLAIMIT_SUBMIT_BASE_URL = 'http://localhost:31719/json-api'
const DEFAULT_NHIA_MEMBER_LOOKUP_ENDPOINT = '/api/hmis/genCCC'
const DEFAULT_CLAIMIT_CLAIM_ENDPOINT = '/claims'
const DEFAULT_NHIA_INTEGRATION_MODE = 'claimit_assisted'
const MAX_NHIA_CLAIM_READ_LIMIT = 100000
const CLAIMIT_CXF_API_BLOCK_MESSAGE =
  'Direct CLAIM-it CXF import is not allowed by the API. Please export the CXF file and import it manually into CLAIM-it.'
const CLAIMIT_MISSING_CLAIM_ID_MESSAGE =
  'CLAIM-it claimID is missing. Regenerate or repair the claim before direct API submission.'
const SUPABASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i
const NHIS_SERVICE_TIME_ZONE = 'Africa/Accra'
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DMY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

const toNhisCalendarDate = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: NHIS_SERVICE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const part = (type) => parts.find((item) => item.type === type)?.value || ''
    return [part('year'), part('month'), part('day')].filter(Boolean).join('-')
  } catch {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-')
  }
}

const normalizeNhiaServiceDate = (value) => {
  const raw = normalizeText(value)
  if (!raw) return ''
  if (ISO_DATE_PATTERN.test(raw)) return raw
  const dmy = raw.match(DMY_DATE_PATTERN)
  if (dmy) {
    const [, day, month, year] = dmy
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  return toNhisCalendarDate(raw)
}
const DIAGNOSIS_TREATMENT_RULES = [
  {
    label: 'Malaria',
    diagnosis: ['malaria'],
    treatments: ['artem', 'lumefantrine', 'amodiaquine', 'artesunate', 'quinine', 'sulfadoxine', 'pyrimethamine'],
  },
  {
    label: 'Hypertension',
    diagnosis: ['hypertension', 'blood pressure'],
    treatments: ['amlodipine', 'nifedipine', 'lisinopril', 'losartan', 'bendro', 'atenolol', 'methyldopa', 'hydrochlorothiazide'],
  },
  {
    label: 'Diabetes',
    diagnosis: ['diabetes', 'diabetic'],
    treatments: ['metformin', 'insulin', 'glibenclamide', 'gliclazide'],
  },
  {
    label: 'Asthma',
    diagnosis: ['asthma', 'wheeze'],
    treatments: ['salbutamol', 'aminophylline', 'beclometasone', 'prednisolone', 'hydrocortisone'],
  },
  {
    label: 'Infection',
    diagnosis: ['infection', 'sepsis', 'pneumonia', 'tonsillitis', 'otitis', 'uti', 'urinary'],
    treatments: ['amoxicillin', 'ampicillin', 'cefuroxime', 'ceftriaxone', 'ciprofloxacin', 'azithromycin', 'metronidazole', 'doxycycline', 'cloxacillin'],
  },
  {
    label: 'Pain or fever',
    diagnosis: ['pain', 'headache', 'fever'],
    treatments: ['paracetamol', 'ibuprofen', 'diclofenac', 'aspirin'],
  },
  {
    label: 'Diarrhoea',
    diagnosis: ['diarrhoea', 'diarrhea', 'gastroenteritis'],
    treatments: ['ors', 'zinc', 'metronidazole', 'ciprofloxacin'],
  },
  {
    label: 'Gastritis or ulcer',
    diagnosis: ['ulcer', 'gastritis', 'gerd'],
    treatments: ['omeprazole', 'ranitidine', 'antacid', 'pantoprazole'],
  },
  {
    label: 'Anaemia',
    diagnosis: ['anaemia', 'anemia'],
    treatments: ['ferrous', 'folic', 'iron'],
  },
]
const CC_CODE_KEYS = new Set([
  'cccode',
  'cc',
  'claimcode',
  'claimcertificatecode',
  'certificatecode',
  'claimitcode',
  // NHIA member verification API response field (Mobile Claims Check Code)
  'mobccc',
  'mobileccc',
  'mobileclaimcheckcode',
])

const toMoney = (value, fallback = 0) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.round(parsed * 100) / 100
}

const toBool = (value) => (value === true || value === 1 || value === '1' ? 1 : 0)

const normalizeText = (value) => String(value || '').trim()
const normalizeHttpHeaderValue = (value) => {
  let normalized = normalizeText(value).replace(/[\u0000-\u001F\u007F]/g, '')
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim()
  }
  return normalized
}

const normalizeAccreditationExpiryDate = (value) => {
  const raw = normalizeText(value)
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const isoDate = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s]/)?.[1]
  if (isoDate) return isoDate

  const localDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (localDate) {
    const [, day, month, year] = localDate
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)

  return ''
}

const getAccreditationExpiryDate = (...sources) =>
  normalizeAccreditationExpiryDate(
    sources.map((source) => {
      if (!source || typeof source !== 'object') return source
      return normalizeText(
        source.accreditationExpiryDate ||
          source.accreditationExpiry ||
          source.nhiaAccreditationExpiry ||
          source.accreditation_expiry_date ||
          source.expiryDate
      )
    }).find(Boolean)
  )

const normalizeOrganizationType = (value) =>
  normalizeText(value).toLowerCase() === 'hospital' ? 'hospital' : 'pharmacy'

const normalizeMatchText = (value) => normalizeText(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')

const digitsOnly = (value) => normalizeText(value).replace(/\D/g, '')

const compactGhanaCardValue = (value) => normalizeText(value).toUpperCase().replace(/[\s-]/g, '')

const isGhanaCardNumber = (value) => compactGhanaCardValue(value).startsWith('GHA')

const normalizeNhiaMemberNumber = (value) => {
  const memberNumber = normalizeText(value)
  if (!memberNumber) return ''

  if (!isGhanaCardNumber(memberNumber)) {
    return /^\d+$/.test(memberNumber) ? memberNumber : memberNumber.toUpperCase()
  }

  const digits = digitsOnly(compactGhanaCardValue(memberNumber).slice(3))
  return digits.length === DEFAULT_GHANA_CARD_DIGITS
    ? `GHA-${digits.slice(0, 9)}-${digits.slice(9)}`
    : compactGhanaCardValue(memberNumber)
}

const splitRuleTerms = (value) => {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean)
  }
  return normalizeText(value)
    .split(/[;,|]/)
    .map(normalizeText)
    .filter(Boolean)
}

const normalizeClinicalRule = (rule = {}) => ({
  label: normalizeText(rule.label || rule.diagnosis_label),
  diagnosis: splitRuleTerms(rule.diagnosis || rule.diagnosis_keywords),
  treatments: splitRuleTerms(rule.treatments || rule.allowed_drug_keywords),
  drugCodes: splitRuleTerms(rule.drugCodes || rule.allowed_drug_codes).map((code) => code.toUpperCase()),
  severity: normalizeText(rule.severity || 'block').toLowerCase() === 'warn' ? 'warn' : 'block',
  isActive: rule.is_active !== false && rule.isActive !== false,
})

const normalizeClinicalRules = (rules = []) =>
  (rules || [])
    .map(normalizeClinicalRule)
    .filter((rule) => rule.isActive && rule.label && rule.diagnosis.length && (rule.treatments.length || rule.drugCodes.length))

const assertRequiredText = (value, label) => {
  const normalized = normalizeText(value)
  if (!normalized) {
    throw new Error(`${label} is required.`)
  }

  return normalized
}

const assertPositiveQuantity = (value, label) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than zero.`)
  }

  return parsed
}

const toDigitLength = (value, fallback) => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30) {
    return fallback
  }

  return parsed
}

const assertValidMemberNumber = (value, settings = {}) => {
  settings = settings || {}
  const memberNumber = assertRequiredText(value, 'NHIA member number or Ghana Card number')

  if (isGhanaCardNumber(memberNumber)) {
    const compact = compactGhanaCardValue(memberNumber)
    const digits = digitsOnly(compact.slice(3))
    const requiredDigits = toDigitLength(settings.ghanaCardDigits, DEFAULT_GHANA_CARD_DIGITS)

    if (!/^GHA\d+$/.test(compact)) {
      throw new Error('Ghana Card number must start with GHA and contain only digits after the prefix.')
    }

    if (digits.length !== requiredDigits) {
      throw new Error(`Ghana Card number must contain exactly ${requiredDigits} digits after GHA.`)
    }

    return normalizeNhiaMemberNumber(memberNumber)
  }

  const requiredDigits = toDigitLength(settings.nhisMemberDigits, DEFAULT_NHIS_MEMBER_DIGITS)
  if (!/^\d+$/.test(memberNumber)) {
    throw new Error('NHIS member number must contain digits only, or enter a Ghana Card number starting with GHA.')
  }

  if (memberNumber.length !== requiredDigits) {
    throw new Error(`NHIS member number must contain exactly ${requiredDigits} digits.`)
  }

  return normalizeNhiaMemberNumber(memberNumber)
}

const normalizeCcCode = (value) => digitsOnly(normalizeText(value))

const normalizeNhisGender = (value) => {
  const gender = normalizeText(value).toLowerCase()
  if (gender === 'm' || gender === 'male') return 'male'
  if (gender === 'f' || gender === 'female') return 'female'
  if (gender === 'o' || gender === 'other') return 'other'
  return gender
}

const assertValidCcCode = (value) => {
  const ccCode = normalizeCcCode(value)
  if (!ccCode) {
    throw new Error('NHIA CCC/CC code is required.')
  }
  if (ccCode.length !== 5) {
    throw new Error('NHIA CCC/CC code must contain exactly 5 digits.')
  }
  return ccCode
}

const normalizeOptionalCcCode = (value) => {
  const ccCode = normalizeCcCode(value)
  if (!ccCode) return null
  if (ccCode.length !== 5) {
    throw new Error('NHIA CCC/CC code must contain exactly 5 digits.')
  }
  return ccCode
}

const extractCcCode = (value) => {
  if (typeof value === 'string') {
    const text = normalizeText(value)
    if (/^\d{5}$/.test(text)) {
      return normalizeOptionalCcCode(text)
    }
  }

  if (!value || typeof value !== 'object') {
    return null
  }

  const queue = [value]
  while (queue.length) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') {
      continue
    }

    for (const [key, nestedValue] of Object.entries(current)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (CC_CODE_KEYS.has(normalizedKey) && normalizeText(nestedValue)) {
        return normalizeOptionalCcCode(nestedValue)
      }

      if (nestedValue && typeof nestedValue === 'object') {
        queue.push(nestedValue)
      }
    }
  }

  return null
}

const normalizeStatus = (value, fallback = 'draft') => {
  const normalized = normalizeText(value || fallback).toLowerCase()
  if (!CLAIM_STATUSES.has(normalized)) {
    throw new Error(`NHIA claim status must be one of: ${[...CLAIM_STATUSES].join(', ')}.`)
  }

  return normalized
}

const normalizeCredentialMode = (value) => {
  const mode = normalizeText(value || 'claimit_token').toLowerCase()
  // ✅ NHIA API ARCHITECTURE PATCH START
  const legacyModeMap = {
    client_secret: 'oauth_client',
    username_password: 'basic_auth',
    certificate: 'custom',
  }
  const normalizedMode = legacyModeMap[mode] || mode
  // ✅ NHIA API ARCHITECTURE PATCH END
  if (!CREDENTIAL_MODES.has(normalizedMode)) {
    throw new Error(`NHIA credential mode must be one of: ${[...CREDENTIAL_MODES].join(', ')}.`)
  }

  return normalizedMode
}

const normalizeIntegrationMode = (value, fallback = 'claimit_export') => {
  const mode = normalizeText(value).toLowerCase()
  return INTEGRATION_MODE_ALIASES[mode] || fallback
}

const normalizeAdmissionPaymentOption = (value) => {
  const option = normalizeText(value || 'nhis_pays_admission').toLowerCase()
  return ['nhis_pays_admission', 'patient_pays_admission', 'not_applicable'].includes(option)
    ? option
    : 'nhis_pays_admission'
}

const normalizeExportFormat = (value) => {
  const format = normalizeText(value || 'xml').toLowerCase()
  if (!EXPORT_FORMATS.has(format)) {
    throw new Error('NHIA export format must be cxf, json, or xml.')
  }

  return format
}

const createClaimNumber = () => {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '')
  const randomPart = Math.random().toString(36).slice(2, 7).toUpperCase()
  return `NHIA-${datePart}-${randomPart}`
}

const createBatchNumber = () => {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '')
  const randomPart = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `NHIA-BATCH-${datePart}-${randomPart}`
}

const getDrug = db.prepare('SELECT * FROM drugs WHERE id = ?')
const getDrugByNhisCode = db.prepare('SELECT * FROM drugs WHERE UPPER(nhis_code) = UPPER(?) LIMIT 1')

const selectSettings = db.prepare(`
  SELECT *
  FROM nhia_configuration
  WHERE is_active = 1
    AND COALESCE(organization_id, '') = COALESCE(?, '')
    AND COALESCE(branch_id, '') = COALESCE(?, '')
  ORDER BY updated_at DESC
  LIMIT 1
`)

const selectAnySettings = db.prepare(`
  SELECT *
  FROM nhia_configuration
  WHERE is_active = 1
  ORDER BY updated_at DESC
  LIMIT 1
`)

const upsertSettings = db.prepare(`
  INSERT INTO nhia_configuration (
    id, organization_id, branch_id, mode, facility_code, provider_number, provider_id, hpn, hp_code,
    -- ✅ NHIA CONFIG PATCH START
    facility_type, pharmacy_facility_level, provider_level_code, credential_code,
    license_number, accreditation_expiry_date,
    -- ✅ NHIA API ARCHITECTURE PATCH START
    integration_mode, connection_profile, validation_mode, claim_control_mode, sandbox_base_url, production_base_url,
    -- ✅ NHIA API ARCHITECTURE PATCH END
    -- ✅ NHIA CONFIG PATCH END
    submitter_id,
    scheme_name, provider_type_description, provider_class_level,
    -- ✅ NHIS PHARMACY LEVEL PATCH START
    pharmacy_level,
    -- ✅ NHIS PHARMACY LEVEL PATCH END
    claims_officer_name,
    admission_payment_option, claimit_validation_enabled, claims_officer_signature_url,
    api_base_url, api_key_encrypted, api_secret_encrypted, has_api_key, has_api_secret,
    api_key_header_name, api_secret_header_name, api_key_header_prefix,
    username, password_encrypted, token_endpoint_path,
    claim_endpoint_path, claim_submit_endpoint, claim_validation_endpoint_path, cc_endpoint_path, cc_code_endpoint_path,
    claim_status_endpoint_path, claim_status_endpoint, member_lookup_endpoint_path, member_lookup_endpoint, direct_api_enabled, credential_mode,
    nhis_member_digits, ghana_card_digits, export_format,
    max_retry_attempts, is_active, created_at, updated_at, updated_by
  )
  VALUES (
    @id, @organizationId, @branchId, @mode, @facilityCode, @providerNumber, @providerId, @hpn, @hpCode,
    -- ✅ NHIA CONFIG PATCH START
    @facilityType, @pharmacyFacilityLevel, @providerLevelCode, @credentialCode,
    @licenseNumber, @accreditationExpiryDate,
    -- ✅ NHIA API ARCHITECTURE PATCH START
    @integrationMode, @connectionProfile, @validationMode, @claimControlMode, @sandboxBaseUrl, @productionBaseUrl,
    -- ✅ NHIA API ARCHITECTURE PATCH END
    -- ✅ NHIA CONFIG PATCH END
    @submitterId,
    @schemeName, @providerTypeDescription, @providerClassLevel,
    -- ✅ NHIS PHARMACY LEVEL PATCH START
    @pharmacyLevel,
    -- ✅ NHIS PHARMACY LEVEL PATCH END
    @claimsOfficerName,
    @admissionPaymentOption, @claimitValidationEnabled, @claimsOfficerSignatureUrl,
    @apiBaseUrl, @apiKeyEncrypted, @apiSecretEncrypted, @hasApiKey, @hasApiSecret,
    @apiKeyHeaderName, @apiSecretHeaderName, @apiKeyHeaderPrefix,
    @username, @passwordEncrypted, @tokenEndpointPath,
    @claimEndpointPath, @claimSubmitEndpoint, @claimValidationEndpointPath, @ccEndpointPath, @ccCodeEndpointPath,
    @claimStatusEndpointPath, @claimStatusEndpoint, @memberLookupEndpointPath, @memberLookupEndpoint, @directApiEnabled, @credentialMode,
    @nhisMemberDigits, @ghanaCardDigits, @exportFormat,
    @maxRetryAttempts, 1, @createdAt, @updatedAt, @updatedBy
  )
  ON CONFLICT(id) DO UPDATE SET
    organization_id = excluded.organization_id,
    branch_id = excluded.branch_id,
    mode = excluded.mode,
    facility_code = excluded.facility_code,
    provider_number = excluded.provider_number,
    provider_id = excluded.provider_id,
    hpn = excluded.hpn,
    hp_code = excluded.hp_code,
    -- ✅ NHIA CONFIG PATCH START
    facility_type = excluded.facility_type,
    pharmacy_facility_level = excluded.pharmacy_facility_level,
    provider_level_code = excluded.provider_level_code,
    credential_code = excluded.credential_code,
    license_number = excluded.license_number,
    accreditation_expiry_date = excluded.accreditation_expiry_date,
    -- ✅ NHIA API ARCHITECTURE PATCH START
    integration_mode = excluded.integration_mode,
    connection_profile = excluded.connection_profile,
    validation_mode = excluded.validation_mode,
    claim_control_mode = excluded.claim_control_mode,
    sandbox_base_url = excluded.sandbox_base_url,
    production_base_url = excluded.production_base_url,
    -- ✅ NHIA API ARCHITECTURE PATCH END
    -- ✅ NHIA CONFIG PATCH END
    submitter_id = excluded.submitter_id,
    scheme_name = excluded.scheme_name,
    provider_type_description = excluded.provider_type_description,
    provider_class_level = excluded.provider_class_level,
    -- ✅ NHIS PHARMACY LEVEL PATCH START
    pharmacy_level = excluded.pharmacy_level,
    -- ✅ NHIS PHARMACY LEVEL PATCH END
    claims_officer_name = excluded.claims_officer_name,
    admission_payment_option = excluded.admission_payment_option,
    claimit_validation_enabled = excluded.claimit_validation_enabled,
    claims_officer_signature_url = excluded.claims_officer_signature_url,
    api_base_url = excluded.api_base_url,
    api_key_encrypted = excluded.api_key_encrypted,
    api_secret_encrypted = excluded.api_secret_encrypted,
    has_api_key = excluded.has_api_key,
    has_api_secret = excluded.has_api_secret,
    api_key_header_name = excluded.api_key_header_name,
    api_secret_header_name = excluded.api_secret_header_name,
    api_key_header_prefix = excluded.api_key_header_prefix,
    username = excluded.username,
    password_encrypted = excluded.password_encrypted,
    token_endpoint_path = excluded.token_endpoint_path,
    claim_endpoint_path = excluded.claim_endpoint_path,
    claim_submit_endpoint = excluded.claim_submit_endpoint,
    claim_validation_endpoint_path = excluded.claim_validation_endpoint_path,
    cc_endpoint_path = excluded.cc_endpoint_path,
    cc_code_endpoint_path = excluded.cc_code_endpoint_path,
    claim_status_endpoint_path = excluded.claim_status_endpoint_path,
    claim_status_endpoint = excluded.claim_status_endpoint,
    member_lookup_endpoint_path = excluded.member_lookup_endpoint_path,
    member_lookup_endpoint = excluded.member_lookup_endpoint,
    direct_api_enabled = excluded.direct_api_enabled,
    credential_mode = excluded.credential_mode,
    nhis_member_digits = excluded.nhis_member_digits,
    ghana_card_digits = excluded.ghana_card_digits,
    export_format = excluded.export_format,
    max_retry_attempts = excluded.max_retry_attempts,
    is_active = 1,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
`)

const deletePendingNhiaConfigOutbox = db.prepare(`
  DELETE FROM sync_outbox
  WHERE event_type = 'nhia_config.updated'
    AND entity_type = 'nhia_configuration'
    AND entity_id = ?
    AND status IN ('pending', 'failed')
`)

const insertNhiaConfigOutbox = db.prepare(`
  INSERT INTO sync_outbox (
    id, event_type, entity_type, entity_id, payload_json, status, created_at, updated_at
  )
  VALUES (
    @id, 'nhia_config.updated', 'nhia_configuration', @entityId, @payloadJson, 'pending', @createdAt, @updatedAt
  )
`)

const insertClaim = db.prepare(`
  INSERT INTO nhia_claims (
    id, claim_number, local_sale_id, local_sale_number, patient_id, patient_name,
    member_number, card_type, hin, cc_code,
    nhia_auth_id, nhia_auth_type, nhia_new_ccc_status, nhia_otac, nhia_attendance_date,
    nhia_attendance_verification_status, nhia_attendance_verification_source,
    diagnosis, diagnosis_details_json, unserved_medicines_note, insurance_provider, service_date, total_amount, status,
    payload_json, organization_id, branch_id, created_by, created_at, updated_at
  )
  VALUES (
    @id, @claimNumber, @localSaleId, @localSaleNumber, @patientId, @patientName,
    @memberNumber, @cardType, @hin, @ccCode,
    @nhiaAuthId, @nhiaAuthType, @nhiaNewCccStatus, @nhiaOtac, @nhiaAttendanceDate,
    @nhiaAttendanceVerificationStatus, @nhiaAttendanceVerificationSource,
    @diagnosis, @diagnosisDetailsJson, @unservedMedicinesNote, @insuranceProvider, @serviceDate, @totalAmount, @status,
    @payloadJson, @organizationId, @branchId, @createdBy, @createdAt, @updatedAt
  )
`)

const insertClaimItem = db.prepare(`
  INSERT INTO nhia_claim_items (
    id, nhia_claim_id, drug_id, drug_name, nhia_code, quantity,
    unit_price, total_price, payload_json, created_at
  )
  VALUES (
    @id, @claimId, @drugId, @drugName, @nhiaCode, @quantity,
    @unitPrice, @totalPrice, @payloadJson, @createdAt
  )
`)

const insertClaimService = db.prepare(`
  INSERT INTO nhia_claim_services (
    id, nhia_claim_id, gdrg_code, description, quantity, unit_price,
    total_amount, age_band, facility_group, catering_option, mdc,
    service_date, payload_json, created_at
  )
  VALUES (
    @id, @claimId, @gdrgCode, @description, @quantity, @unitPrice,
    @totalAmount, @ageBand, @facilityGroup, @cateringOption, @mdc,
    @serviceDate, @payloadJson, @createdAt
  )
`)

const selectClaimsBase = `
  SELECT *
  FROM nhia_claims
`

const selectClaimById = db.prepare(`${selectClaimsBase} WHERE id = ?`)
const selectClaimItems = db.prepare(`
  SELECT *
  FROM nhia_claim_items
  WHERE nhia_claim_id = ?
  ORDER BY created_at ASC
`)
const selectClaimServices = db.prepare(`
  SELECT *
  FROM nhia_claim_services
  WHERE nhia_claim_id = ?
  ORDER BY created_at ASC
`)
const updateClaimPayloadJson = db.prepare(`
  UPDATE nhia_claims
  SET payload_json = ?,
      updated_at = ?
  WHERE id = ?
`)

const updateClaimStatus = db.prepare(`
  UPDATE nhia_claims
  SET status = @status,
      response_json = @responseJson,
      cc_code = COALESCE(@ccCode, cc_code),
      retry_count = @retryCount,
      next_retry_at = @nextRetryAt,
      last_error = @lastError,
      submitted_at = COALESCE(@submittedAt, submitted_at),
      accepted_at = COALESCE(@acceptedAt, accepted_at),
      rejected_at = COALESCE(@rejectedAt, rejected_at),
      paid_at = COALESCE(@paidAt, paid_at),
      updated_at = @updatedAt
  WHERE id = @id
`)

const markClaimReadyStatement = db.prepare(`
  UPDATE nhia_claims
  SET status = 'ready',
      last_error = NULL,
      next_retry_at = NULL,
      updated_at = ?
  WHERE id = ?
`)

const insertBatch = db.prepare(`
  INSERT INTO nhia_claim_batches (
    id, batch_number, status, export_format, claim_count, total_amount,
    payload_json, file_name, organization_id, branch_id, created_by, created_at, updated_at
  )
  VALUES (
    @id, @batchNumber, @status, @exportFormat, @claimCount, @totalAmount,
    @payloadJson, @fileName, @organizationId, @branchId, @createdBy, @createdAt, @updatedAt
  )
`)

const updateClaimsBatch = db.prepare(`
  UPDATE nhia_claims
  SET batch_id = ?, updated_at = ?
  WHERE id = ?
`)

const selectBatchById = db.prepare('SELECT * FROM nhia_claim_batches WHERE id = ?')
const selectLocalClinicalRules = db.prepare(`
  SELECT data_json AS payload_json
  FROM offline_records
  WHERE entity_type = 'nhis_clinical_rules'
    AND sync_status != 'failed'
  ORDER BY updated_at DESC
`)

const insertLog = db.prepare(`
  INSERT INTO nhia_submission_logs (
    id, nhia_claim_id, batch_id, action, status, attempt, http_status,
    request_json, response_json, error_message, created_at
  )
  VALUES (
    @id, @claimId, @batchId, @action, @status, @attempt, @httpStatus,
    @requestJson, @responseJson, @errorMessage, @createdAt
  )
`)

const statusCounts = db.prepare(`
  SELECT status, COUNT(*) AS count
  FROM nhia_claims
  GROUP BY status
`)

const recentLogs = db.prepare(`
  SELECT *
  FROM nhia_submission_logs
  ORDER BY created_at DESC
  LIMIT ?
`)

const pendingClaims = db.prepare(`
  SELECT *
  FROM nhia_claims
  WHERE status IN ('ready', 'failed')
    AND retry_count < ?
    AND (next_retry_at IS NULL OR next_retry_at <= ?)
  ORDER BY created_at ASC
  LIMIT ?
`)

const normalizeDiagnosisDetails = (value) => {
  const raw = typeof value === 'string' ? parseJson(value, []) : value
  if (!Array.isArray(raw)) return []

  return raw
    .map((diagnosis) => ({
      code: normalizeText(diagnosis?.code) || null,
      label: normalizeText(diagnosis?.label || diagnosis?.diagnosis || diagnosis?.name),
      source: normalizeText(diagnosis?.source || diagnosis?.diagnosis_source) || 'Custom',
      sourceVersion: normalizeText(diagnosis?.sourceVersion || diagnosis?.source_version) || null,
      custom: Boolean(diagnosis?.custom),
    }))
    .filter((diagnosis) => diagnosis.label)
}

const maskCredentials = (payload = {}) =>
  Object.fromEntries(
    Object.entries(payload || {}).map(([key, value]) => [
      key,
      normalizeText(value) ? true : false,
    ])
  )

const NHIA_SECRET_MASK = '\u2022'.repeat(8)
const NHIA_SECRET_FIELDS = new Set(['apiKey', 'apiSecret', 'username', 'password'])
const NHIA_SECRET_PREFIX = 'hfsec:aesgcm:v1:'
const NHIA_LEGACY_SECRET_PREFIX = 'hfsec:v1:'
const NHIA_SECRET_MASK_VALUES = new Set([NHIA_SECRET_MASK, '\u2022'.repeat(8), '\u2022'.repeat(12)])

const isNhiaSecretMask = (value) => NHIA_SECRET_MASK_VALUES.has(normalizeText(value))

const decodeLegacyNhiaSecret = (value) => {
  try {
    return Buffer.from(value.slice(NHIA_LEGACY_SECRET_PREFIX.length), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

const getNhiaSecretKeyMaterials = () =>
  [
    normalizeText(config.nhiaConfigSecretKey),
    normalizeText(config.branchServerToken),
    normalizeText(config.branchSyncToken),
    normalizeText(config.supabaseSyncKey),
  ].filter((value, index, values) => value && values.indexOf(value) === index)

const getPrimaryNhiaSecretKeyMaterial = () => getNhiaSecretKeyMaterials()[0] || ''

const getNhiaSecretKey = (keyMaterial = getPrimaryNhiaSecretKeyMaterial()) => {
  if (!keyMaterial) {
    throw new Error('Missing NHIA_CONFIG_SECRET_KEY for NHIA secret encryption.')
  }
  return crypto.createHash('sha256').update(keyMaterial).digest()
}

const encodeNhiaSecret = (value) => {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  if (normalized.startsWith(NHIA_SECRET_PREFIX)) return normalized
  const plaintext = normalized.startsWith(NHIA_LEGACY_SECRET_PREFIX)
    ? decodeLegacyNhiaSecret(normalized)
    : normalized
  if (!plaintext) return ''
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getNhiaSecretKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${NHIA_SECRET_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

const decodeNhiaSecret = (value) => {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  if (normalized.startsWith(NHIA_LEGACY_SECRET_PREFIX)) {
    return decodeLegacyNhiaSecret(normalized)
  }
  if (!normalized.startsWith(NHIA_SECRET_PREFIX)) return normalized
  const [ivEncoded, tagEncoded, ciphertextEncoded] = normalized.slice(NHIA_SECRET_PREFIX.length).split(':')
  if (!ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new Error('Invalid NHIA secret ciphertext.')
  }
  for (const keyMaterial of getNhiaSecretKeyMaterials()) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', getNhiaSecretKey(keyMaterial), Buffer.from(ivEncoded, 'base64'))
      decipher.setAuthTag(Buffer.from(tagEncoded, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextEncoded, 'base64')),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      // Try the next configured legacy key material.
    }
  }
  throw new Error('Unable to decrypt NHIA secret. Check NHIA_CONFIG_SECRET_KEY.')
}

const logNhiaSecretDecryptDebug = (field, value, success) => {
  const encrypted = normalizeText(value)
  console.info('[NHIA CONFIG] secret decrypt debug', {
    field,
    encryptedLength: encrypted.length,
    keyExists: Boolean(getPrimaryNhiaSecretKeyMaterial()),
    decryptSuccess: Boolean(success),
  })
}

const safeDecodeNhiaSecret = (value, field = 'secret') => {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  try {
    const decoded = decodeNhiaSecret(normalized)
    logNhiaSecretDecryptDebug(field, normalized, true)
    return decoded
  } catch {
    logNhiaSecretDecryptDebug(field, normalized, false)
    return ''
  }
}

const logNhiaConfigEvent = (event, details = {}) => {
  console.info(`[NHIA CONFIG] ${event}`, {
    mode: details.mode || '',
    saveTarget: details.saveTarget || '',
    endpoint: details.endpoint || '',
    saveSuccess: details.saveSuccess ?? null,
    saveFailed: details.saveFailed ?? null,
    configSource: details.configSource || '',
    hasApiKey: Boolean(details.hasApiKey),
    hasApiSecret: Boolean(details.hasApiSecret),
  })
}

const logNhiaCredentialDebug = (event, details = {}) => {
  console.info(`[NHIA CREDENTIALS] ${event}`, {
    configSource: details.configSource || '',
    nhiaBaseUrl: details.nhiaBaseUrl || '',
    endpointPath: details.endpointPath || '',
    organizationId: details.organizationId || '',
    branchId: details.branchId || '',
    facilityCode: details.facilityCode || '',
    providerNumber: details.providerNumber || '',
    credentialMode: details.credentialMode || '',
    usernamePresent: Boolean(details.usernamePresent),
    passwordPresent: Boolean(details.passwordPresent),
    apiKeyPresent: Boolean(details.apiKeyPresent),
    apiSecretPresent: Boolean(details.apiSecretPresent),
    apiKeyHeaderName: details.apiKeyHeaderName || '',
    apiSecretHeaderName: details.apiSecretHeaderName || '',
    requestBodyFields: details.requestBodyFields || [],
  })
}

const getNhiaCredentialDebugDetails = ({
  settings = {},
  credentials = {},
  nhiaBaseUrl = '',
  endpointPath = '',
  apiKeyHeaderName = '',
  apiSecretHeaderName = '',
} = {}) => ({
  configSource: settings.configSource || settings.source || 'settings',
  nhiaBaseUrl,
  endpointPath,
  organizationId: settings.organizationId || settings.organization_id || config.organizationId || '',
  branchId: settings.branchId || settings.branch_id || config.branchId || '',
  facilityCode: settings.facilityCode || settings.facility_code || config.nhiaFacilityCode || '',
  providerNumber: settings.providerNumber || settings.provider_number || settings.providerId || settings.provider_id || '',
  credentialMode: settings.credentialMode || settings.credential_mode || '',
  usernamePresent: Boolean(normalizeText(settings.username || credentials.username)),
  passwordPresent: Boolean(settings.hasPassword || settings.has_password || settings.credentialSummary?.password || hasUsableNhiaSecret(credentials.password)),
  apiKeyPresent: Boolean(settings.hasApiKey || settings.has_api_key || settings.credentialSummary?.apiKey || hasUsableNhiaSecret(credentials.apiKey || credentials.token)),
  apiSecretPresent: Boolean(settings.hasApiSecret || settings.has_api_secret || settings.credentialSummary?.apiSecret || hasUsableNhiaSecret(credentials.apiSecret)),
  apiKeyHeaderName,
  apiSecretHeaderName,
  requestBodyFields: ['CardNo', 'CardType'],
})

const mapSettingsRow = (row, { includeCredentials = false } = {}) => {
  if (!row) {
    return null
  }

  const credentials = includeCredentials
    ? {
        apiKey: safeDecodeNhiaSecret(row.api_key_encrypted, 'apiKey'),
        apiSecret: safeDecodeNhiaSecret(row.api_secret_encrypted, 'apiSecret'),
        headerName: row.api_key_header_name || '',
        secretHeaderName: row.api_secret_header_name || '',
        headerPrefix: row.api_key_header_prefix || '',
        username: row.username || '',
        password: safeDecodeNhiaSecret(row.password_encrypted, 'password'),
        tokenEndpointPath: row.token_endpoint_path || '',
      }
    : {}
  const credentialDecodeFailed = includeCredentials && Boolean(
    (row.api_key_encrypted && !credentials.apiKey) ||
      (row.api_secret_encrypted && !credentials.apiSecret) ||
      (row.password_encrypted && !credentials.password)
  )
  const credentialSummary = includeCredentials
    ? maskCredentials(credentials)
    : {
        apiKey: Boolean(row.api_key_encrypted),
        apiSecret: Boolean(row.api_secret_encrypted),
        password: Boolean(row.password_encrypted),
        username: Boolean(row.username),
      }

  return {
    id: row.id,
    organizationId: row.organization_id || '',
    branchId: row.branch_id || '',
    mode: row.mode || 'OFFLINE_LOCAL',
    source: 'settings',
    configSource: 'settings',
    facilityCode: row.facility_code || '',
    providerId: row.provider_id || row.provider_number || '',
    provider_id: row.provider_id || row.provider_number || '',
    providerNumber: row.provider_number || row.provider_id || '',
    hpn: row.hpn || row.provider_number || row.provider_id || '',
    hpCode: row.hp_code || row.facility_code || '',
    hp_code: row.hp_code || row.facility_code || '',
    // ✅ NHIA CONFIG PATCH START
    facilityType: row.facility_type || '',
    pharmacyFacilityLevel: row.pharmacy_facility_level || '',
    providerLevelCode: row.provider_level_code || '',
    credentialCode: row.credential_code || row.facility_code || '',
    licenseNumber: row.license_number || '',
    accreditationExpiryDate: getAccreditationExpiryDate(row),
    // ✅ NHIA API ARCHITECTURE PATCH START
    integrationMode: normalizeIntegrationMode(row.integration_mode, DEFAULT_NHIA_INTEGRATION_MODE),
    connectionProfile: row.connection_profile || 'local_server',
    validationMode: row.validation_mode || 'validate_before_submit',
    claimControlMode: row.claim_control_mode ||
      (normalizeIntegrationMode(row.integration_mode) === 'claimit_bridge'
        ? 'claimit_bridge'
        : normalizeIntegrationMode(row.integration_mode) === 'direct_nhia_api'
          ? 'direct_api'
          : 'manual'),
    sandboxBaseUrl: row.sandbox_base_url || '',
    productionBaseUrl: row.production_base_url || '',
    // Detect legacy rows where api_base_url held a CLAIM-it bridge URL.
    // Move it to claimitSubmitBaseUrl and clear apiBaseUrl so admin fills in the correct NHIA URL.
    apiBaseUrl: (() => {
      const stored = normalizeText(row.api_base_url)
      if (!stored) return DEFAULT_NHIA_API_BASE_URL
      const isClaimItUrl = stored.includes('localhost') ||
        stored.includes('/json-api') || stored.includes('/xml-api') ||
        stored.includes('31719') ||
        (!stored.includes('nhia.gov.gh') && (stored.includes('.vercel.app') || stored.includes('.healthflow')))
      return isClaimItUrl ? DEFAULT_NHIA_API_BASE_URL : stored
    })(),
    claimitSubmitBaseUrl: (() => {
      const fromProduction = normalizeText(row.production_base_url)
      if (fromProduction) return fromProduction
      const stored = normalizeText(row.api_base_url)
      if (!stored) return DEFAULT_CLAIMIT_SUBMIT_BASE_URL
      const isClaimItUrl = stored.includes('localhost') ||
        stored.includes('/json-api') || stored.includes('/xml-api') ||
        stored.includes('31719') ||
        (!stored.includes('nhia.gov.gh') && (stored.includes('.vercel.app') || stored.includes('.healthflow')))
      return isClaimItUrl ? stored : DEFAULT_CLAIMIT_SUBMIT_BASE_URL
    })(),
    // ✅ NHIA API ARCHITECTURE PATCH END
    // ✅ NHIA CONFIG PATCH END
    schemeName: row.scheme_name || 'National Health Insurance',
    providerTypeDescription: row.provider_type_description || '',
    providerClassLevel: row.provider_class_level || '',
    // ✅ NHIS PHARMACY LEVEL PATCH START
    pharmacyLevel: row.pharmacy_level || '',
    pharmacy_level: row.pharmacy_level || '',
    // ✅ NHIS PHARMACY LEVEL PATCH END
    claimsOfficerName: row.claims_officer_name || '',
    admissionPaymentOption: row.admission_payment_option || 'nhis_pays_admission',
    claimitValidationEnabled: row.claimit_validation_enabled !== 0,
    claimsOfficerSignatureUrl: row.claims_officer_signature_url || '',
    submitterId: row.submitter_id || '',
    apiKeyEncrypted: row.api_key_encrypted ? NHIA_SECRET_MASK : '',
    apiSecretEncrypted: row.api_secret_encrypted ? NHIA_SECRET_MASK : '',
    claimEndpointPath: row.claim_endpoint_path || DEFAULT_CLAIMIT_CLAIM_ENDPOINT,
    claimSubmitEndpoint: row.claim_submit_endpoint || row.claim_endpoint_path || DEFAULT_CLAIMIT_CLAIM_ENDPOINT,
    claim_submit_endpoint: row.claim_submit_endpoint || row.claim_endpoint_path || DEFAULT_CLAIMIT_CLAIM_ENDPOINT,
    claimValidationEndpointPath: row.claim_validation_endpoint_path || '',
    ccEndpointPath: row.cc_endpoint_path || row.cc_code_endpoint_path || '',
    ccCodeEndpointPath: row.cc_code_endpoint_path || '',
    claimStatusEndpointPath: row.claim_status_endpoint_path || '',
    claimStatusEndpoint: row.claim_status_endpoint || row.claim_status_endpoint_path || '',
    claim_status_endpoint: row.claim_status_endpoint || row.claim_status_endpoint_path || '',
    memberLookupEndpointPath: row.member_lookup_endpoint_path || row.member_lookup_endpoint || DEFAULT_NHIA_MEMBER_LOOKUP_ENDPOINT,
    memberLookupEndpoint: row.member_lookup_endpoint || row.member_lookup_endpoint_path || DEFAULT_NHIA_MEMBER_LOOKUP_ENDPOINT,
    member_lookup_endpoint: row.member_lookup_endpoint || row.member_lookup_endpoint_path || DEFAULT_NHIA_MEMBER_LOOKUP_ENDPOINT,
    directApiEnabled: Boolean(row.direct_api_enabled),
    credentialMode: normalizeCredentialMode(row.credential_mode || 'claimit_token'),
    credentials: includeCredentials ? credentials : {},
    credentialSummary,
    credentialDecodeFailed,
    requiresCredentialReentry: credentialDecodeFailed,
    credentialWarning: credentialDecodeFailed
      ? 'Unable to decrypt saved NHIA credentials. Re-enter the NHIA API key and secret, then save again.'
      : '',
    hasApiKey: includeCredentials ? Boolean(credentials.apiKey) : Boolean(row.api_key_encrypted),
    hasApiSecret: includeCredentials ? Boolean(credentials.apiSecret) : Boolean(row.api_secret_encrypted),
    username: includeCredentials ? row.username || '' : '',
    hasUsername: Boolean(row.username),
    has_username: Boolean(row.username),
    passwordEncrypted: row.password_encrypted ? NHIA_SECRET_MASK : '',
    hasPassword: Boolean(row.password_encrypted),
    nhisMemberDigits: Number(row.nhis_member_digits || DEFAULT_NHIS_MEMBER_DIGITS),
    ghanaCardDigits: Number(row.ghana_card_digits || DEFAULT_GHANA_CARD_DIGITS),
    exportFormat: row.export_format === 'cxf' ? 'xml' : (row.export_format || 'xml'),
    maxRetryAttempts: Number(row.max_retry_attempts || 3),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by || '',
  }
}

const resolveSettingsRow = () =>
  selectSettings.get(config.organizationId, config.branchId) || selectAnySettings.get()

const isSupabaseUuid = (value) => SUPABASE_UUID_PATTERN.test(normalizeText(value))

const sanitizeNhiaConfigForSync = (row = {}) => {
  const payload = { ...row }
  if (!isSupabaseUuid(payload.id)) {
    delete payload.id
  }
  delete payload.api_key_encrypted
  delete payload.api_secret_encrypted
  delete payload.password_encrypted
  delete payload.has_api_key
  delete payload.has_api_secret
  delete payload.username
  return payload
}

const queueNhiaConfigSync = (row, timestamp = nowIso()) => {
  if (!row?.id) return
  deletePendingNhiaConfigOutbox.run(row.id)
  insertNhiaConfigOutbox.run({
    id: createId(),
    entityId: row.id,
    payloadJson: json({ config: sanitizeNhiaConfigForSync(row) }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
}

const hasWritableNhiaSecret = (credentials, key) =>
  Boolean(normalizeText(credentials[key]) && !isNhiaSecretMask(credentials[key]))

const buildClaimBridgeEnvNhiaSettings = ({ includeCredentials = false } = {}) => {
  if (!config.claimBridge.allowEnvCredentialOverrides) {
    return null
  }

  const nhiaEligibilityBaseUrl = getNhiaEligibilityBaseUrl()
  const upstreamBaseUrl = normalizeText(config.claimBridge.upstreamBaseUrl) || nhiaEligibilityBaseUrl
  if (!config.claimBridge.enabled && !upstreamBaseUrl) {
    return null
  }

  const hasApiKey = Boolean(normalizeText(config.claimBridge.upstreamApiKey))
  const hasApiSecret = Boolean(normalizeText(config.claimBridge.upstreamApiSecret))
  const hasUsername = Boolean(normalizeText(config.claimBridge.upstreamUsername))
  const hasPassword = Boolean(normalizeText(config.claimBridge.upstreamPassword))
  const credentialMode = normalizeCredentialMode(config.claimBridge.upstreamCredentialMode || 'api_key')
  const memberLookupEndpointPath = config.claimBridge.upstreamMemberLookupPath || DEFAULT_NHIA_MEMBER_LOOKUP_ENDPOINT
  const ccEndpointPath = config.claimBridge.upstreamCcEndpointPath || ''
  const credentials = includeCredentials
    ? {
        apiKey: config.claimBridge.upstreamApiKey,
        apiSecret: config.claimBridge.upstreamApiSecret,
        headerName: config.claimBridge.upstreamApiKeyHeader || 'x-nhia-apikey',
        secretHeaderName: config.claimBridge.upstreamApiSecretHeader || 'x-nhia-apisecret',
        username: config.claimBridge.upstreamUsername,
        password: config.claimBridge.upstreamPassword,
        token: config.claimBridge.upstreamBearerToken,
      }
    : {}

  return {
    id: 'claim-bridge-env',
    organizationId: config.organizationId || '',
    branchId: config.branchId || '',
    mode: 'ONLINE_LOCAL_SYNC',
    source: 'claim_bridge_env',
    configSource: 'claim_bridge_env',
    facilityCode: config.nhiaFacilityCode || '',
    facility_code: config.nhiaFacilityCode || '',
    providerId: config.nhiaProviderId || '',
    provider_id: config.nhiaProviderId || '',
    providerNumber: config.nhiaProviderId || '',
    provider_number: config.nhiaProviderId || '',
    credentialCode: config.nhiaCredentialCode || config.nhiaFacilityCode || '',
    credential_code: config.nhiaCredentialCode || config.nhiaFacilityCode || '',
    claimsOfficerName: config.nhiaClaimsOfficerName || '',
    claims_officer_name: config.nhiaClaimsOfficerName || '',
    accreditationExpiryDate: config.nhiaAccreditationExpiryDate || '',
    integrationMode: DEFAULT_NHIA_INTEGRATION_MODE,
    integration_mode: DEFAULT_NHIA_INTEGRATION_MODE,
    claimControlMode: 'direct_api',
    claim_control_mode: 'direct_api',
    connectionProfile: 'local_server',
    connection_profile: 'local_server',
    validationMode: 'validate_before_submit',
    validation_mode: 'validate_before_submit',
    apiBaseUrl: nhiaEligibilityBaseUrl,
    api_base_url: nhiaEligibilityBaseUrl,
    nhiaEligibilityBaseUrl,
    nhia_eligibility_base_url: nhiaEligibilityBaseUrl,
    claimitSubmitBaseUrl: config.claimBridge.claimItSubmitBaseUrl || DEFAULT_CLAIMIT_SUBMIT_BASE_URL,
    claimit_submit_base_url: config.claimBridge.claimItSubmitBaseUrl || DEFAULT_CLAIMIT_SUBMIT_BASE_URL,
    productionBaseUrl: config.claimBridge.claimItSubmitBaseUrl || DEFAULT_CLAIMIT_SUBMIT_BASE_URL,
    production_base_url: config.claimBridge.claimItSubmitBaseUrl || DEFAULT_CLAIMIT_SUBMIT_BASE_URL,
    claimEndpointPath: config.claimBridge.claimSubmitPath || DEFAULT_CLAIMIT_CLAIM_ENDPOINT,
    claimSubmitEndpoint: config.claimBridge.claimSubmitPath || DEFAULT_CLAIMIT_CLAIM_ENDPOINT,
    claim_submit_endpoint: config.claimBridge.claimSubmitPath || DEFAULT_CLAIMIT_CLAIM_ENDPOINT,
    ccEndpointPath,
    cc_endpoint_path: ccEndpointPath,
    ccCodeEndpointPath: ccEndpointPath,
    cc_code_endpoint_path: ccEndpointPath,
    memberLookupEndpointPath,
    member_lookup_endpoint_path: memberLookupEndpointPath,
    memberLookupEndpoint: memberLookupEndpointPath,
    member_lookup_endpoint: memberLookupEndpointPath,
    directApiEnabled: true,
    direct_api_enabled: true,
    credentialMode,
    credential_mode: credentialMode,
    credentials,
    credentialSummary: {
      apiKey: hasApiKey,
      apiSecret: hasApiSecret,
      username: hasUsername,
      password: hasPassword,
    },
    hasApiKey,
    has_api_key: hasApiKey,
    hasApiSecret,
    has_api_secret: hasApiSecret,
    username: includeCredentials ? config.claimBridge.upstreamUsername : '',
    hasPassword,
    has_password: hasPassword,
    isActive: true,
    is_active: true,
  }
}

const applyEnvNhiaCredentialOverrides = (settings, { includeCredentials = false } = {}) => {
  if (!settings) return settings
  if (!config.claimBridge.allowEnvCredentialOverrides) return settings

  const envApiKey = normalizeText(config.claimBridge.upstreamApiKey)
  const envApiSecret = normalizeText(config.claimBridge.upstreamApiSecret)
  const envFacilityCode = normalizeText(config.nhiaFacilityCode)
  const envProviderId = normalizeText(config.nhiaProviderId)
  const envCredentialCode = normalizeText(config.nhiaCredentialCode)
  const envUsername = normalizeText(config.claimBridge.upstreamUsername)
  const envPassword = normalizeText(config.claimBridge.upstreamPassword)
  const hasCredentialOverride = Boolean(envApiKey || envApiSecret || envUsername || envPassword)
  const hasHeaderOverride = Boolean(normalizeText(
    process.env.NHIA_API_KEY_HEADER ||
    process.env.CLAIMIT_UPSTREAM_API_KEY_HEADER ||
    process.env.NHIA_API_SECRET_HEADER ||
    process.env.CLAIMIT_UPSTREAM_API_SECRET_HEADER
  ))
  const envApiKeyHeader = hasCredentialOverride || hasHeaderOverride
    ? normalizeText(config.claimBridge.upstreamApiKeyHeader)
    : ''
  const envApiSecretHeader = hasCredentialOverride || hasHeaderOverride
    ? normalizeText(config.claimBridge.upstreamApiSecretHeader)
    : ''
  const hasOverride = Boolean(
    hasCredentialOverride ||
    envFacilityCode ||
    envProviderId ||
    envCredentialCode ||
    hasHeaderOverride
  )

  if (!hasOverride) return settings

  const credentials = includeCredentials ? { ...(settings.credentials || {}) } : {}
  const credentialSummary = { ...(settings.credentialSummary || {}) }

  if (envApiKey) {
    if (includeCredentials) credentials.apiKey = envApiKey
    credentialSummary.apiKey = true
  }
  if (envApiSecret) {
    if (includeCredentials) credentials.apiSecret = envApiSecret
    credentialSummary.apiSecret = true
  }
  if (envApiKeyHeader) {
    if (includeCredentials) credentials.headerName = envApiKeyHeader
  }
  if (envApiSecretHeader) {
    if (includeCredentials) credentials.secretHeaderName = envApiSecretHeader
  }
  if (envUsername) {
    if (includeCredentials) credentials.username = envUsername
    credentialSummary.username = true
  }
  if (envPassword) {
    if (includeCredentials) credentials.password = envPassword
    credentialSummary.password = true
  }

  return {
    ...settings,
    source: `${settings.source || 'settings'}+env`,
    configSource: `${settings.configSource || settings.source || 'settings'}+env`,
    facilityCode: envFacilityCode || settings.facilityCode || '',
    facility_code: envFacilityCode || settings.facility_code || settings.facilityCode || '',
    providerId: envProviderId || settings.providerId || settings.provider_id || '',
    provider_id: envProviderId || settings.provider_id || settings.providerId || '',
    providerNumber: envProviderId || settings.providerNumber || settings.provider_number || '',
    provider_number: envProviderId || settings.provider_number || settings.providerNumber || '',
    credentialCode: envCredentialCode || envFacilityCode || settings.credentialCode || settings.credential_code || '',
    credential_code: envCredentialCode || envFacilityCode || settings.credential_code || settings.credentialCode || '',
    claimsOfficerName: normalizeText(config.nhiaClaimsOfficerName) || settings.claimsOfficerName || '',
    claims_officer_name: normalizeText(config.nhiaClaimsOfficerName) || settings.claims_officer_name || settings.claimsOfficerName || '',
    accreditationExpiryDate: normalizeText(config.nhiaAccreditationExpiryDate) || settings.accreditationExpiryDate || '',
    claimitSubmitBaseUrl: normalizeText(config.claimBridge.claimItSubmitBaseUrl) || settings.claimitSubmitBaseUrl || '',
    claimit_submit_base_url: normalizeText(config.claimBridge.claimItSubmitBaseUrl) || settings.claimit_submit_base_url || '',
    claimEndpointPath: normalizeText(config.claimBridge.claimSubmitPath) || settings.claimEndpointPath || '',
    claimSubmitEndpoint: normalizeText(config.claimBridge.claimSubmitPath) || settings.claimSubmitEndpoint || '',
    claim_submit_endpoint: normalizeText(config.claimBridge.claimSubmitPath) || settings.claim_submit_endpoint || '',
    credentials,
    credentialSummary,
    hasApiKey: Boolean(envApiKey || settings.hasApiKey || settings.has_api_key),
    has_api_key: Boolean(envApiKey || settings.hasApiKey || settings.has_api_key),
    hasApiSecret: Boolean(envApiSecret || settings.hasApiSecret || settings.has_api_secret),
    has_api_secret: Boolean(envApiSecret || settings.hasApiSecret || settings.has_api_secret),
    hasPassword: Boolean(envPassword || settings.hasPassword || settings.has_password),
    has_password: Boolean(envPassword || settings.hasPassword || settings.has_password),
    username: envUsername || settings.username || '',
  }
}

const mapRemoteNhiaConfigurationRow = (row = {}) => {
  const organizationId = normalizeText(row.organization_id || row.organizationId || config.organizationId)
  const branchId = normalizeText(row.branch_id || row.branchId || config.branchId)
  const existing = selectSettings.get(organizationId, branchId)
  const timestamp = normalizeText(row.updated_at || row.updatedAt) || nowIso()
  const apiKeyEncrypted = normalizeText(row.api_key_encrypted || row.apiKeyEncrypted)
  const apiSecretEncrypted = normalizeText(row.api_secret_encrypted || row.apiSecretEncrypted)
  const passwordEncrypted = normalizeText(row.password_encrypted || row.passwordEncrypted)

  return {
    id: existing?.id || normalizeText(row.id) || createId(),
    organizationId,
    branchId,
    mode: normalizeText(row.mode) || 'ONLINE_LOCAL_SYNC',
    facilityCode: normalizeText(row.facility_code || row.facilityCode) || null,
    providerId: normalizeText(row.provider_id || row.providerId || row.provider_number || row.providerNumber) || null,
    providerNumber: normalizeText(row.provider_number || row.providerNumber || row.provider_id || row.providerId) || null,
    hpn: normalizeText(row.hpn || row.HPN || row.provider_number || row.providerNumber || row.provider_id || row.providerId) || null,
    hpCode: normalizeText(row.hp_code || row.hpCode || row.HPCode || row.facility_code || row.facilityCode) || null,
    facilityType: normalizeText(row.facility_type || row.facilityType) || null,
    pharmacyFacilityLevel: normalizeText(row.pharmacy_facility_level || row.pharmacyFacilityLevel) || null,
    providerLevelCode: normalizeText(row.provider_level_code || row.providerLevelCode) || null,
    credentialCode: normalizeText(row.credential_code || row.credentialCode || row.facility_code || row.facilityCode) || null,
    licenseNumber: normalizeText(row.license_number || row.licenseNumber) || null,
    accreditationExpiryDate: getAccreditationExpiryDate(row) || null,
    integrationMode: normalizeIntegrationMode(row.integration_mode || row.integrationMode || row.nhia_api_mode || row.nhiaApiMode),
    connectionProfile: normalizeText(row.connection_profile || row.connectionProfile) || 'local_server',
    validationMode: normalizeText(row.validation_mode || row.validationMode) || 'validate_before_submit',
    claimControlMode: normalizeText(row.claim_control_mode || row.claimControlMode) || 'manual',
    sandboxBaseUrl: normalizeText(row.sandbox_base_url || row.sandboxBaseUrl).replace(/\/+$/, '') || null,
    productionBaseUrl: normalizeText(row.production_base_url || row.productionBaseUrl || row.claimit_submit_base_url || row.claimitSubmitBaseUrl).replace(/\/+$/, '') || null,
    submitterId: normalizeText(row.submitter_id || row.submitterId) || null,
    schemeName: normalizeText(row.scheme_name || row.schemeName) || 'National Health Insurance',
    providerTypeDescription: normalizeText(row.provider_type_description || row.providerTypeDescription) || null,
    providerClassLevel: normalizeText(row.provider_class_level || row.providerClassLevel) || null,
    pharmacyLevel: normalizeText(row.pharmacy_level || row.pharmacyLevel) || null,
    claimsOfficerName: normalizeText(row.claims_officer_name || row.claimsOfficerName) || null,
    admissionPaymentOption: normalizeAdmissionPaymentOption(row.admission_payment_option || row.admissionPaymentOption),
    claimitValidationEnabled: row.claimit_validation_enabled === false || row.claimitValidationEnabled === false ? 0 : 1,
    claimsOfficerSignatureUrl: normalizeText(row.claims_officer_signature_url || row.claimsOfficerSignatureUrl) || null,
    apiBaseUrl: normalizeText(row.api_base_url || row.apiBaseUrl).replace(/\/+$/, '') || null,
    apiKeyEncrypted: apiKeyEncrypted || null,
    apiSecretEncrypted: apiSecretEncrypted || null,
    hasApiKey: apiKeyEncrypted ? 1 : toBool(row.has_api_key || row.hasApiKey),
    hasApiSecret: apiSecretEncrypted ? 1 : toBool(row.has_api_secret || row.hasApiSecret),
    apiKeyHeaderName: normalizeText(row.api_key_header_name || row.apiKeyHeaderName) || null,
    apiSecretHeaderName: normalizeText(row.api_secret_header_name || row.apiSecretHeaderName) || null,
    apiKeyHeaderPrefix: normalizeText(row.api_key_header_prefix || row.apiKeyHeaderPrefix) || null,
    username: normalizeText(row.username) || null,
    passwordEncrypted: passwordEncrypted || null,
    tokenEndpointPath: normalizeText(row.token_endpoint_path || row.tokenEndpointPath) || null,
    claimEndpointPath: normalizeText(row.claim_endpoint_path || row.claimEndpointPath || row.claim_submit_endpoint || row.claimSubmitEndpoint) || null,
    claimSubmitEndpoint: normalizeText(row.claim_submit_endpoint || row.claimSubmitEndpoint || row.claim_endpoint_path || row.claimEndpointPath) || null,
    claimValidationEndpointPath: normalizeText(row.claim_validation_endpoint_path || row.claimValidationEndpointPath) || null,
    ccEndpointPath: normalizeText(row.cc_endpoint_path || row.ccEndpointPath || row.cc_code_endpoint_path || row.ccCodeEndpointPath) || null,
    ccCodeEndpointPath: normalizeText(row.cc_code_endpoint_path || row.ccCodeEndpointPath || row.cc_endpoint_path || row.ccEndpointPath) || null,
    claimStatusEndpointPath: normalizeText(row.claim_status_endpoint_path || row.claimStatusEndpointPath || row.claim_status_endpoint || row.claimStatusEndpoint) || null,
    claimStatusEndpoint: normalizeText(row.claim_status_endpoint || row.claimStatusEndpoint || row.claim_status_endpoint_path || row.claimStatusEndpointPath) || null,
    memberLookupEndpointPath: normalizeText(row.member_lookup_endpoint_path || row.memberLookupEndpointPath || row.member_lookup_endpoint || row.memberLookupEndpoint) || null,
    memberLookupEndpoint: normalizeText(row.member_lookup_endpoint || row.memberLookupEndpoint || row.member_lookup_endpoint_path || row.memberLookupEndpointPath) || null,
    directApiEnabled: toBool(row.direct_api_enabled || row.directApiEnabled),
    credentialMode: normalizeCredentialMode(row.credential_mode || row.credentialMode),
    nhisMemberDigits: toDigitLength(row.nhis_member_digits || row.nhisMemberDigits, DEFAULT_NHIS_MEMBER_DIGITS),
    ghanaCardDigits: toDigitLength(row.ghana_card_digits || row.ghanaCardDigits, DEFAULT_GHANA_CARD_DIGITS),
    exportFormat: normalizeExportFormat(row.export_format || row.exportFormat),
    maxRetryAttempts: Math.min(Math.max(Number(row.max_retry_attempts || row.maxRetryAttempts) || 3, 1), 10),
    createdAt: normalizeText(row.created_at || row.createdAt) || timestamp,
    updatedAt: timestamp,
    updatedBy: normalizeText(row.updated_by || row.updatedBy) || 'branch-reference-pull',
  }
}

export const importNhiaConfigurationSnapshot = db.transaction((rows = []) => {
  const result = { imported: 0, skipped: 0 }
  const list = Array.isArray(rows) ? rows : []

  for (const row of list) {
    if (!row || typeof row !== 'object') {
      result.skipped += 1
      continue
    }

    if (row.is_active === false || row.is_active === 0) {
      result.skipped += 1
      continue
    }

    upsertSettings.run(mapRemoteNhiaConfigurationRow(row))
    result.imported += 1
  }

  return result
})

export const getNhiaSettings = ({ includeCredentials = false } = {}) => {
  const settings = applyEnvNhiaCredentialOverrides(
    mapSettingsRow(resolveSettingsRow(), { includeCredentials }) ||
      buildClaimBridgeEnvNhiaSettings({ includeCredentials }),
    { includeCredentials }
  )
  logNhiaConfigEvent('load', {
    mode: settings?.mode || 'OFFLINE_LOCAL',
    endpoint: '/api/nhia-config',
    configSource: settings?.configSource || settings?.source || 'local_branch_server',
    hasApiKey: settings?.hasApiKey,
    hasApiSecret: settings?.hasApiSecret,
  })
  return settings
}

export const getNhiaConfigurationHealth = () => {
  const settings = getNhiaSettings({ includeCredentials: true })
  const credentials = settings?.credentials || {}
  const ccMissing = [
    !normalizeText(settings?.apiBaseUrl || settings?.api_base_url) && 'eligibilityBaseUrl',
    !normalizeText(settings?.memberLookupEndpointPath || settings?.member_lookup_endpoint_path) && 'memberLookupEndpoint',
    !hasUsableNhiaSecret(credentials.apiKey || credentials.token) && 'apiKey',
    !hasUsableNhiaSecret(credentials.apiSecret) && 'apiSecret',
  ].filter(Boolean)
  const transferMissing = [
    !normalizeText(settings?.facilityCode || settings?.facility_code) && 'facilityCode',
    !normalizeText(settings?.providerNumber || settings?.provider_number || settings?.providerId) && 'providerId',
    !normalizeText(settings?.claimitSubmitBaseUrl || settings?.claimit_submit_base_url) && 'claimItSubmitBaseUrl',
    !normalizeText(settings?.claimEndpointPath || settings?.claim_submit_endpoint) && 'claimSubmitEndpoint',
  ].filter(Boolean)

  return {
    configured: Boolean(settings),
    source: settings?.configSource || settings?.source || 'none',
    organizationScoped: Boolean(normalizeText(settings?.organizationId || settings?.organization_id || config.organizationId)),
    branchScoped: Boolean(normalizeText(settings?.branchId || settings?.branch_id || config.branchId)),
    ccGeneration: {
      ready: ccMissing.length === 0,
      missing: ccMissing,
    },
    claimItTransfer: {
      ready: transferMissing.length === 0,
      missing: transferMissing,
    },
    credentials: {
      apiKeySaved: hasUsableNhiaSecret(credentials.apiKey || credentials.token),
      apiSecretSaved: hasUsableNhiaSecret(credentials.apiSecret),
      usernameSaved: Boolean(normalizeText(credentials.username)),
      passwordSaved: hasUsableNhiaSecret(credentials.password),
    },
  }
}

const hasUsableNhiaSecret = (value) => {
  const normalized = normalizeText(value)
  return Boolean(normalized && !isNhiaSecretMask(normalized))
}

const validateNhiaSettingsForMode = (settings = {}) => {
  const credentials = settings.credentials && typeof settings.credentials === 'object' ? settings.credentials : {}
  const integrationMode = normalizeIntegrationMode(settings.integrationMode || settings.integration_mode || settings.nhiaApiMode || settings.nhia_api_mode)
  const hasApiKey = Boolean(settings.hasApiKey || settings.has_api_key || settings.credentialSummary?.apiKey || hasUsableNhiaSecret(credentials.apiKey))
  const hasApiSecret = Boolean(settings.hasApiSecret || settings.has_api_secret || settings.credentialSummary?.apiSecret || hasUsableNhiaSecret(credentials.apiSecret))
  const hasUsername = Boolean(normalizeText(settings.username || credentials.username))
  const hasPassword = Boolean(settings.hasPassword || settings.has_password || settings.credentialSummary?.password || hasUsableNhiaSecret(credentials.password))
  const missing = [
    !normalizeText(settings.providerId || settings.provider_id || settings.providerNumber || settings.provider_number) && 'providerId',
    !normalizeText(settings.credentialCode || settings.credential_code) && 'credentialCode',
    !getAccreditationExpiryDate(settings) && 'accreditationExpiryDate',
    !normalizeText(settings.claimsOfficerName || settings.claims_officer_name) && 'claimsOfficerName',
  ].filter(Boolean)
  const apiBaseUrl = normalizeText(settings.apiBaseUrl || settings.api_base_url || settings.sandboxBaseUrl || settings.sandbox_base_url)
  const claimitSubmitBaseUrl = normalizeText(settings.claimitSubmitBaseUrl || settings.claimit_submit_base_url || settings.productionBaseUrl || settings.production_base_url)
  const claimSubmitEndpoint = normalizeText(settings.claimSubmitEndpoint || settings.claim_submit_endpoint || settings.claimEndpointPath || settings.claim_endpoint_path)
  const claimStatusEndpoint = normalizeText(settings.claimStatusEndpoint || settings.claim_status_endpoint || settings.claimStatusEndpointPath || settings.claim_status_endpoint_path)
  const memberLookupEndpoint = normalizeText(settings.memberLookupEndpoint || settings.member_lookup_endpoint || settings.memberLookupEndpointPath || settings.member_lookup_endpoint_path)

  if (integrationMode === 'claimit_assisted') {
    if (!apiBaseUrl) missing.push('apiBaseUrl')
    if (!hasApiKey) missing.push('NHIA CCC apiKey')
    if (!hasApiSecret) missing.push('NHIA CCC apiSecret')
    if (!memberLookupEndpoint) missing.push('memberLookupEndpoint')
  }

  if (integrationMode === 'claimit_bridge') {
    if (!apiBaseUrl) missing.push('apiBaseUrl')
    if (!claimitSubmitBaseUrl) missing.push('claimitSubmitBaseUrl')
    if (!hasApiKey) missing.push('NHIA CCC apiKey')
    if (!hasApiSecret) missing.push('NHIA CCC apiSecret')
    if (!hasUsername) missing.push('ClaimIt username')
    if (!hasPassword) missing.push('ClaimIt password')
    if (!claimSubmitEndpoint) missing.push('claimSubmitEndpoint')
    if (!memberLookupEndpoint) missing.push('memberLookupEndpoint')
  }

  if (integrationMode === 'direct_nhia_api' || integrationMode === 'hybrid') {
    if (!apiBaseUrl) missing.push('apiBaseUrl')
    if (!normalizeText(settings.submitterId || settings.submitter_id)) missing.push('submitterId')
    if (!hasApiKey) missing.push('apiKey')
    if (!hasApiSecret) missing.push('apiSecret')
    if (!claimSubmitEndpoint) missing.push('claimSubmitEndpoint')
    if (!claimStatusEndpoint) missing.push('claimStatusEndpoint')
    if (!memberLookupEndpoint) missing.push('memberLookupEndpoint')
  }

  if (missing.length) {
    throw new Error(`NHIA configuration is incomplete for ${integrationMode}: ${missing.join(', ')}.`)
  }
}

export const saveNhiaSettings = (settings = {}) => {
  const existing = resolveSettingsRow()
  const timestamp = nowIso()
  const credentialMode = normalizeCredentialMode(settings.credentialMode || settings.credential_mode)
  const incomingCredentials =
    settings.credentials && typeof settings.credentials === 'object'
      ? settings.credentials
      : parseJson(settings.credentialPayload, {})
  const existingCredentials = existing
    ? {
        apiKey: safeDecodeNhiaSecret(existing.api_key_encrypted, 'apiKey'),
        apiSecret: safeDecodeNhiaSecret(existing.api_secret_encrypted, 'apiSecret'),
        headerName: existing.api_key_header_name || '',
        secretHeaderName: existing.api_secret_header_name || '',
        headerPrefix: existing.api_key_header_prefix || '',
        username: existing.username || '',
        password: safeDecodeNhiaSecret(existing.password_encrypted, 'password'),
        tokenEndpointPath: existing.token_endpoint_path || '',
      }
    : {}
  const credentials = { ...existingCredentials }
  for (const [key, value] of Object.entries(incomingCredentials || {})) {
    if (NHIA_SECRET_FIELDS.has(key) && (!normalizeText(value) || isNhiaSecretMask(value))) {
      continue
    }
    if (normalizeText(value)) {
      credentials[key] = value
    }
  }
  const hasApiKey = Boolean(normalizeText(credentials.apiKey))
  const hasApiSecret = Boolean(normalizeText(credentials.apiSecret))
  const shouldWriteApiKey = hasWritableNhiaSecret(credentials, 'apiKey')
  const shouldWriteApiSecret = hasWritableNhiaSecret(credentials, 'apiSecret')
  const shouldWritePassword = hasWritableNhiaSecret(credentials, 'password')
  logNhiaConfigEvent('save started', {
    mode: normalizeText(settings.mode) || 'ONLINE_LOCAL_SYNC',
    saveTarget: 'local_branch_server',
    endpoint: '/api/nhia-config',
    hasApiKey,
    hasApiSecret,
  })
  validateNhiaSettingsForMode({
    ...settings,
    credentials,
    hasApiKey,
    hasApiSecret,
    hasPassword: Boolean(normalizeText(credentials.password)),
  })

  const organizationId = normalizeText(settings.organizationId) || config.organizationId || null
  const branchId = normalizeText(settings.branchId) || config.branchId || null
  const id = settings.id || existing?.id || createId()

  upsertSettings.run({
    id,
    organizationId,
    branchId,
    mode: normalizeText(settings.mode) || 'ONLINE_LOCAL_SYNC',
    facilityCode: normalizeText(settings.facilityCode) || null,
    providerId: normalizeText(settings.providerId || settings.provider_id || settings.providerNumber || settings.provider_number) || null,
    providerNumber: normalizeText(settings.providerNumber || settings.provider_id || settings.providerId) || null,
    hpn: normalizeText(settings.hpn || settings.HPN || settings.providerNumber || settings.provider_number || settings.providerId || settings.provider_id) || null,
    hpCode: normalizeText(settings.hpCode || settings.hp_code || settings.HPCode || settings.facilityCode || settings.facility_code) || null,
    // ✅ NHIA CONFIG PATCH START
    facilityType: normalizeText(settings.facilityType) || null,
    pharmacyFacilityLevel: normalizeText(settings.pharmacyFacilityLevel) || null,
    providerLevelCode: normalizeText(settings.providerLevelCode) || null,
    credentialCode: normalizeText(settings.credentialCode) || normalizeText(settings.facilityCode) || null,
    licenseNumber: normalizeText(settings.licenseNumber) || null,
    accreditationExpiryDate: getAccreditationExpiryDate(settings) || null,
    // ✅ NHIA API ARCHITECTURE PATCH START
    integrationMode: normalizeIntegrationMode(settings.integrationMode || settings.integration_mode || settings.nhiaApiMode || settings.nhia_api_mode),
    connectionProfile: normalizeText(settings.connectionProfile || settings.connection_profile) || 'local_server',
    validationMode: normalizeText(settings.validationMode || settings.validation_mode) || 'validate_before_submit',
    claimControlMode: ['manual', 'claimit_bridge', 'direct_api'].includes(normalizeText(settings.claimControlMode || settings.claim_control_mode))
      ? normalizeText(settings.claimControlMode || settings.claim_control_mode)
      : 'manual',
    sandboxBaseUrl: normalizeText(settings.sandboxBaseUrl).replace(/\/+$/, '') || null,
    // claimitSubmitBaseUrl (CLAIM-it local software URL) is the canonical value here.
    // productionBaseUrl is kept as a fallback for backwards-compatibility.
    productionBaseUrl: normalizeText(
      settings.claimitSubmitBaseUrl || settings.claimit_submit_base_url ||
      settings.productionBaseUrl
    ).replace(/\/+$/, '') || null,
    // ✅ NHIA API ARCHITECTURE PATCH END
    // ✅ NHIA CONFIG PATCH END
    schemeName: normalizeText(settings.schemeName) || 'National Health Insurance',
    providerTypeDescription: normalizeText(settings.providerTypeDescription) || null,
    providerClassLevel: normalizeText(settings.providerClassLevel) || null,
    // ✅ NHIS PHARMACY LEVEL PATCH START
    pharmacyLevel: normalizeText(settings.pharmacyLevel || settings.pharmacy_level) || null,
    // ✅ NHIS PHARMACY LEVEL PATCH END
    claimsOfficerName: normalizeText(settings.claimsOfficerName) || null,
    admissionPaymentOption: normalizeAdmissionPaymentOption(settings.admissionPaymentOption),
    claimitValidationEnabled: settings.claimitValidationEnabled === false ? 0 : 1,
    claimsOfficerSignatureUrl: normalizeText(settings.claimsOfficerSignatureUrl) || null,
    submitterId: normalizeText(settings.submitterId) || null,
    apiBaseUrl: normalizeText(
      settings.apiBaseUrl ||
        (settings.apiEnvironment === 'sandbox' ? settings.sandboxBaseUrl : '')
    ).replace(/\/+$/, '') || null,
    apiKeyEncrypted: shouldWriteApiKey ? encodeNhiaSecret(credentials.apiKey) : existing?.api_key_encrypted || null,
    apiSecretEncrypted: shouldWriteApiSecret ? encodeNhiaSecret(credentials.apiSecret) : existing?.api_secret_encrypted || null,
    hasApiKey: hasApiKey ? 1 : 0,
    hasApiSecret: hasApiSecret ? 1 : 0,
    apiKeyHeaderName: normalizeText(credentials.headerName) || null,
    apiSecretHeaderName: normalizeText(credentials.secretHeaderName) || null,
    apiKeyHeaderPrefix: normalizeText(credentials.headerPrefix) || null,
    username: normalizeText(settings.username || credentials.username) || null,
    passwordEncrypted: shouldWritePassword ? encodeNhiaSecret(credentials.password) : existing?.password_encrypted || null,
    tokenEndpointPath: normalizeText(credentials.tokenEndpointPath) || null,
    claimEndpointPath: normalizeText(settings.claimEndpointPath || settings.claimSubmitEndpoint || settings.claim_submit_endpoint) || null,
    claimSubmitEndpoint: normalizeText(settings.claimSubmitEndpoint || settings.claim_submit_endpoint || settings.claimEndpointPath || settings.claim_endpoint_path) || null,
    claimValidationEndpointPath: normalizeText(settings.claimValidationEndpointPath || settings.claim_validation_endpoint_path) || null,
    ccEndpointPath: normalizeText(settings.ccEndpointPath || settings.cc_endpoint_path || settings.ccCodeEndpointPath || settings.cc_code_endpoint_path) || null,
    ccCodeEndpointPath: normalizeText(settings.ccCodeEndpointPath || settings.cc_code_endpoint_path || settings.ccEndpointPath || settings.cc_endpoint_path) || null,
    claimStatusEndpointPath: normalizeText(settings.claimStatusEndpointPath || settings.claim_status_endpoint_path || settings.claimStatusEndpoint || settings.claim_status_endpoint) || null,
    claimStatusEndpoint: normalizeText(settings.claimStatusEndpoint || settings.claim_status_endpoint || settings.claimStatusEndpointPath || settings.claim_status_endpoint_path) || null,
    memberLookupEndpointPath: normalizeText(settings.memberLookupEndpointPath || settings.member_lookup_endpoint_path || settings.memberLookupEndpoint || settings.member_lookup_endpoint) || null,
    memberLookupEndpoint: normalizeText(settings.memberLookupEndpoint || settings.member_lookup_endpoint || settings.memberLookupEndpointPath || settings.member_lookup_endpoint_path) || null,
    directApiEnabled: toBool(settings.directApiEnabled),
    credentialMode,
    nhisMemberDigits: toDigitLength(settings.nhisMemberDigits, DEFAULT_NHIS_MEMBER_DIGITS),
    ghanaCardDigits: toDigitLength(settings.ghanaCardDigits, DEFAULT_GHANA_CARD_DIGITS),
    exportFormat: normalizeExportFormat(settings.exportFormat),
    maxRetryAttempts: Math.min(Math.max(Number(settings.maxRetryAttempts) || 3, 1), 10),
    createdAt: existing?.created_at || timestamp,
    updatedAt: timestamp,
    updatedBy: normalizeText(settings.updatedBy || settings.updated_by) || null,
  })

  logSubmission({
    action: 'settings.updated',
    status: 'success',
    request: {
      organizationId,
      branchId,
      credentialMode,
      directApiEnabled: Boolean(settings.directApiEnabled),
    },
  })

  const savedRow = selectSettings.get(organizationId, branchId) || selectAnySettings.get()
  queueNhiaConfigSync(savedRow, timestamp)
  const saved = getNhiaSettings()
  logNhiaConfigEvent('save completed', {
    mode: saved?.mode || 'ONLINE_LOCAL_SYNC',
    saveTarget: 'local_branch_server',
    endpoint: '/api/nhia-config',
    saveSuccess: true,
    configSource: 'local_branch_server',
    hasApiKey: saved?.hasApiKey,
    hasApiSecret: saved?.hasApiSecret,
  })
  return saved
}

const mapClaimRow = (row) => ({
  id: row.id,
  claimNumber: row.claim_number,
  localSaleId: row.local_sale_id,
  localSaleNumber: row.local_sale_number,
  batchId: row.batch_id,
  patientId: row.patient_id,
  patientName: row.patient_name,
  memberNumber: row.member_number,
  hin: row.hin,
  ccCode: row.cc_code || '',
  diagnosis: row.diagnosis || '',
  diagnosisDetails: parseJson(row.diagnosis_details_json, []),
  unservedMedicinesNote: row.unserved_medicines_note || '',
  insuranceProvider: row.insurance_provider,
  serviceDate: row.service_date,
  totalAmount: row.total_amount,
  status: row.status,
  payload: parseJson(row.payload_json, {}),
  response: parseJson(row.response_json, null),
  retryCount: row.retry_count,
  nextRetryAt: row.next_retry_at,
  lastError: row.last_error,
  submittedAt: row.submitted_at,
  acceptedAt: row.accepted_at,
  rejectedAt: row.rejected_at,
  paidAt: row.paid_at,
  organizationId: row.organization_id,
  branchId: row.branch_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  items: selectClaimItems.all(row.id).map((item) => ({
    id: item.id,
    claimId: item.nhia_claim_id,
    drugId: item.drug_id,
    drugName: item.drug_name,
    nhiaCode: item.nhia_code,
    quantity: item.quantity,
    unitPrice: item.unit_price,
    totalPrice: item.total_price,
    payload: parseJson(item.payload_json, {}),
    createdAt: item.created_at,
  })),
  services: selectClaimServices.all(row.id).map((service) => ({
    id: service.id,
    claimId: service.nhia_claim_id,
    gdrgCode: service.gdrg_code,
    description: service.description,
    quantity: service.quantity,
    unitPrice: service.unit_price,
    totalAmount: service.total_amount,
    ageBand: service.age_band,
    facilityGroup: service.facility_group,
    cateringOption: service.catering_option,
    mdc: service.mdc,
    serviceDate: service.service_date,
    payload: parseJson(service.payload_json, {}),
    createdAt: service.created_at,
  })),
})

export const listNhiaClaims = ({ status = '', limit = 100 } = {}) => {
  const normalizedStatus = normalizeText(status).toLowerCase()
  const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), MAX_NHIA_CLAIM_READ_LIMIT)
  const rows = normalizedStatus
    ? db.prepare(`${selectClaimsBase} WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(normalizedStatus, cappedLimit)
    : db.prepare(`${selectClaimsBase} ORDER BY created_at DESC LIMIT ?`).all(cappedLimit)

  return rows.map(mapClaimRow)
}

export const getNhiaClaim = (id) => {
  const row = selectClaimById.get(id)
  return row ? mapClaimRow(row) : null
}

const normalizeDirectSubmissionClaimNumber = (claim = {}) =>
  normalizeText(claim.claimNumber || claim.claim_number || claim.claim_no || claim.claimNo)

const normalizeDirectSubmissionClaimId = (value) => {
  if (value && typeof value === 'object') {
    return normalizeText(value.guid || value.id || value.claimID || value.claimId)
  }
  return normalizeText(value)
}

const createClaimItClaimId = (claim = {}, index = 0) => {
  const source = normalizeText(
    claim.claimItClaimId ||
      claim.claimID ||
      claim.claimId ||
      claim.id ||
      claim.localClaimId ||
      claim.claimNumber ||
      claim.claim_number
  )
  if (!source) return ''

  // CLAIM-it relational exports use a GUID-like claimID, separate from the human claim number.
  const seed = `healthflow-claimit-claim:${source}:${normalizeDirectSubmissionClaimNumber(claim)}:${index}`
  let output = ''
  for (let block = 0; output.length < 40; block += 1) {
    let hash = (2166136261 ^ block) >>> 0
    for (let charIndex = 0; charIndex < seed.length; charIndex += 1) {
      const code = seed.charCodeAt(charIndex) + block + charIndex
      hash ^= code
      hash = Math.imul(hash, 16777619) >>> 0
    }
    output += hash.toString(16).padStart(8, '0')
  }
  return output.slice(0, 40)
}

const getExistingPayloadClaimId = (payload = {}, index = 0) =>
  normalizeDirectSubmissionClaimId(
    payload.claims?.[index]?.claimID ||
      payload.claims?.[index]?.guid ||
      payload.claimReferences?.[index]?.claimID ||
      payload.claimReferences?.[index]?.guid ||
      payload.data?.claims?.[index]?.claimID ||
      payload.data?.claims?.[index]?.guid
  )

const resolveDirectSubmissionClaimId = (payload = {}, localClaims = [], claim = {}, index = 0) =>
  normalizeDirectSubmissionClaimId(
    claim.claimID ||
      claim.guid ||
      getExistingPayloadClaimId(payload, index) ||
      localClaims[index]?.claimItClaimId ||
      localClaims[index]?.claimID
  )

const getDirectSubmissionPayloadClaims = (payload = {}) => {
  if (!payload || typeof payload !== 'object') return []
  if (Array.isArray(payload.claims)) return payload.claims
  if (Array.isArray(payload.claimReferences)) return payload.claimReferences
  if (Array.isArray(payload.claim_references)) return payload.claim_references
  if (Array.isArray(payload.data?.claims)) return payload.data.claims
  return [payload]
}

export const withDirectSubmissionClaimIds = (payload = {}, localClaims = []) => {
  if (!payload || typeof payload !== 'object') return payload

  const sourceClaims = Array.isArray(payload.claims) && payload.claims.length
    ? payload.claims
    : Array.isArray(payload.data?.claims) && payload.data.claims.length
      ? payload.data.claims
      : Array.isArray(payload.claimReferences) && payload.claimReferences.length
        ? payload.claimReferences
        : []
  const directClaims = sourceClaims.map((claim, index) => {
    const claimID = resolveDirectSubmissionClaimId(payload, localClaims, claim, index)
    return {
      ...claim,
      claimID,
      claimId: normalizeText(claim.claimId || claim.localClaimId || localClaims[index]?.id),
      localClaimId: normalizeText(claim.localClaimId || claim.claimId || localClaims[index]?.id),
      claimNumber: normalizeDirectSubmissionClaimNumber(claim) || localClaims[index]?.claimNumber,
    }
  })
  const enriched = {
    ...payload,
    claims: directClaims.length ? directClaims : payload.claims,
    claimReferences: Array.isArray(payload.claimReferences)
      ? payload.claimReferences.map((claim, index) => {
          const claimID = directClaims[index]?.claimID || resolveDirectSubmissionClaimId(payload, localClaims, claim, index)
          return {
            ...claim,
            claimId: normalizeText(claim.claimId || claim.localClaimId || localClaims[index]?.id),
            localClaimId: normalizeText(claim.localClaimId || claim.claimId || localClaims[index]?.id),
            claimID,
          }
        })
      : payload.claimReferences,
  }

  if (payload.data && typeof payload.data === 'object' && Array.isArray(payload.data.claims)) {
    enriched.data = {
      ...payload.data,
      claims: payload.data.claims.map((claim, index) => {
        const claimItId = directClaims[index]?.claimID || resolveDirectSubmissionClaimId(payload, localClaims, claim, index)
        const localClaimId = normalizeText(claim.claimId || claim.localClaimId || localClaims[index]?.id)
        return {
          ...claim,
          claimID: claimItId,
          claimId: localClaimId,
          localClaimId,
        }
      }),
    }
  }

  return enriched
}

const getDirectSubmissionClaimAudit = (payload = {}, localClaims = []) =>
  getDirectSubmissionPayloadClaims(payload).map((claim, index) => ({
    internalClaimId: localClaims[index]?.id || normalizeText(claim.claimId || claim.localClaimId),
    claim_number: localClaims[index]?.claimNumber || normalizeDirectSubmissionClaimNumber(claim),
    claimID: normalizeDirectSubmissionClaimId(claim.claimID || payload.data?.claims?.[index]?.claimID),
    submissionRoute: 'direct_api_submission',
  }))

const assertDirectSubmissionClaimIds = (payload = {}, localClaims = []) => {
  const audit = getDirectSubmissionClaimAudit(payload, localClaims)
  const missing = audit.filter((claim) => !claim.claimID)
  if (missing.length) {
    throw new Error(CLAIMIT_MISSING_CLAIM_ID_MESSAGE)
  }
  return audit
}

const repairNhiaClaimPayloadClaimId = (claimId, claimID) => {
  const claim = getNhiaClaim(claimId)
  if (!claim || !claimID) return false
  const payload = claim.payload && typeof claim.payload === 'object' ? claim.payload : {}
  if (normalizeDirectSubmissionClaimId(payload.claimID || payload.claimId) === claimID) return false

  updateClaimPayloadJson.run(json({
    ...payload,
    claimID,
    claimItClaimId: claimID,
  }), nowIso(), claimId)
  return true
}

export const repairMissingNhiaClaimIds = (claimIds = []) => {
  const normalizedClaimIds = Array.isArray(claimIds)
    ? claimIds.map((id) => normalizeText(id)).filter(Boolean)
    : []
  const targetClaims = normalizedClaimIds.length
    ? resolveDirectSubmissionLocalClaims(normalizedClaimIds)
    : listNhiaClaims({ limit: MAX_NHIA_CLAIM_READ_LIMIT }).map((claim) => ({
        id: claim.id,
        claimNumber: claim.claimNumber,
        claimItClaimId: normalizeDirectSubmissionClaimId(claim.payload?.claimID || claim.payload?.claimItClaimId),
        source: 'nhia_claims',
      }))
  let repaired = 0

  targetClaims.forEach((claim, index) => {
    if (claim.source !== 'nhia_claims') return
    const claimID = normalizeDirectSubmissionClaimId(claim.claimItClaimId) || createClaimItClaimId(claim, index)
    if (repairNhiaClaimPayloadClaimId(claim.id, claimID)) {
      repaired += 1
    }
  })

  return { checked: targetClaims.length, repaired }
}

export const resolveDirectSubmissionLocalClaims = (claimIds = []) =>
  claimIds.map((id) => {
    const claim = getNhiaClaim(id)
    if (claim) {
      return {
        id: claim.id,
        claimNumber: normalizeDirectSubmissionClaimNumber(claim),
        claimItClaimId: normalizeDirectSubmissionClaimId(claim.payload?.claimID || claim.payload?.claimItClaimId),
        source: 'nhia_claims',
      }
    }

    const offlineClaim = getOfflineRecord('nhis_claims', id)
    if (offlineClaim) {
      return {
        id: offlineClaim.id,
        claimNumber: normalizeDirectSubmissionClaimNumber(offlineClaim),
        claimItClaimId: normalizeDirectSubmissionClaimId(offlineClaim.claimID || offlineClaim.claim_id || offlineClaim.claimItClaimId),
        source: 'offline_nhis_claims',
      }
    }

    throw new Error('Direct NHIA submission can only submit existing local claims.')
  })

const buildClaimPayload = ({ claim, items, services = [], settings }) => ({
  claimNumber: claim.claimNumber,
  facilityCode: settings?.facilityCode || '',
  providerNumber: settings?.providerNumber || '',
  schemeName: settings?.schemeName || 'National Health Insurance',
  providerTypeDescription: settings?.providerTypeDescription || '',
  providerClassLevel: settings?.providerClassLevel || '',
  claimsOfficerName: settings?.claimsOfficerName || '',
  admissionPaymentOption: settings?.admissionPaymentOption || 'nhis_pays_admission',
  claimitValidationEnabled: settings?.claimitValidationEnabled !== false && settings?.claimitValidationEnabled !== 0,
  claimsOfficerSignatureUrl: settings?.claimsOfficerSignatureUrl || '',
  submitterId: settings?.submitterId || '',
  organizationType: normalizeOrganizationType(claim.organizationType || claim.payload?.organizationType),
  patient: {
    id: claim.patientId || null,
    name: claim.patientName,
    memberNumber: claim.memberNumber,
    hin: claim.hin || null,
    ccCode: claim.ccCode || null,
  },
  ccCode: claim.ccCode || null,
  diagnosis: normalizeOrganizationType(claim.organizationType || claim.payload?.organizationType) === 'hospital'
    ? claim.diagnosis || null
    : null,
  diagnosisDetails: normalizeOrganizationType(claim.organizationType || claim.payload?.organizationType) === 'hospital'
    ? normalizeDiagnosisDetails(claim.diagnosisDetails || claim.payload?.diagnosisDetails)
    : [],
  serviceDate: claim.serviceDate,
  totalAmount: claim.totalAmount,
  localSaleNumber: claim.localSaleNumber || null,
  claimID: normalizeDirectSubmissionClaimId(claim.claimID || claim.claimItClaimId) ||
    createClaimItClaimId(claim, 0),
  claimItClaimId: normalizeDirectSubmissionClaimId(claim.claimID || claim.claimItClaimId) ||
    createClaimItClaimId(claim, 0),
  items: items.map((item) => ({
    drugId: item.drugId || null,
    code: item.nhiaCode || null,
    name: item.drugName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    totalPrice: item.totalPrice,
  })),
  services: services.map((service) => ({
    code: service.gdrgCode || null,
    description: service.description,
    quantity: service.quantity,
    unitPrice: service.unitPrice,
    totalAmount: service.totalAmount,
    ageBand: service.ageBand || null,
    facilityGroup: service.facilityGroup || null,
    cateringOption: service.cateringOption || null,
    mdc: service.mdc || null,
    serviceDate: service.serviceDate || claim.serviceDate,
  })),
})

export const createNhiaClaim = db.transaction((claimData = {}, linkedSale = {}) => {
  const timestamp = nowIso()
  const claimId = createId()
  const claimNumber = claimData.claimNumber || createClaimNumber()
  const settings = getNhiaSettings()
  const organizationType = normalizeOrganizationType(claimData.organizationType || claimData.organization_type)
  const sourceItems = Array.isArray(claimData.items) ? claimData.items : []
  const sourceServices = organizationType === 'hospital' && Array.isArray(claimData.services)
    ? claimData.services
    : []
  if (!sourceItems.length && !sourceServices.length) {
    throw new Error('At least one NHIA claim medicine or hospital service is required.')
  }
  const diagnosisDetails = organizationType === 'hospital'
    ? normalizeDiagnosisDetails(claimData.diagnosisDetails || claimData.diagnosis_details)
    : []
  let totalAmount = 0

  const items = sourceItems.map((item) => {
    const drugId = item.drugId || item.id || null
    const submittedCode = normalizeText(item.nhiaCode || item.nhisCode)
    const drug = (drugId ? getDrug.get(drugId) : null) ||
      (submittedCode ? getDrugByNhisCode.get(submittedCode) : null)
    const quantity = assertPositiveQuantity(item.quantity, 'NHIA claim item quantity')
    const submittedUnitPrice = toMoney(item.nhiaPrice ?? item.price ?? item.unitPrice, -1)
    const catalogUnitPrice = toMoney(drug?.nhis_price ?? drug?.price, -1)
    if (
      catalogUnitPrice >= 0 &&
      submittedUnitPrice >= 0 &&
      Math.abs(catalogUnitPrice - submittedUnitPrice) > 0.01
    ) {
      throw new Error(`NHIA claim item price does not match the local catalogue for ${submittedCode || drug?.name || 'medicine'}.`)
    }
    const unitPrice = catalogUnitPrice >= 0 ? catalogUnitPrice : submittedUnitPrice
    if (unitPrice < 0) {
      throw new Error('NHIA claim item price is required and cannot be negative.')
    }

    const totalPrice = toMoney(quantity * unitPrice)
    totalAmount = toMoney(totalAmount + totalPrice)

    return {
      id: createId(),
      claimId,
      drugId,
      drugName: assertRequiredText(item.name || drug?.name, 'NHIA claim item name'),
      nhiaCode: normalizeText(item.nhiaCode || item.nhisCode || drug?.nhis_code) || null,
      quantity,
      unitPrice,
      totalPrice,
      payloadJson: json(item),
      createdAt: timestamp,
    }
  })
  const services = sourceServices.map((service) => {
    const quantity = assertPositiveQuantity(service.quantity ?? 1, 'NHIA service quantity')
    const unitPrice = toMoney(service.unitPrice ?? service.unit_price, -1)
    if (unitPrice < 0) {
      throw new Error('NHIA service unit price is required and cannot be negative.')
    }
    const totalAmount = toMoney(quantity * unitPrice)
    return {
      id: createId(),
      claimId,
      gdrgCode: normalizeText(service.gdrgCode || service.gdrg_code) || null,
      description: assertRequiredText(service.description, 'NHIA service description'),
      quantity,
      unitPrice,
      totalAmount,
      ageBand: normalizeText(service.ageBand || service.age_band) || null,
      facilityGroup: normalizeText(service.facilityGroup || service.facility_group) || null,
      cateringOption: normalizeText(service.cateringOption || service.catering_option) || null,
      mdc: normalizeText(service.mdc) || null,
      serviceDate: normalizeNhiaServiceDate(service.serviceDate || service.service_date || claimData.serviceDate) || null,
      payloadJson: json(service),
      createdAt: timestamp,
    }
  })
  totalAmount = toMoney(
    totalAmount + services.reduce((sum, service) => sum + service.totalAmount, 0)
  )

  const claim = {
    id: claimId,
    claimNumber,
    localSaleId: claimData.localSaleId || linkedSale.id || null,
    localSaleNumber: claimData.localSaleNumber || linkedSale.saleNumber || null,
    patientId: claimData.patientId || linkedSale.patientId || null,
    patientName: assertRequiredText(claimData.patientName, 'NHIA patient name'),
    memberNumber: assertValidMemberNumber(
      claimData.memberNumber || claimData.insuranceId || claimData.memberNo,
      settings
    ),
    cardType: normalizeText(claimData.cardType || claimData.card_type) || null,
    hin: normalizeText(claimData.hin) || null,
    ccCode: normalizeOptionalCcCode(claimData.ccCode || claimData.cc_code),
    nhiaAuthId: normalizeText(claimData.authId || claimData.nhiaAuthId || claimData.nhia_auth_id) || null,
    nhiaAuthType: normalizeText(claimData.authType || claimData.nhiaAuthType || claimData.nhia_auth_type) || null,
    nhiaNewCccStatus: normalizeText(claimData.newCcc || claimData.nhiaNewCccStatus || claimData.nhia_new_ccc_status) || null,
    nhiaOtac: normalizeText(claimData.otacCode || claimData.nhiaOtac || claimData.nhia_otac) || null,
    nhiaAttendanceDate: normalizeText(claimData.nhiaAttendanceDate || claimData.nhia_attendance_date) || null,
    nhiaAttendanceVerificationStatus: normalizeText(
      claimData.attendanceVerificationStatus ||
        claimData.nhiaAttendanceVerificationStatus ||
        claimData.nhia_attendance_verification_status
    ) || null,
    nhiaAttendanceVerificationSource: normalizeText(
      claimData.attendanceVerificationSource ||
        claimData.nhiaAttendanceVerificationSource ||
        claimData.nhia_attendance_verification_source
    ) || null,
    diagnosis: organizationType === 'hospital' ? normalizeText(claimData.diagnosis) || null : null,
    diagnosisDetails,
    diagnosisDetailsJson: json(diagnosisDetails),
    unservedMedicinesNote: normalizeText(
      claimData.unservedMedicinesNote || claimData.unserved_medicines_note
    ) || null,
    insuranceProvider: claimData.insuranceProvider || 'NHIA',
    serviceDate: normalizeNhiaServiceDate(claimData.serviceDate || linkedSale.saleDate || timestamp) || toNhisCalendarDate(),
    totalAmount,
    status: normalizeStatus(claimData.status || 'ready'),
    organizationId: claimData.organizationId || linkedSale.organizationId || config.organizationId,
    branchId: claimData.branchId || linkedSale.branchId || config.branchId,
    createdBy: claimData.createdBy || claimData.submittedBy || linkedSale.soldBy || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  claim.payloadJson = json(buildClaimPayload({
    claim: { ...claim, organizationType },
    items,
    services,
    settings,
  }))

  insertClaim.run(claim)
  for (const item of items) {
    insertClaimItem.run(item)
  }
  for (const service of services) {
    insertClaimService.run(service)
  }

  logSubmission({
    claimId,
    action: 'claim.saved',
    status: 'success',
    request: {
      claimNumber,
      localSaleNumber: claim.localSaleNumber,
      itemCount: items.length,
      totalAmount,
    },
  })

  return getNhiaClaim(claimId)
})

export const markNhiaClaimReady = (id) => {
  const timestamp = nowIso()
  markClaimReadyStatement.run(timestamp, id)
  logSubmission({ claimId: id, action: 'claim.ready', status: 'success' })
  return getNhiaClaim(id)
}

const validateSettingsForSubmission = (settings) => {
  if (!settings) {
    throw new Error('NHIA settings are required before submitting claims.')
  }

  assertRequiredText(settings.facilityCode, 'NHIA facility code')
  assertRequiredText(settings.providerNumber, 'NHIA provider number')

  if (normalizeIntegrationMode(settings.integrationMode || settings.integration_mode, '') === 'claimit_export') {
    throw new Error(CLAIMIT_CXF_API_BLOCK_MESSAGE)
  }

  if (settings.directApiEnabled) {
    assertRequiredText(settings.apiBaseUrl, 'NHIA API base URL')
    const credentials = settings.credentials || {}
    assertRequiredText(credentials.apiKey, 'NHIA CCC API key')
    assertRequiredText(credentials.apiSecret, 'NHIA CCC API secret')
    if (settings.credentialMode === 'bearer_token') {
      assertRequiredText(credentials.apiKey || credentials.token, 'NHIA bearer token')
    } else if (settings.credentialMode === 'oauth_client') {
      assertRequiredText(credentials.clientId, 'NHIA client ID')
      assertRequiredText(credentials.clientSecret, 'NHIA client secret')
    } else if (settings.credentialMode === 'basic_auth') {
      assertRequiredText(credentials.username, 'NHIA username')
      assertRequiredText(credentials.password, 'NHIA password')
    } else if (settings.credentialMode === 'claimit_token') {
      assertRequiredText(credentials.username, 'CLAIM-it username')
      assertRequiredText(credentials.password, 'CLAIM-it password')
    }
  }
}

const isClaimItCxfImportPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return false
  const payloadFormat = normalizeText(payload.payloadFormat || payload.payload_format).toLowerCase()
  const hasDirectClaimArray = Array.isArray(payload.claims) && payload.claims.length > 0
  if (payloadFormat.includes('cxf')) return true
  if (payload.cxfBundleBase64 || payload.cxf_bundle_base64 || payload.cxfContent || payload.cxf_content) return true
  const data = payload.data && typeof payload.data === 'object' ? payload.data : null
  if (!data) return false
  return !hasDirectClaimArray && (Array.isArray(data.validation_zclaims) || Array.isArray(data.attachmentdata))
}

const validateSettingsForBatchExport = (settings) => {
  if (!settings) {
    throw new Error('NHIA settings are required before exporting claim batches.')
  }

  assertRequiredText(settings.facilityCode, 'NHIA facility code')
  assertRequiredText(settings.providerNumber, 'NHIA provider number')
}

const getClinicalRulesForSubmission = () => {
  const pulledRules = selectLocalClinicalRules
    .all()
    .map((row) => parseJson(row.payload_json, null))
    .filter(Boolean)
  const rules = normalizeClinicalRules(pulledRules)
  return rules.length ? rules : normalizeClinicalRules(DIAGNOSIS_TREATMENT_RULES)
}

const getDiagnosisTreatmentMismatchBlockers = (claim, items = [], rules = getClinicalRulesForSubmission()) => {
  const diagnosis = normalizeMatchText(claim.diagnosis || claim.payload?.diagnosis)
  if (!diagnosis) return []

  const matchedRules = normalizeClinicalRules(rules).filter((rule) =>
    rule.diagnosis.some((keyword) => diagnosis.includes(keyword))
  )
  if (!matchedRules.length) return []

  const treatmentText = normalizeMatchText(
    (items || [])
      .map((item) => {
        const payload = item?.payload || {}
        return [
          item?.drugName,
          item?.nhiaCode,
          payload.name,
          payload.description,
          payload.genericName,
          payload.generic_name,
          payload.nhiaCode,
          payload.nhisCode,
        ].filter(Boolean).join(' ')
      })
      .join(' ')
  )
  const treatmentCodes = new Set(
    (items || [])
      .map((item) => normalizeText(item?.nhiaCode || item?.payload?.nhiaCode || item?.payload?.nhisCode).toUpperCase())
      .filter(Boolean)
  )

  return matchedRules
    .filter((rule) => {
      if (rule.severity !== 'block') return false
      const codeMatches = rule.drugCodes.length && rule.drugCodes.some((code) => treatmentCodes.has(code))
      const keywordMatches = rule.treatments.length && rule.treatments.some((keyword) => treatmentText.includes(normalizeMatchText(keyword)))
      return !codeMatches && !keywordMatches
    })
    .map((rule) => `${rule.label}: treatment does not appear to match the diagnosis. Correct the diagnosis or add a matching medicine before final submission/export.`)
}

const validateClaimForSubmission = (claim, settings) => {
  const organizationType = normalizeOrganizationType(
    claim.organizationType || claim.payload?.organizationType || claim.payload?.organization_type
  )
  assertRequiredText(claim.patientName, 'NHIA patient name')
  assertValidMemberNumber(claim.memberNumber, settings)
  assertRequiredText(claim.serviceDate, 'NHIA service date')
  assertValidCcCode(claim.ccCode || claim.payload?.ccCode || claim.payload?.cc_code)
  if (organizationType === 'hospital') {
    assertRequiredText(claim.diagnosis || claim.payload?.diagnosis, 'NHIA diagnosis')
  }
  if (!claim.items.length && !claim.services.length) {
    throw new Error('NHIA claim requires at least one medicine or hospital service.')
  }

  for (const item of claim.items) {
    assertRequiredText(item.drugName, 'NHIA claim item name')
    assertPositiveQuantity(item.quantity, 'NHIA claim item quantity')
    if (toMoney(item.totalPrice, -1) < 0) {
      throw new Error('NHIA claim item amount cannot be negative.')
    }
  }

  if (organizationType === 'hospital') {
    const mismatchBlockers = getDiagnosisTreatmentMismatchBlockers(claim, claim.items)
    if (mismatchBlockers.length) {
      throw new Error(`Final NHIA check failed: ${mismatchBlockers.slice(0, 3).join(' ')}`)
    }
  }

  return buildClaimPayload({
    claim,
    items: claim.items,
    services: claim.services,
    settings,
  })
}

const buildHeaders = (settings) => {
  const credentials = settings.credentials || {}
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  const applyBasicCredentialsHeader = () => {
    const username = normalizeText(credentials.username)
    const password = normalizeText(credentials.password)
    if ((username || password) && !headers.Authorization) {
      const token = Buffer.from(`${username}:${password}`).toString('base64')
      headers.Authorization = `Basic ${token}`
    }
  }

  if (settings.credentialMode === 'api_key') {
    const hasBasicCredentials = Boolean(normalizeText(credentials.username) || normalizeText(credentials.password))
    const configuredHeaderName = normalizeText(credentials.headerName)
    const headerName = configuredHeaderName || (hasBasicCredentials ? 'x-api-key' : 'Authorization')
    const prefix = normalizeText(credentials.headerPrefix) ||
      (!configuredHeaderName && headerName.toLowerCase() === 'authorization' ? 'Bearer' : '')
    headers[headerName] = prefix ? `${prefix} ${credentials.apiKey}` : credentials.apiKey
    const apiSecret = normalizeText(credentials.apiSecret)
    const secretHeaderName = normalizeText(credentials.secretHeaderName) || 'x-api-secret'
    if (apiSecret) headers[secretHeaderName] = apiSecret
    applyBasicCredentialsHeader()
  } else if (settings.credentialMode === 'bearer_token') {
    const token = normalizeText(credentials.apiKey || credentials.token)
    if (token) headers.Authorization = `Bearer ${token}`
  } else if (settings.credentialMode === 'oauth_client') {
    headers['x-client-id'] = credentials.clientId
    headers['x-client-secret'] = credentials.clientSecret
    const token = normalizeText(credentials.accessToken || credentials.token || credentials.apiKey)
    if (token) headers.Authorization = `Bearer ${token}`
  } else if (settings.credentialMode === 'basic_auth') {
    const token = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')
    headers.Authorization = `Basic ${token}`
  }

  return headers
}

const hasClaimItTokenCredentials = (settings = {}) => {
  const credentials = settings.credentials || {}
  return Boolean(normalizeText(credentials.username) && normalizeText(credentials.password))
}

export const buildClaimItAuthorizationHeader = (token) => normalizeText(token)

const buildClaimItSubmissionHeaders = async (settings, contentType = 'application/json') => {
  if (!hasClaimItTokenCredentials(settings)) {
    return {
      ...buildHeaders(settings),
      'Content-Type': contentType,
    }
  }

  return {
    'Content-Type': contentType,
    // CLAIM-it/IIS rejects a strict application/json Accept with HTTP 406; mirror
    // the HMS curl client (Accept: */*) so claim submission is not refused.
    Accept: '*/*',
    Authorization: buildClaimItAuthorizationHeader(await fetchClaimItToken(settings)),
  }
}

const postWithCertificate = (url, body, settings) =>
  new Promise((resolve, reject) => {
    const credentials = settings.credentials || {}
    const parsedUrl = new URL(url)
    const request = https.request(
      {
        method: 'POST',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        cert: credentials.certPem,
        key: credentials.keyPem,
        ca: credentials.caPem || undefined,
        passphrase: credentials.passphrase || undefined,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, text })
        })
      }
    )
    request.on('error', reject)
    request.write(body)
    request.end()
  })

// Returns the base URL for claim submission (CLAIM-it local software).
// Prefers claimitSubmitBaseUrl (localhost:31719/json-api) over apiBaseUrl
// (NHIA eligibility server) so the two APIs are never mixed up.
const getClaimSubmitBaseUrl = (settings) =>
  normalizeText(settings.claimitSubmitBaseUrl || settings.productionBaseUrl || settings.apiBaseUrl)

const getClaimItTransportErrorMessage = (error, url) => {
  const code = normalizeText(error?.cause?.code || error?.code)
  const target = normalizeText(url)

  if (code === 'ECONNREFUSED') {
    return `CLAIM-it local bridge is not reachable at ${target}. Confirm CLAIM-it is running on this machine and the saved CLAIM-it base URL is correct.`
  }
  if (code === 'ENOTFOUND') {
    return `CLAIM-it host could not be resolved for ${target}. Check the saved CLAIM-it base URL.`
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `CLAIM-it request timed out at ${target}. Confirm CLAIM-it is running and reachable from this machine.`
  }

  return `CLAIM-it request failed at ${target}: ${error?.message || 'network request failed'}.`
}

export const getClaimItUpstreamErrorMessage = (body) => {
  if (!body) return ''
  if (typeof body === 'string') return normalizeText(body)
  if (typeof body !== 'object') return normalizeText(body)

  return normalizeText(
    body.user_msg ||
      body.userMessage ||
      body.message ||
      body.error ||
      body.detail ||
      body.raw ||
      body.statusMessage
  )
}

const collectClaimItMessages = (value, messages = [], path = '', depth = 0) => {
  if (messages.length >= 8 || depth > 6 || !value) return messages
  if (typeof value === 'string') {
    const text = normalizeText(value)
    if (
      text &&
      text.length <= 300 &&
      !/^data:/i.test(text) &&
      !/^[A-Za-z0-9+/=]{120,}$/.test(text)
    ) {
      messages.push(path ? `${path}: ${text}` : text)
    }
    return messages
  }
  if (typeof value !== 'object') return messages

  const messageKeys = new Set([
    'user_msg',
    'userMessage',
    'message',
    'error',
    'detail',
    'reason',
    'statusMessage',
    'validationMessage',
    'validationError',
    'remarks',
    'remark',
    'description',
    // CLAIM-it per-claim validation results: claims[].claim.errors[]/warnings[] = { code, info, help }
    'info',
    'help',
    'code',
  ])
  for (const [key, nestedValue] of Object.entries(value)) {
    if (messages.length >= 8) break
    const nextPath = path ? `${path}.${key}` : key
    if (messageKeys.has(key)) {
      collectClaimItMessages(nestedValue, messages, nextPath, depth + 1)
      continue
    }
    if (Array.isArray(nestedValue) || (nestedValue && typeof nestedValue === 'object')) {
      collectClaimItMessages(nestedValue, messages, nextPath, depth + 1)
    }
  }

  return messages
}

export const getClaimItDetailedErrorMessage = (body) =>
  [...new Set(collectClaimItMessages(body).map(normalizeText).filter(Boolean))]
    .slice(0, 5)
    .join(' | ')

const buildClaimItHttpError = (label, status, body) => {
  const upstreamMessage = getClaimItDetailedErrorMessage(body) || getClaimItUpstreamErrorMessage(body)
  return `${label} returned HTTP ${status}${upstreamMessage ? `: ${upstreamMessage}` : ''}.`
}

const decodeXmlText = (value = '') =>
  String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

const getXmlElementText = (xml, names = []) => {
  for (const name of names) {
    const match = String(xml || '').match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))
    if (match) return decodeXmlText(match[1].replace(/<[^>]+>/g, '').trim())
  }
  return ''
}

const parseClaimItResponse = (text = '') => {
  const parsed = parseJson(text, null)
  if (parsed && typeof parsed === 'object') return parsed
  const xml = normalizeText(text)
  if (!xml.startsWith('<')) return { raw: text }

  const savedClaims = Number(getXmlElementText(xml, ['savedClaims', 'SavedClaims', 'saved_claims']) || 0)
  const passedClaims = Number(getXmlElementText(xml, ['passedClaims', 'PassedClaims', 'passed_claims']) || 0)
  const failedClaims = Number(getXmlElementText(xml, ['failedClaims', 'FailedClaims', 'failed_claims']) || 0)
  const successText = getXmlElementText(xml, ['success', 'Success'])
  const message = getXmlElementText(xml, ['user_msg', 'userMessage', 'message', 'Message', 'error', 'Error'])
  return {
    savedClaims,
    passedClaims,
    failedClaims,
    success: /^(true|1|yes)$/i.test(successText),
    ...(message ? { message } : {}),
    raw: text,
  }
}

const getClaimItTransportBaseUrl = (baseUrl, contentType = 'application/json') => {
  const normalized = normalizeText(baseUrl).replace(/\/+$/, '')
  return normalizeText(contentType).toLowerCase().includes('xml')
    ? normalized.replace(/\/json-api$/i, '/xml-api')
    : normalized
}

const submitPayload = async (
  settings,
  payload,
  endpointPathOverride = '',
  { payloadContent = '', contentType = 'application/json' } = {}
) => {
  const endpointPath = normalizeText(endpointPathOverride || settings.claimEndpointPath)
  if (!endpointPath) {
    throw new Error('NHIA endpoint path is required. Enter the official endpoint path from NHIA/CLAIM-it.')
  }
  const baseUrl = getClaimSubmitBaseUrl(settings)
  if (!baseUrl) {
    throw new Error('CLAIM-it submit base URL is not configured. Set the CLAIM-it local submit URL in NHIA settings.')
  }
  const transportBaseUrl = getClaimItTransportBaseUrl(baseUrl, contentType)
  const url = `${transportBaseUrl}/${endpointPath.replace(/^\/+/, '')}`
  const isXml = normalizeText(contentType).toLowerCase().includes('xml')
  const body = isXml ? payloadContent : JSON.stringify(payload)

  if (settings.credentialMode === 'custom' && settings.credentials?.certPem && settings.credentials?.keyPem) {
    const response = await postWithCertificate(url, body, settings)
    return {
      endpoint: url,
      httpStatus: response.status,
      ok: response.ok,
      body: parseClaimItResponse(response.text),
    }
  }

  const headers = await buildClaimItSubmissionHeaders(settings, contentType)

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
    })
  } catch (error) {
    throw new Error(getClaimItTransportErrorMessage(error, url))
  }
  const text = await response.text()
  return {
    endpoint: url,
    httpStatus: response.status,
    ok: response.ok,
    body: parseClaimItResponse(text),
  }
}

const isClaimItBridgeMode = (settings) =>
  normalizeIntegrationMode(settings?.integrationMode) === 'claimit_bridge'

const isValidEndpointPath = (value) => {
  const v = normalizeText(value)
  if (!v) return false
  // Reject values that look like emails, URLs with dots but no slash, or plain text
  if (v.includes('@')) return false
  if (/^https?:\/\//i.test(v)) return false
  // Must start with / or be a simple path segment
  return v.startsWith('/') || /^[a-zA-Z0-9_-]/.test(v)
}

const getCcEndpointPath = (settings) => {
  const value = normalizeText(
    settings?.ccEndpointPath ||
    settings?.cc_endpoint_path ||
    settings?.ccCodeEndpointPath ||
    settings?.cc_code_endpoint_path
  )
  return isValidEndpointPath(value) ? value : ''
}

const getNhiaEligibilityBaseUrl = () =>
  (normalizeText(config.nhiaEligibilityBaseUrl) || DEFAULT_NHIA_API_BASE_URL).replace(/\/+$/, '')

const getNhiaMemberLookupEndpointPath = () => DEFAULT_NHIA_MEMBER_LOOKUP_ENDPOINT

const validateClaimItBridgePayload = async (
  settings,
  payload,
  { payloadContent = '', contentType = 'application/json' } = {}
) => {
  const endpointPath = normalizeText(settings.claimValidationEndpointPath)
  const validationMode = normalizeText(settings.validationMode) || 'validate_before_submit'
  if (!isClaimItBridgeMode(settings) || validationMode === 'submit_only' || !endpointPath) return
  const result = await submitPayload(settings, payload, endpointPath, {
    payloadContent,
    contentType,
  })
  if (!result.ok) {
    throw new Error(buildClaimItHttpError('CLAIM-it validation', result.httpStatus, result.body))
  }
}

const shouldTryNextClaimItTokenRequest = (status) =>
  [400, 404, 405, 406, 415].includes(Number(status))

export const buildClaimItTokenRequestCandidates = ({ baseUrl, tokenPath = '/token', username, password } = {}) => {
  const tokenUrl = `${normalizeText(baseUrl).replace(/\/+$/, '')}/${normalizeText(tokenPath || '/token').replace(/^\/+/, '')}`
  const queryUrl = new URL(tokenUrl)
  queryUrl.searchParams.set('username', username)
  queryUrl.searchParams.set('password', password)
  const formBody = new URLSearchParams({ username, password }).toString()

  // CLAIM-it/IIS returns HTTP 406 (Not Acceptable) when the Accept header does
  // not match what the endpoint produces. A PHP curl client (as the HMS uses)
  // defaults to Accept: */*, so mirror that to avoid content-negotiation rejection.
  return [
    {
      label: 'query POST',
      url: queryUrl,
      init: {
        method: 'POST',
        headers: { Accept: '*/*' },
      },
    },
    {
      label: 'form POST',
      url: new URL(tokenUrl),
      init: {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: formBody,
      },
    },
    {
      label: 'json POST',
      url: new URL(tokenUrl),
      init: {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      },
    },
    {
      label: 'query GET',
      url: queryUrl,
      init: {
        method: 'GET',
        headers: { Accept: '*/*' },
      },
    },
  ]
}

const fetchClaimItToken = async (settings) => {
  const credentials = settings.credentials || {}
  const username = assertRequiredText(credentials.username, 'CLAIM-it username')
  const password = assertRequiredText(credentials.password, 'CLAIM-it password')
  const tokenPath = normalizeText(credentials.tokenEndpointPath) || '/token'

  const failures = []
  const candidates = buildClaimItTokenRequestCandidates({
    baseUrl: getClaimSubmitBaseUrl(settings).replace(/\/xml-api$/i, '/json-api'),
    tokenPath,
    username,
    password,
  })

  for (const candidate of candidates) {
    let response
    try {
      response = await fetch(candidate.url, candidate.init)
    } catch (error) {
      throw new Error(getClaimItTransportErrorMessage(error, candidate.url.toString()))
    }

    const text = await response.text()
    const body = parseJson(text, { raw: text })

    if (!response.ok) {
      const upstreamMessage = getClaimItUpstreamErrorMessage(body)
      failures.push(`${candidate.label} HTTP ${response.status}${upstreamMessage ? `: ${upstreamMessage}` : ''}`)
      if (shouldTryNextClaimItTokenRequest(response.status)) {
        continue
      }
      throw new Error(buildClaimItHttpError('CLAIM-it token request', response.status, body))
    }

    const token = normalizeText(body?.token)
    if (!token) {
      throw new Error('CLAIM-it token response did not include a token.')
    }

    return token
  }

  throw new Error(`CLAIM-it token request failed. Tried: ${failures.join('; ')}.`)
}

const getClaimItSubmissionCounts = (body = {}) => ({
  failedClaims: Number(body?.failedClaims || 0),
  passedClaims: Number(body?.passedClaims || 0),
  savedClaims: Number(body?.savedClaims || 0),
})

export const getClaimItSubmissionAcceptanceError = (body) => {
  const { failedClaims, passedClaims, savedClaims } = getClaimItSubmissionCounts(body)
  if (savedClaims > 0 || passedClaims > 0) return ''

  const upstreamMessage = getClaimItDetailedErrorMessage(body) || getClaimItUpstreamErrorMessage(body)
  if (upstreamMessage) return upstreamMessage
  if (!body || typeof body !== 'object') {
    return 'CLAIM-it did not return a claim submission result.'
  }
  if (failedClaims > 0) {
    return 'CLAIM-it rejected all submitted claims.'
  }
  if (body.success === true) {
    return 'CLAIM-it returned success but did not report any saved or passed claims.'
  }
  return 'CLAIM-it did not confirm that any submitted claims were saved.'
}

const assertClaimItSubmissionAccepted = (body) => {
  const message = getClaimItSubmissionAcceptanceError(body)
  if (message) {
    throw new Error(`CLAIM-it did not save the claim batch: ${message}`)
  }
}

const deriveRemoteStatus = (body) => {
  // CLAIM-it API v1.0.0 response: { passedClaims, failedClaims, savedClaims, success, claims[] }
  if (body && typeof body === 'object') {
    const { failedClaims, passedClaims, savedClaims } = getClaimItSubmissionCounts(body)
    if (failedClaims > 0 && savedClaims === 0 && passedClaims === 0) return 'rejected'
    if (savedClaims > 0 || passedClaims > 0) return 'submitted'
    if (body.success === false || body.failed === true) return 'rejected'
  }
  const value = normalizeText(body?.status || body?.claimStatus || body?.state).toLowerCase()
  if (value.includes('paid')) return 'paid'
  if (value.includes('reject')) return 'rejected'
  if (value.includes('accept') || value.includes('approve')) return 'accepted'
  if (value.includes('submit') || value.includes('saved') || value.includes('passed')) return 'submitted'
  return 'failed'
}

// Maps the NHIA member verification response (checkcccode / member lookup) to a
// normalised object. The NHIA API returns MobCCC as the CC code field.
const mapNhiaMemberLookupResponse = (body) => {
  if (!body || typeof body !== 'object') return null
  const hin = normalizeText(
    body.HIN ||
      body.hin ||
      body.HINNo ||
      body.hinNo ||
      body.hin_no ||
      body.CardSerialNo ||
      body.cardSerialNo ||
      body.card_serial_no ||
      body.CardSerialNumber ||
      body.cardSerialNumber
  )
  const ccCode = extractCcCode(body) || null
  return {
    ccCode,
    memberName: normalizeText(body.MemberName || body.memberName || body.member_name),
    hin,
    gender: normalizeNhisGender(body.Gender || body.gender),
    dateOfBirth: normalizeText(body.DateOfBirth || body.dateOfBirth || body.date_of_birth).slice(0, 10) || null,
    eligibilityStartDate: normalizeText(body.EligibilityStartDate || body.eligibilityStartDate).slice(0, 10) || null,
    eligibilityEndDate: normalizeText(body.EligibilityEndDate || body.eligibilityEndDate).slice(0, 10) || null,
    status: normalizeText(body.Status || body.status),
    attendanceDate: normalizeText(body.AttendanceDate || body.attendanceDate).slice(0, 10) || null,
    authId: normalizeText(
      body.AuthID ||
        body.AuthId ||
        body.authID ||
        body.authId ||
        body.auth_id ||
        body.AuthorizationID ||
        body.authorizationId ||
        body.authorization_id
    ),
    transactionId: normalizeText(body.TransactionID || body.transactionId || body.transaction_id),
    hpName: normalizeText(body.HPName || body.hpName || body.hp_name),
    pppCode: normalizeText(body.PPPCode || body.pppCode) || null,
    pppName: normalizeText(body.PPPName || body.pppName) || null,
    raw: body,
  }
}

// Determine CardType for NHIA genCCC API: GHANACARD for GHA-xxxxxxxxx-x numbers, NHISCARD otherwise.
const getNhiaCardType = (memberNumber) =>
  isGhanaCardNumber(normalizeText(memberNumber)) ? 'GHANACARD' : 'NHISCARD'

const normalizeNhiaCardType = (memberNumber, cardType) => {
  const value = normalizeText(cardType).toUpperCase().replace(/[\s_-]/g, '')
  if (value) {
    if (value === '1' || value === 'NHISCARD') return 'NHISCARD'
    if (value === '2' || value === 'GHANACARD') return 'GHANACARD'
  }

  return getNhiaCardType(memberNumber)
}

export const lookupNhiaMember = async (memberNumber, { cardType } = {}) => {
  const settings = getNhiaSettings({ includeCredentials: true })
  if (!settings) {
    return { status: 'pending', message: 'NHIA settings are required before generating CCC/CC codes.' }
  }
  if (!settings.directApiEnabled) {
    return { status: 'pending', message: 'NHIA API not configured' }
  }

  // CCC generation must go through the server-side NHIA eligibility API only.
  // Saved CLAIM-it/local URLs are for claim submission and must not be used here.
  const nhiaEligibilityBaseUrl = getNhiaEligibilityBaseUrl()
  if (!nhiaEligibilityBaseUrl) {
    return {
      status: 'pending',
      message: 'NHIA eligibility API base URL not configured. Set NHIA_BASE_URL to https://elig.nhia.gov.gh:5000 in the branch server .env.',
    }
  }

  const endpointPath = getNhiaMemberLookupEndpointPath()

  const credentials = settings.credentials || {}
  const apiKey = normalizeHttpHeaderValue(credentials.apiKey || credentials.token)
  const apiSecret = normalizeHttpHeaderValue(credentials.apiSecret)
  const facilityCode = normalizeText(settings.facilityCode || settings.facility_code || config.nhiaFacilityCode)
  const apiKeyHeaderName = normalizeText(credentials.headerName) || 'x-nhia-apikey'
  const apiSecretHeaderName = normalizeText(credentials.secretHeaderName) || 'x-nhia-apisecret'

  const debugDetails = getNhiaCredentialDebugDetails({
    settings: { ...settings, facilityCode },
    credentials,
    nhiaBaseUrl: nhiaEligibilityBaseUrl,
    endpointPath,
    apiKeyHeaderName,
    apiSecretHeaderName,
  })
  logNhiaCredentialDebug('member.lookup.credentials', debugDetails)

  const missingCredentials = []
  if (!apiKey) missingCredentials.push('apiKey')
  if (!apiSecret) missingCredentials.push('apiSecret')
  if (missingCredentials.length) {
    throw new Error(
      `NHIA credentials are incomplete for member lookup: ${missingCredentials.join(', ')} missing. ` +
      'Save the correct NHIA API key and NHIA API secret in backend Settings or .env.'
    )
  }

  // NHIA genCCC API (https://elig.nhia.gov.gh:5000/api/hmis/genCCC):
  //   Headers: x-nhia-apikey, x-nhia-apisecret
  //   Body JSON: { CardNo, CardType }  CardType = "NHISCARD" | "GHANACARD"
  const validatedMemberNumber = assertValidMemberNumber(memberNumber, settings)
  const resolvedCardType = normalizeNhiaCardType(validatedMemberNumber, cardType)
  const url = `${nhiaEligibilityBaseUrl.replace(/\/+$/, '')}/${endpointPath.replace(/^\/+/, '')}`
  const headers = {
    [apiKeyHeaderName]: apiKey,
    [apiSecretHeaderName]: apiSecret,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }
  const body = JSON.stringify({ CardNo: validatedMemberNumber, CardType: resolvedCardType })

  logSubmission({ action: 'member.lookup.start', status: 'pending', memberNumber: validatedMemberNumber, cardType: resolvedCardType })
  try {
    const response = await fetch(url, { method: 'POST', headers, body })
    const text = await response.text()
    let responseBody = {}
    try { responseBody = text ? JSON.parse(text) : {} } catch { responseBody = { raw: text } }

    if (!response.ok) {
      const upstreamMessage = normalizeText(
        responseBody?.message ||
        responseBody?.error ||
        responseBody?.detail ||
        responseBody?.raw
      )
      if (response.status === 401 || response.status === 403) {
        logNhiaCredentialDebug('member.lookup.credentials_rejected', debugDetails)
        throw new Error(
          `NHIA credentials were rejected by the eligibility API (HTTP ${response.status})` +
          `${upstreamMessage ? `: ${upstreamMessage}` : ''}. ` +
          'Check that the saved NHIA API key, API secret, and facility code belong to the same accredited facility.'
        )
      }
      throw new Error(
        `NHIA member lookup returned HTTP ${response.status}${upstreamMessage ? `: ${upstreamMessage}` : ''}.`
      )
    }
    const mapped = mapNhiaMemberLookupResponse(responseBody)
    logSubmission({ action: 'member.lookup.complete', status: 'success', ccCode: mapped?.ccCode })
    return { ok: true, ...mapped }
  } catch (error) {
    logSubmission({ action: 'member.lookup.failed', status: 'failed', error: error.message })
    if (error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') {
      throw new Error('Unable to reach the configured NHIA/CLAIM-it upstream. Start the local CLAIM-it/NHIA middleware or correct CLAIMIT_UPSTREAM_BASE_URL.')
    }
    throw error
  }
}

export const generateNhiaCcCode = async (claimContext = {}) => {
  const settings = getNhiaSettings({ includeCredentials: true })
  if (!settings) {
    throw new Error('NHIA settings are required before submitting claims.')
  }

  if (!settings.directApiEnabled) {
    return { status: 'pending', source: 'pending', message: 'Pending CLAIM-it validation' }
  }

  // NHIA genCCC is the canonical CCC/CC generation endpoint. It must use the
  // eligibility API, not CLAIM-it claim submission routes such as /claims.
  {
    const memberNumber = normalizeText(claimContext.memberNumber || claimContext.memberNo)
    if (memberNumber) {
      try {
        const result = await lookupNhiaMember(memberNumber, {
          cardType: claimContext.cardType,
        })
        if (result?.ccCode) {
          return {
            ccCode: result.ccCode,
            source: 'api',
            memberDetails: result,
          }
        }
        const failureMessage = getNhiaMemberLookupFailureMessage(result)
        if (failureMessage) {
          return {
            ccCode: '',
            source: 'api',
            memberDetails: result,
            eligibilityError: failureMessage,
          }
        }
      } catch (lookupError) {
        const message = lookupError?.message || 'genCCC fallback failed'
        logSubmission({
          action: 'cc_code.genccc_fallback.failed',
          status: 'failed',
          error: message,
        })
        throw new Error(`NHIA genCCC lookup failed: ${message}`)
        // Fall through to pending — caller handles missing CC code
      }
    }
    return { status: 'pending', source: 'pending', message: 'Pending CLAIM-it validation' }
  }

}

export const submitNhiaDirectPayload = async ({
  payload,
  payloadContent = '',
  contentType = 'application/json',
  claimIds = [],
  action = 'nhis.direct_submit',
} = {}) => {
  const settings = getNhiaSettings({ includeCredentials: true })
  validateSettingsForSubmission(settings)

  if (!settings.directApiEnabled) {
    throw new Error('Direct NHIA API submission is disabled. Export a claim batch instead.')
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Direct NHIA submission requires a claim payload.')
  }
  if (isClaimItCxfImportPayload(payload)) {
    logSubmission({
      action: `${action || 'nhis.direct_submit'}.blocked_cxf_import`,
      status: 'blocked',
      request: {
        route: 'manual_cxf_export_required',
        payloadFormat: payload.payloadFormat || payload.payload_format || null,
        claimIds,
      },
      error: CLAIMIT_CXF_API_BLOCK_MESSAGE,
    })
    throw new Error(CLAIMIT_CXF_API_BLOCK_MESSAGE)
  }

  const expectedFacilityCode = normalizeText(settings.facilityCode)
  const expectedProviderNumber = normalizeText(settings.providerNumber || settings.providerId)
  const identityScopes = [payload, payload.batch, payload.facility, payload.provider]
    .filter((scope) => scope && typeof scope === 'object')
  for (const scope of identityScopes) {
    const payloadFacilityCode = normalizeText(scope.facilityCode || scope.facility_code)
    const payloadProviderNumber = normalizeText(
      scope.providerNumber || scope.provider_number || scope.providerId || scope.provider_id
    )
    if (payloadFacilityCode && expectedFacilityCode && payloadFacilityCode !== expectedFacilityCode) {
      throw new Error('Claim payload facility code does not match the saved facility configuration.')
    }
    if (payloadProviderNumber && expectedProviderNumber && payloadProviderNumber !== expectedProviderNumber) {
      throw new Error('Claim payload provider ID does not match the saved facility configuration.')
    }
  }

  const normalizedClaimIds = Array.isArray(claimIds)
    ? claimIds.map((id) => normalizeText(id)).filter(Boolean)
    : []
  if (!normalizedClaimIds.length) {
    throw new Error('Direct NHIA submission requires at least one local claim ID.')
  }

  const localClaims = resolveDirectSubmissionLocalClaims(normalizedClaimIds)
  const payloadToSubmit = withDirectSubmissionClaimIds(payload, localClaims)
  const payloadClaims = getDirectSubmissionPayloadClaims(payloadToSubmit)
  if (payloadClaims.length !== localClaims.length) {
    throw new Error('Direct NHIA submission payload must match the selected local claims.')
  }
  const claimAudit = assertDirectSubmissionClaimIds(payloadToSubmit, localClaims)
  const isXmlSubmission = normalizeText(contentType).toLowerCase().includes('xml')
  if (isXmlSubmission) {
    const xml = normalizeText(payloadContent)
    if (!xml.startsWith('<?xml') || !xml.includes('<Claims-Data>')) {
      throw new Error('Direct CLAIM-it XML submission requires a valid Claims-Data XML payload.')
    }
    if (claimAudit.some((claim) => !xml.includes(claim.claimID))) {
      throw new Error(CLAIMIT_MISSING_CLAIM_ID_MESSAGE)
    }
  }
  claimAudit.forEach((claim) => {
    if (claim.internalClaimId) {
      repairNhiaClaimPayloadClaimId(claim.internalClaimId, claim.claimID)
    }
  })

  const localClaimNumbers = new Set(localClaims.map((claim) => claim.claimNumber))
  const payloadClaimNumbers = payloadClaims.map((claim) => normalizeDirectSubmissionClaimNumber(claim))
  if (payloadClaimNumbers.some((claimNumber) => !claimNumber || !localClaimNumbers.has(claimNumber))) {
    throw new Error('Direct NHIA submission payload does not match the selected local claims.')
  }

  const startedAt = nowIso()
  await validateClaimItBridgePayload(settings, payloadToSubmit, {
    payloadContent,
    contentType,
  })
  logSubmission({
    action: action || 'nhis.direct_submit',
    status: 'pending',
    request: {
      route: 'direct_api_submission',
      claimIds: normalizedClaimIds,
      claims: claimAudit,
      claimCount: Array.isArray(payload.claims) ? payload.claims.length : null,
      payloadFormat: payloadToSubmit.payloadFormat || payloadToSubmit.payload_format || 'json',
      payload: payloadToSubmit,
      startedAt,
    },
  })

  try {
    const result = await submitPayload(settings, payloadToSubmit, '', {
      payloadContent,
      contentType,
    })
    if (!result.ok) {
      throw new Error(buildClaimItHttpError('CLAIM-it claim submission', result.httpStatus, result.body))
    }
    assertClaimItSubmissionAccepted(result.body)
    const remoteStatus = deriveRemoteStatus(result.body)
    logSubmission({
      action: `${action || 'nhis.direct_submit'}.complete`,
      status: remoteStatus,
      httpStatus: result.httpStatus,
      response: result.body,
    })
    return {
      status: remoteStatus,
      httpStatus: result.httpStatus,
      endpoint: result.endpoint,
      response: result.body,
      submittedAt: nowIso(),
    }
  } catch (error) {
    logSubmission({
      action: `${action || 'nhis.direct_submit'}.failed`,
      status: 'failed',
      error: error.message || 'Direct NHIA submission failed.',
    })
    throw error
  }
}

const updateClaimAfterAttempt = ({ id, status, response = null, error = null, retryCount = 0 }) => {
  const timestamp = nowIso()
  updateClaimStatus.run({
    id,
    status,
    responseJson: response ? json(response) : null,
    ccCode: response ? extractCcCode(response) : null,
    retryCount,
    nextRetryAt:
      status === 'failed'
        ? new Date(Date.now() + Math.min(60, 2 ** Math.min(retryCount, 6)) * 60000).toISOString()
        : null,
    lastError: error,
    submittedAt:
      status === 'submitted' || status === 'accepted' || status === 'rejected' || status === 'paid'
        ? timestamp
        : null,
    acceptedAt: status === 'accepted' ? timestamp : null,
    rejectedAt: status === 'rejected' ? timestamp : null,
    paidAt: status === 'paid' ? timestamp : null,
    updatedAt: timestamp,
  })
}

export const logSubmission = ({
  claimId = null,
  batchId = null,
  action,
  status,
  attempt = 0,
  httpStatus = null,
  request = null,
  response = null,
  error = null,
} = {}) => {
  insertLog.run({
    id: createId(),
    claimId,
    batchId,
    action: assertRequiredText(action, 'Log action'),
    status: assertRequiredText(status, 'Log status'),
    attempt,
    httpStatus,
    requestJson: request ? json(request) : null,
    responseJson: response ? json(response) : null,
    errorMessage: error ? String(error) : null,
    createdAt: nowIso(),
  })
}

export const submitNhiaClaim = async (id) => {
  const settings = getNhiaSettings({ includeCredentials: true })
  validateSettingsForSubmission(settings)

  if (!settings.directApiEnabled) {
    throw new Error('Direct NHIA API submission is disabled. Export a claim batch instead.')
  }

  const claim = getNhiaClaim(id)
  if (!claim) {
    throw new Error('NHIA claim not found.')
  }

  const payload = validateClaimForSubmission(claim, settings)
  const claimID = normalizeDirectSubmissionClaimId(payload.claimID)
  if (!claimID) {
    throw new Error(CLAIMIT_MISSING_CLAIM_ID_MESSAGE)
  }
  repairNhiaClaimPayloadClaimId(id, claimID)
  const attempt = Number(claim.retryCount || 0) + 1
  await validateClaimItBridgePayload(settings, payload)
  logSubmission({
    claimId: id,
    action: 'claim.submit.start',
    status: 'pending',
    attempt,
    request: {
      route: 'direct_api_submission',
      internalClaimId: id,
      claim_number: claim.claimNumber,
      claimID,
      payload,
    },
  })

  try {
    const result = await submitPayload(settings, payload)
    if (!result.ok) {
      throw new Error(buildClaimItHttpError('NHIA API', result.httpStatus, result.body))
    }
    assertClaimItSubmissionAccepted(result.body)

    const remoteStatus = deriveRemoteStatus(result.body)
    updateClaimAfterAttempt({
      id,
      status: remoteStatus,
      response: result.body,
      retryCount: attempt,
    })
    logSubmission({
      claimId: id,
      action: 'claim.submit.complete',
      status: remoteStatus,
      attempt,
      httpStatus: result.httpStatus,
      response: result.body,
    })
    return getNhiaClaim(id)
  } catch (error) {
    const message = error.message || 'NHIA claim submission failed.'
    updateClaimAfterAttempt({
      id,
      status: 'failed',
      error: message,
      retryCount: attempt,
    })
    logSubmission({
      claimId: id,
      action: 'claim.submit.failed',
      status: 'failed',
      attempt,
      error: message,
    })
    throw error
  }
}

export const submitPendingNhiaClaims = async ({ limit = 10 } = {}) => {
  const settings = getNhiaSettings({ includeCredentials: true })
  if (!settings?.directApiEnabled) {
    return { checked: 0, submitted: 0, failed: 0, skipped: true, reason: 'Direct NHIA API submission is disabled.' }
  }

  const maxAttempts = Math.max(Number(settings.maxRetryAttempts || 3), 1)
  const rows = pendingClaims.all(maxAttempts, nowIso(), Math.min(Math.max(Number(limit) || 10, 1), 50))
  const result = { checked: rows.length, submitted: 0, failed: 0, errors: [] }

  for (const row of rows) {
    try {
      await submitNhiaClaim(row.id)
      result.submitted += 1
    } catch (error) {
      result.failed += 1
      result.errors.push({ id: row.id, claimNumber: row.claim_number, message: error.message })
    }
  }

  return result
}

const buildBatchPayload = (claims, settings) => ({
  batchNumber: createBatchNumber(),
  facilityCode: settings?.facilityCode || '',
  providerNumber: settings?.providerNumber || '',
  facilityType: settings?.facilityType || '',
  pharmacyFacilityLevel: settings?.pharmacyFacilityLevel || '',
  providerLevelCode: settings?.providerLevelCode || '',
  credentialCode: settings?.credentialCode || settings?.facilityCode || '',
  licenseNumber: settings?.licenseNumber || '',
  accreditationExpiryDate: getAccreditationExpiryDate(settings),
  schemeName: settings?.schemeName || 'National Health Insurance',
  providerTypeDescription: settings?.providerTypeDescription || '',
  providerClassLevel: settings?.providerClassLevel || '',
  claimsOfficerName: settings?.claimsOfficerName || '',
  admissionPaymentOption: settings?.admissionPaymentOption || 'nhis_pays_admission',
  claimitValidationEnabled: settings?.claimitValidationEnabled !== false && settings?.claimitValidationEnabled !== 0,
  claimsOfficerSignatureUrl: settings?.claimsOfficerSignatureUrl || '',
  createdAt: nowIso(),
  claims: claims.map((claim) => validateClaimForSubmission(claim, settings || {})),
})

const xmlEscape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const batchToXml = (payload) => `<?xml version="1.0" encoding="UTF-8"?>
<NhiaClaimBatch>
  <BatchNumber>${xmlEscape(payload.batchNumber)}</BatchNumber>
  <FacilityCode>${xmlEscape(payload.facilityCode)}</FacilityCode>
  <ProviderNumber>${xmlEscape(payload.providerNumber)}</ProviderNumber>
  <FacilityType>${xmlEscape(payload.facilityType)}</FacilityType>
  <PharmacyFacilityLevel>${xmlEscape(payload.pharmacyFacilityLevel)}</PharmacyFacilityLevel>
  <ProviderLevelCode>${xmlEscape(payload.providerLevelCode)}</ProviderLevelCode>
  <CredentialCode>${xmlEscape(payload.credentialCode)}</CredentialCode>
  <LicenseNumber>${xmlEscape(payload.licenseNumber)}</LicenseNumber>
  <AccreditationExpiryDate>${xmlEscape(payload.accreditationExpiryDate)}</AccreditationExpiryDate>
  <SchemeName>${xmlEscape(payload.schemeName)}</SchemeName>
  <ProviderTypeDescription>${xmlEscape(payload.providerTypeDescription)}</ProviderTypeDescription>
  <ProviderClassLevel>${xmlEscape(payload.providerClassLevel)}</ProviderClassLevel>
  <ClaimsOfficerName>${xmlEscape(payload.claimsOfficerName)}</ClaimsOfficerName>
  <AdmissionPaymentOption>${xmlEscape(payload.admissionPaymentOption)}</AdmissionPaymentOption>
  <ClaimitValidationEnabled>${xmlEscape(payload.claimitValidationEnabled)}</ClaimitValidationEnabled>
  <ClaimsOfficerSignatureUrl>${xmlEscape(payload.claimsOfficerSignatureUrl)}</ClaimsOfficerSignatureUrl>
  <CreatedAt>${xmlEscape(payload.createdAt)}</CreatedAt>
  <Claims>
${payload.claims.map((claim) => `    <Claim>
      <ClaimNumber>${xmlEscape(claim.claimNumber)}</ClaimNumber>
      <CcCode>${xmlEscape(claim.ccCode)}</CcCode>
      <MemberNumber>${xmlEscape(claim.patient.memberNumber)}</MemberNumber>
      <PatientName>${xmlEscape(claim.patient.name)}</PatientName>
      <Diagnosis>${xmlEscape(claim.diagnosis)}</Diagnosis>
      <ServiceDate>${xmlEscape(claim.serviceDate)}</ServiceDate>
      <TotalAmount>${xmlEscape(claim.totalAmount)}</TotalAmount>
      <Items>
${claim.items.map((item) => `        <Item>
          <Code>${xmlEscape(item.code)}</Code>
          <Name>${xmlEscape(item.name)}</Name>
          <Quantity>${xmlEscape(item.quantity)}</Quantity>
          <UnitPrice>${xmlEscape(item.unitPrice)}</UnitPrice>
          <TotalPrice>${xmlEscape(item.totalPrice)}</TotalPrice>
        </Item>`).join('\n')}
      </Items>
    </Claim>`).join('\n')}
  </Claims>
</NhiaClaimBatch>
`

export const createNhiaBatch = db.transaction(({ claimIds = [], exportFormat = '', createdBy = null } = {}) => {
  const settings = getNhiaSettings()
  validateSettingsForBatchExport(settings)
  const claims = (claimIds.length ? claimIds : listNhiaClaims({ status: 'ready', limit: 500 }).map((claim) => claim.id))
    .map((id) => getNhiaClaim(id))
    .filter(Boolean)

  if (!claims.length) {
    throw new Error('Select at least one NHIA claim for the batch.')
  }

  const format = normalizeExportFormat(exportFormat || settings?.exportFormat || 'xml')
  if (format === 'cxf') {
    throw new Error('Offline CXF export is not available yet. Use XML here or download CXF from the NHIS Claims export screen.')
  }
  const payload = buildBatchPayload(claims, settings)
  const timestamp = nowIso()
  const batchId = createId()
  const batchNumber = payload.batchNumber
  const totalAmount = toMoney(claims.reduce((sum, claim) => sum + Number(claim.totalAmount || 0), 0))
  const fileName = `${batchNumber}.${format}`

  insertBatch.run({
    id: batchId,
    batchNumber,
    status: 'ready',
    exportFormat: format,
    claimCount: claims.length,
    totalAmount,
    payloadJson: json(payload),
    fileName,
    organizationId: config.organizationId,
    branchId: config.branchId,
    createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
  })

  for (const claim of claims) {
    updateClaimsBatch.run(batchId, timestamp, claim.id)
  }

  logSubmission({
    batchId,
    action: 'batch.created',
    status: 'success',
    request: { batchNumber, claimCount: claims.length, exportFormat: format },
  })

  return getNhiaBatch(batchId)
})

export const getNhiaBatch = (id) => {
  const row = selectBatchById.get(id)
  if (!row) {
    return null
  }

  return {
    id: row.id,
    batchNumber: row.batch_number,
    status: row.status,
    exportFormat: row.export_format,
    claimCount: row.claim_count,
    totalAmount: row.total_amount,
    payload: parseJson(row.payload_json, {}),
    response: parseJson(row.response_json, null),
    fileName: row.file_name,
    organizationId: row.organization_id,
    branchId: row.branch_id,
    createdBy: row.created_by,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const exportNhiaBatch = (id, formatOverride = '') => {
  const batch = getNhiaBatch(id)
  if (!batch) {
    throw new Error('NHIA claim batch not found.')
  }

  const format = normalizeExportFormat(formatOverride || batch.exportFormat)
  if (format === 'cxf') {
    throw new Error('Offline CXF export is not available yet. Use XML here or download CXF from the NHIS Claims export screen.')
  }
  const isClaimItXml = format === 'xml'
  const content =
    isClaimItXml
      ? batchToXml(batch.payload)
      : JSON.stringify(batch.payload, null, 2)

  logSubmission({
    batchId: id,
    action: 'batch.exported',
    status: 'success',
    request: { format },
  })

  return {
    fileName: `${batch.batchNumber}.${format}`,
    contentType: isClaimItXml ? 'application/xml' : 'application/json',
    content,
  }
}

export const getNhiaSubmissionLogs = ({ limit = 50 } = {}) =>
  recentLogs.all(Math.min(Math.max(Number(limit) || 50, 1), 200)).map((row) => ({
    id: row.id,
    claimId: row.nhia_claim_id,
    batchId: row.batch_id,
    action: row.action,
    status: row.status,
    attempt: row.attempt,
    httpStatus: row.http_status,
    request: parseJson(row.request_json, null),
    response: parseJson(row.response_json, null),
    errorMessage: row.error_message,
    createdAt: row.created_at,
  }))

export const getNhiaSummary = () => {
  const counts = statusCounts.all().reduce(
    (summary, row) => {
      summary[row.status] = row.count
      summary.total += row.count
      return summary
    },
    { draft: 0, ready: 0, submitted: 0, accepted: 0, rejected: 0, paid: 0, failed: 0, total: 0 }
  )

  return {
    ...counts,
    settingsConfigured: Boolean(getNhiaSettings()),
    directApiEnabled: Boolean(getNhiaSettings()?.directApiEnabled),
  }
}
