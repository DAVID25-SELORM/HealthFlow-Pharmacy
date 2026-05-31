import crypto from 'node:crypto'
import https from 'node:https'
import { createId, db, json, nowIso, parseJson } from './db.js'
import { config } from './config.js'

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
const DEFAULT_NHIS_MEMBER_DIGITS = 8
const DEFAULT_GHANA_CARD_DIGITS = 10
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
  const mode = normalizeText(value || 'api_key').toLowerCase()
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
    id, organization_id, branch_id, mode, facility_code, provider_number, provider_id,
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
    @id, @organizationId, @branchId, @mode, @facilityCode, @providerNumber, @providerId,
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
    member_number, hin, cc_code, diagnosis, diagnosis_details_json, unserved_medicines_note, insurance_provider, service_date, total_amount, status,
    payload_json, organization_id, branch_id, created_by, created_at, updated_at
  )
  VALUES (
    @id, @claimNumber, @localSaleId, @localSaleNumber, @patientId, @patientName,
    @memberNumber, @hin, @ccCode, @diagnosis, @diagnosisDetailsJson, @unservedMedicinesNote, @insuranceProvider, @serviceDate, @totalAmount, @status,
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
const NHIA_SECRET_FIELDS = new Set(['apiKey', 'apiSecret', 'password'])
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

const getNhiaSecretKeyMaterial = () =>
  normalizeText(config.nhiaConfigSecretKey) ||
  normalizeText(config.branchServerToken) ||
  normalizeText(config.branchSyncToken) ||
  normalizeText(config.supabaseSyncKey)

const getNhiaSecretKey = () => {
  const keyMaterial = getNhiaSecretKeyMaterial()
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
  try {
    const [ivEncoded, tagEncoded, ciphertextEncoded] = normalized.slice(NHIA_SECRET_PREFIX.length).split(':')
    if (!ivEncoded || !tagEncoded || !ciphertextEncoded) {
      throw new Error('Invalid NHIA secret ciphertext.')
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', getNhiaSecretKey(), Buffer.from(ivEncoded, 'base64'))
    decipher.setAuthTag(Buffer.from(tagEncoded, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new Error('Unable to decrypt NHIA secret. Check NHIA_CONFIG_SECRET_KEY.')
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

const mapSettingsRow = (row, { includeCredentials = false } = {}) => {
  if (!row) {
    return null
  }

  const credentials = includeCredentials
    ? {
        apiKey: decodeNhiaSecret(row.api_key_encrypted),
        apiSecret: decodeNhiaSecret(row.api_secret_encrypted),
        headerName: row.api_key_header_name || '',
        secretHeaderName: row.api_secret_header_name || '',
        headerPrefix: row.api_key_header_prefix || '',
        username: row.username || '',
        password: decodeNhiaSecret(row.password_encrypted),
        tokenEndpointPath: row.token_endpoint_path || '',
      }
    : {}
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
    facilityCode: row.facility_code || '',
    providerId: row.provider_id || row.provider_number || '',
    provider_id: row.provider_id || row.provider_number || '',
    providerNumber: row.provider_number || row.provider_id || '',
    // ✅ NHIA CONFIG PATCH START
    facilityType: row.facility_type || '',
    pharmacyFacilityLevel: row.pharmacy_facility_level || '',
    providerLevelCode: row.provider_level_code || '',
    credentialCode: row.credential_code || row.facility_code || '',
    licenseNumber: row.license_number || '',
    accreditationExpiryDate: getAccreditationExpiryDate(row),
    // ✅ NHIA API ARCHITECTURE PATCH START
    integrationMode: row.integration_mode || 'claimit_export',
    connectionProfile: row.connection_profile || 'local_server',
    validationMode: row.validation_mode || 'validate_before_submit',
    claimControlMode: row.claim_control_mode ||
      (['claimit_bridge', 'claimit_assisted'].includes(normalizeText(row.integration_mode))
        ? 'claimit_bridge'
        : normalizeText(row.integration_mode) === 'direct_nhia_api'
          ? 'direct_api'
          : 'manual'),
    sandboxBaseUrl: row.sandbox_base_url || '',
    productionBaseUrl: row.production_base_url || row.api_base_url || '',
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
    apiBaseUrl: row.api_base_url || '',
    apiKeyEncrypted: row.api_key_encrypted ? NHIA_SECRET_MASK : '',
    apiSecretEncrypted: row.api_secret_encrypted ? NHIA_SECRET_MASK : '',
    claimEndpointPath: row.claim_endpoint_path || '',
    claimSubmitEndpoint: row.claim_submit_endpoint || row.claim_endpoint_path || '',
    claim_submit_endpoint: row.claim_submit_endpoint || row.claim_endpoint_path || '',
    claimValidationEndpointPath: row.claim_validation_endpoint_path || '',
    ccEndpointPath: row.cc_endpoint_path || row.cc_code_endpoint_path || '',
    ccCodeEndpointPath: row.cc_code_endpoint_path || '',
    claimStatusEndpointPath: row.claim_status_endpoint_path || '',
    claimStatusEndpoint: row.claim_status_endpoint || row.claim_status_endpoint_path || '',
    claim_status_endpoint: row.claim_status_endpoint || row.claim_status_endpoint_path || '',
    memberLookupEndpointPath: row.member_lookup_endpoint_path || '',
    memberLookupEndpoint: row.member_lookup_endpoint || row.member_lookup_endpoint_path || '',
    member_lookup_endpoint: row.member_lookup_endpoint || row.member_lookup_endpoint_path || '',
    directApiEnabled: Boolean(row.direct_api_enabled),
    credentialMode: normalizeCredentialMode(row.credential_mode || 'api_key'),
    credentials: includeCredentials ? credentials : {},
    credentialSummary,
    hasApiKey: Boolean(row.api_key_encrypted),
    hasApiSecret: Boolean(row.api_secret_encrypted),
    username: row.username || '',
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

const queueNhiaConfigSync = (row, timestamp = nowIso()) => {
  if (!row?.id) return
  deletePendingNhiaConfigOutbox.run(row.id)
  insertNhiaConfigOutbox.run({
    id: createId(),
    entityId: row.id,
    payloadJson: json({ config: row }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
}

const hasWritableNhiaSecret = (credentials, key) =>
  Boolean(normalizeText(credentials[key]) && !isNhiaSecretMask(credentials[key]))

export const getNhiaSettings = ({ includeCredentials = false } = {}) => {
  const settings = mapSettingsRow(resolveSettingsRow(), { includeCredentials })
  logNhiaConfigEvent('load', {
    mode: settings?.mode || 'OFFLINE_LOCAL',
    endpoint: '/api/nhia-config',
    configSource: 'local_branch_server',
    hasApiKey: settings?.hasApiKey,
    hasApiSecret: settings?.hasApiSecret,
  })
  return settings
}

const hasUsableNhiaSecret = (value) => {
  const normalized = normalizeText(value)
  return Boolean(normalized && !isNhiaSecretMask(normalized))
}

const validateNhiaSettingsForMode = (settings = {}) => {
  const credentials = settings.credentials && typeof settings.credentials === 'object' ? settings.credentials : {}
  const integrationMode = normalizeText(settings.integrationMode || settings.integration_mode || settings.nhiaApiMode || settings.nhia_api_mode) || 'claimit_export'
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
  const apiBaseUrl = normalizeText(settings.apiBaseUrl || settings.api_base_url || settings.productionBaseUrl || settings.production_base_url || settings.sandboxBaseUrl || settings.sandbox_base_url)
  const claimSubmitEndpoint = normalizeText(settings.claimSubmitEndpoint || settings.claim_submit_endpoint || settings.claimEndpointPath || settings.claim_endpoint_path)
  const claimStatusEndpoint = normalizeText(settings.claimStatusEndpoint || settings.claim_status_endpoint || settings.claimStatusEndpointPath || settings.claim_status_endpoint_path)
  const memberLookupEndpoint = normalizeText(settings.memberLookupEndpoint || settings.member_lookup_endpoint || settings.memberLookupEndpointPath || settings.member_lookup_endpoint_path)

  if (['claimit_bridge', 'claimit_assisted'].includes(integrationMode)) {
    if (!apiBaseUrl) missing.push('apiBaseUrl')
    if (!((hasUsername && hasPassword) || (hasApiKey && hasApiSecret))) {
      missing.push('username/password or api credentials')
    }
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
        apiKey: decodeNhiaSecret(existing.api_key_encrypted),
        apiSecret: decodeNhiaSecret(existing.api_secret_encrypted),
        headerName: existing.api_key_header_name || '',
        secretHeaderName: existing.api_secret_header_name || '',
        headerPrefix: existing.api_key_header_prefix || '',
        username: existing.username || '',
        password: decodeNhiaSecret(existing.password_encrypted),
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
    // ✅ NHIA CONFIG PATCH START
    facilityType: normalizeText(settings.facilityType) || null,
    pharmacyFacilityLevel: normalizeText(settings.pharmacyFacilityLevel) || null,
    providerLevelCode: normalizeText(settings.providerLevelCode) || null,
    credentialCode: normalizeText(settings.credentialCode) || normalizeText(settings.facilityCode) || null,
    licenseNumber: normalizeText(settings.licenseNumber) || null,
    accreditationExpiryDate: getAccreditationExpiryDate(settings) || null,
    // ✅ NHIA API ARCHITECTURE PATCH START
    integrationMode: normalizeText(settings.integrationMode) || 'claimit_export',
    connectionProfile: normalizeText(settings.connectionProfile || settings.connection_profile) || 'local_server',
    validationMode: normalizeText(settings.validationMode || settings.validation_mode) || 'validate_before_submit',
    claimControlMode: ['manual', 'claimit_bridge', 'direct_api'].includes(normalizeText(settings.claimControlMode || settings.claim_control_mode))
      ? normalizeText(settings.claimControlMode || settings.claim_control_mode)
      : 'manual',
    sandboxBaseUrl: normalizeText(settings.sandboxBaseUrl).replace(/\/+$/, '') || null,
    productionBaseUrl: normalizeText(settings.productionBaseUrl).replace(/\/+$/, '') || null,
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
        (settings.apiEnvironment === 'sandbox' ? settings.sandboxBaseUrl : settings.productionBaseUrl)
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
})

export const listNhiaClaims = ({ status = '', limit = 100 } = {}) => {
  const normalizedStatus = normalizeText(status).toLowerCase()
  const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const rows = normalizedStatus
    ? db.prepare(`${selectClaimsBase} WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(normalizedStatus, cappedLimit)
    : db.prepare(`${selectClaimsBase} ORDER BY created_at DESC LIMIT ?`).all(cappedLimit)

  return rows.map(mapClaimRow)
}

export const getNhiaClaim = (id) => {
  const row = selectClaimById.get(id)
  return row ? mapClaimRow(row) : null
}

const buildClaimPayload = ({ claim, items, settings }) => ({
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
  items: items.map((item) => ({
    drugId: item.drugId || null,
    code: item.nhiaCode || null,
    name: item.drugName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    totalPrice: item.totalPrice,
  })),
})

export const createNhiaClaim = db.transaction((claimData = {}, linkedSale = {}) => {
  if (!Array.isArray(claimData.items) || claimData.items.length === 0) {
    throw new Error('At least one NHIA claim item is required.')
  }

  const timestamp = nowIso()
  const claimId = createId()
  const claimNumber = claimData.claimNumber || createClaimNumber()
  const settings = getNhiaSettings()
  const organizationType = normalizeOrganizationType(claimData.organizationType || claimData.organization_type)
  const diagnosisDetails = organizationType === 'hospital'
    ? normalizeDiagnosisDetails(claimData.diagnosisDetails || claimData.diagnosis_details)
    : []
  let totalAmount = 0

  const items = claimData.items.map((item) => {
    const drugId = item.drugId || item.id || null
    const drug = drugId ? getDrug.get(drugId) : null
    const quantity = assertPositiveQuantity(item.quantity, 'NHIA claim item quantity')
    const unitPrice = toMoney(item.nhiaPrice ?? item.price ?? item.unitPrice ?? drug?.nhis_price ?? drug?.price, 0)
    if (unitPrice < 0) {
      throw new Error('NHIA claim item price cannot be negative.')
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
    hin: normalizeText(claimData.hin) || null,
    ccCode: normalizeOptionalCcCode(claimData.ccCode || claimData.cc_code),
    diagnosis: organizationType === 'hospital' ? normalizeText(claimData.diagnosis) || null : null,
    diagnosisDetails,
    diagnosisDetailsJson: json(diagnosisDetails),
    unservedMedicinesNote: normalizeText(
      claimData.unservedMedicinesNote || claimData.unserved_medicines_note
    ) || null,
    insuranceProvider: claimData.insuranceProvider || 'NHIA',
    serviceDate: claimData.serviceDate || linkedSale.saleDate?.slice(0, 10) || timestamp.slice(0, 10),
    totalAmount,
    status: normalizeStatus(claimData.status || 'ready'),
    organizationId: claimData.organizationId || linkedSale.organizationId || config.organizationId,
    branchId: claimData.branchId || linkedSale.branchId || config.branchId,
    createdBy: claimData.createdBy || claimData.submittedBy || linkedSale.soldBy || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  claim.payloadJson = json(buildClaimPayload({ claim: { ...claim, organizationType }, items, settings }))

  insertClaim.run(claim)
  for (const item of items) {
    insertClaimItem.run(item)
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

  if (settings.directApiEnabled) {
    assertRequiredText(settings.apiBaseUrl, 'NHIA API base URL')
    const credentials = settings.credentials || {}
    if (settings.credentialMode === 'api_key') {
      assertRequiredText(credentials.apiKey, 'NHIA API key')
    } else if (settings.credentialMode === 'bearer_token') {
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
  if (!claim.items.length) {
    throw new Error('NHIA claim requires at least one item.')
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

  return buildClaimPayload({ claim, items: claim.items, settings })
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

const submitPayload = async (settings, payload, endpointPathOverride = '') => {
  const endpointPath = normalizeText(endpointPathOverride || settings.claimEndpointPath)
  if (!endpointPath) {
    throw new Error('NHIA endpoint path is required. Enter the official endpoint path from NHIA/CLAIM-it.')
  }
  const url = `${settings.apiBaseUrl.replace(/\/+$/, '')}/${endpointPath.replace(/^\/+/, '')}`
  const body = JSON.stringify(payload)

  if (settings.credentialMode === 'custom' && settings.credentials?.certPem && settings.credentials?.keyPem) {
    const response = await postWithCertificate(url, body, settings)
    return {
      endpoint: url,
      httpStatus: response.status,
      ok: response.ok,
      body: parseJson(response.text, { raw: response.text }),
    }
  }

  const headers = buildHeaders(settings)
  if (settings.credentialMode === 'claimit_token') {
    headers.Authorization = `Bearer ${await fetchClaimItToken(settings)}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
  })
  const text = await response.text()
  return {
    endpoint: url,
    httpStatus: response.status,
    ok: response.ok,
    body: parseJson(text, { raw: text }),
  }
}

const isClaimItBridgeMode = (settings) =>
  ['claimit_bridge', 'claimit_assisted'].includes(normalizeText(settings?.integrationMode))

const getCcEndpointPath = (settings) =>
  normalizeText(
    settings?.ccEndpointPath ||
      settings?.cc_endpoint_path ||
      settings?.ccCodeEndpointPath ||
      settings?.cc_code_endpoint_path ||
      settings?.claimEndpointPath ||
      settings?.claim_endpoint_path
  )

const validateClaimItBridgePayload = async (settings, payload) => {
  const endpointPath = normalizeText(settings.claimValidationEndpointPath)
  const validationMode = normalizeText(settings.validationMode) || 'validate_before_submit'
  if (!isClaimItBridgeMode(settings) || validationMode === 'submit_only' || !endpointPath) return
  const result = await submitPayload(settings, payload, endpointPath)
  if (!result.ok) {
    throw new Error(`CLAIM-it validation returned HTTP ${result.httpStatus}.`)
  }
}

const fetchClaimItToken = async (settings) => {
  const credentials = settings.credentials || {}
  const username = assertRequiredText(credentials.username, 'CLAIM-it username')
  const password = assertRequiredText(credentials.password, 'CLAIM-it password')
  const tokenPath = normalizeText(credentials.tokenEndpointPath) || '/token'
  const url = new URL(`${settings.apiBaseUrl.replace(/\/+$/, '')}/${tokenPath.replace(/^\/+/, '')}`)
  url.searchParams.set('username', username)
  url.searchParams.set('password', password)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
    },
  })
  const text = await response.text()
  const body = parseJson(text, { raw: text })

  if (!response.ok) {
    throw new Error(`CLAIM-it token request returned HTTP ${response.status}.`)
  }

  const token = normalizeText(body?.token)
  if (!token) {
    throw new Error('CLAIM-it token response did not include a token.')
  }

  return token
}

const deriveRemoteStatus = (body) => {
  // CLAIM-it API v1.0.0 response: { passedClaims, failedClaims, savedClaims, success, claims[] }
  if (body && typeof body === 'object') {
    if (Number(body.failedClaims) > 0 && Number(body.savedClaims) === 0) return 'rejected'
    if (Number(body.savedClaims) > 0 || Number(body.passedClaims) > 0) return 'submitted'
    if (body.success === false || body.failed === true) return 'rejected'
    if (body.success === true) return 'submitted'
  }
  const value = normalizeText(body?.status || body?.claimStatus || body?.state).toLowerCase()
  if (value.includes('paid')) return 'paid'
  if (value.includes('reject')) return 'rejected'
  if (value.includes('accept') || value.includes('approve')) return 'accepted'
  return 'submitted'
}

// Maps the NHIA member verification response (checkcccode / member lookup) to a
// normalised object. The NHIA API returns MobCCC as the CC code field.
const mapNhiaMemberLookupResponse = (body) => {
  if (!body || typeof body !== 'object') return null
  const ccCode = extractCcCode(body) || null
  return {
    ccCode,
    memberName: normalizeText(body.MemberName || body.memberName || body.member_name),
    hin: normalizeText(body.HIN || body.hin),
    gender: normalizeText(body.Gender || body.gender),
    dateOfBirth: normalizeText(body.DateOfBirth || body.dateOfBirth || body.date_of_birth).slice(0, 10) || null,
    eligibilityStartDate: normalizeText(body.EligibilityStartDate || body.eligibilityStartDate).slice(0, 10) || null,
    eligibilityEndDate: normalizeText(body.EligibilityEndDate || body.eligibilityEndDate).slice(0, 10) || null,
    status: normalizeText(body.Status || body.status),
    attendanceDate: normalizeText(body.AttendanceDate || body.attendanceDate).slice(0, 10) || null,
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

export const lookupNhiaMember = async (memberNumber, { cardType } = {}) => {
  const settings = getNhiaSettings({ includeCredentials: true })
  if (!settings.directApiEnabled) {
    return { status: 'pending', message: 'NHIA API not configured' }
  }

  const apiBaseUrl = normalizeText(settings.apiBaseUrl)
  if (!apiBaseUrl) {
    return { status: 'pending', message: 'NHIA API base URL not configured' }
  }

  // Default lookup endpoint is /api/hmis/genCCC on the NHIA eligibility server.
  const endpointPath = normalizeText(
    settings.memberLookupEndpointPath || settings.memberLookupEndpoint
  ) || '/api/hmis/genCCC'

  const validatedMemberNumber = assertValidMemberNumber(memberNumber, settings)
  const credentials = settings.credentials || {}
  const apiKey = normalizeText(credentials.apiKey || credentials.token)
  const apiSecret = normalizeText(credentials.apiSecret)

  if (!apiKey) {
    return { status: 'pending', message: 'NHIA API key not configured' }
  }

  // NHIA genCCC API (https://elig.nhia.gov.gh:5000/api/hmis/genCCC):
  //   Headers: x-nhia-apikey, x-nhia-apisecret
  //   Body JSON: { CardNo, CardType }  CardType = "NHISCARD" | "GHANACARD"
  const resolvedCardType = cardType || getNhiaCardType(validatedMemberNumber)
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/${endpointPath.replace(/^\/+/, '')}`
  const headers = {
    'x-nhia-apikey': apiKey,
    'x-nhia-apisecret': apiSecret,
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
      throw new Error(`NHIA member lookup returned HTTP ${response.status}.`)
    }
    const mapped = mapNhiaMemberLookupResponse(responseBody)
    logSubmission({ action: 'member.lookup.complete', status: 'success', ccCode: mapped?.ccCode })
    return { ok: true, ...mapped }
  } catch (error) {
    logSubmission({ action: 'member.lookup.failed', status: 'failed', error: error.message })
    throw error
  }
}

export const generateNhiaCcCode = async (claimContext = {}) => {
  const settings = getNhiaSettings({ includeCredentials: true })
  validateSettingsForSubmission(settings)

  if (!settings.directApiEnabled) {
    return { status: 'pending', source: 'pending', message: 'Pending CLAIM-it validation' }
  }

  const payload = {
    action: isClaimItBridgeMode(settings) ? 'generate_or_validate_cc_code' : 'generate_cc_code',
    claimControlMode: settings.claimControlMode || (isClaimItBridgeMode(settings) ? 'claimit_bridge' : 'direct_api'),
    facilityCode: settings.facilityCode,
    providerNumber: settings.providerNumber,
    submitterId: isClaimItBridgeMode(settings) ? undefined : settings.submitterId,
    batch: {
      organizationType: normalizeOrganizationType(claimContext.organizationType || claimContext.organization_type),
      facilityCode: settings.facilityCode,
      providerNumber: settings.providerNumber,
      claimCount: 1,
    },
    claims: [{
      patientName: normalizeText(claimContext.patientName),
      memberNumber: normalizeText(claimContext.memberNumber || claimContext.memberNo),
      hin: normalizeText(claimContext.hin) || null,
      diagnosis: normalizeText(claimContext.diagnosis) || null,
      serviceDate: normalizeText(claimContext.serviceDate).slice(0, 10),
      totalAmount: Number(claimContext.totalAmount || 0),
    }],
    organizationType: normalizeOrganizationType(claimContext.organizationType || claimContext.organization_type),
    patient: {
      name: normalizeText(claimContext.patientName),
      memberNumber: normalizeText(claimContext.memberNumber || claimContext.memberNo),
      hin: normalizeText(claimContext.hin) || null,
    },
    diagnosis: normalizeText(claimContext.diagnosis) || null,
    serviceDate: normalizeText(claimContext.serviceDate).slice(0, 10),
    requestedAt: nowIso(),
  }

  const endpointPath = getCcEndpointPath(settings)
  if (!endpointPath) {
    return { status: 'pending', source: 'pending', message: 'Pending CLAIM-it validation' }
  }

  logSubmission({ action: 'cc_code.generate.start', status: 'pending', request: payload })
  try {
    const result = await submitPayload(settings, payload, endpointPath)
    if (!result.ok) {
      throw new Error(`NHIA API returned HTTP ${result.httpStatus}.`)
    }
    const ccCode = extractCcCode(result.body)
    if (!ccCode) {
      return { status: 'pending', source: 'pending', message: 'Pending CLAIM-it validation', response: result.body }
    }
    logSubmission({
      action: 'cc_code.generate.complete',
      status: 'success',
      httpStatus: result.httpStatus,
      response: result.body,
    })
    return { ccCode, source: isClaimItBridgeMode(settings) ? 'claimit_bridge' : 'api', response: result.body }
  } catch (error) {
    logSubmission({
      action: 'cc_code.generate.failed',
      status: 'failed',
      error: error.message || 'CCC/CC code generation failed.',
    })
    throw error
  }
}

export const submitNhiaDirectPayload = async ({ payload, claimIds = [], action = 'nhis.direct_submit' } = {}) => {
  const settings = getNhiaSettings({ includeCredentials: true })
  validateSettingsForSubmission(settings)

  if (!settings.directApiEnabled) {
    throw new Error('Direct NHIA API submission is disabled. Export a claim batch instead.')
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Direct NHIA submission requires a claim payload.')
  }

  const startedAt = nowIso()
  await validateClaimItBridgePayload(settings, payload)
  logSubmission({
    action: action || 'nhis.direct_submit',
    status: 'pending',
    request: {
      claimIds,
      claimCount: Array.isArray(payload.claims) ? payload.claims.length : null,
      payload,
      startedAt,
    },
  })

  try {
    const result = await submitPayload(settings, payload)
    if (!result.ok) {
      throw new Error(`NHIA API returned HTTP ${result.httpStatus}.`)
    }
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
  const attempt = Number(claim.retryCount || 0) + 1
  await validateClaimItBridgePayload(settings, payload)
  logSubmission({ claimId: id, action: 'claim.submit.start', status: 'pending', attempt, request: payload })

  try {
    const result = await submitPayload(settings, payload)
    if (!result.ok) {
      throw new Error(`NHIA API returned HTTP ${result.httpStatus}.`)
    }

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
