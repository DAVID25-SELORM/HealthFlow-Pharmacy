import { supabase } from '../lib/supabase'
import { jsPDF } from 'jspdf'
import { assertRequiredText, assertNonNegativeNumber, assertPositiveNumber, normalizeText, sanitizeSearchTerm } from '../utils/validation'
import {
  normalizeNhiaMemberNumber,
  validateNhiaMemberNumberFormat,
} from '../utils/nhiaMemberNumber'
import {
  assessMedicinePharmacyLevel,
  getEffectivePharmacyLevel,
  normalizeMedicineAccessLevel,
  normalizePharmacyLevel,
} from '../utils/nhisPharmacyLevel'
// ✅ NHIA CONFIG PATCH START
import {
  getNhiaAccreditationExpiryDate,
  normalizeNhiaFacilityTypeForOrganization,
  normalizeNhiaPharmacyFacilityLevel,
  normalizeNhiaProviderClassLevel,
} from '../utils/nhiaFacilityDefaults'
// ✅ NHIA CONFIG PATCH END
import { tryLogAuditEvent } from './auditService'
import {
  createBranchRecord,
  getNhiaSettings as getBranchNhiaSettings,
  listBranchRecords,
  saveNhiaSettings as saveBranchNhiaSettings,
  shouldUseBranchServer,
  submitNhiaDirectPayload,
  updateBranchRecord,
} from './branchServerApi'
import { routeWrite } from './apiRouter'
import { getConnectivityState, refreshConnectivityState } from './connectivityService'
import { invokeTierAccess } from './tierAccessService'

const UNIQUE_PATIENT_INSURANCE_INDEXES = [
  'idx_patients_org_insurance_id_unique',
  'idx_patients_org_nhis_member_no_unique',
  'idx_patients_org_nhis_hin_unique',
]

const throwFriendlyNhisPatientError = (error) => {
  if (
    error?.code === '23505' &&
    UNIQUE_PATIENT_INSURANCE_INDEXES.some((indexName) =>
      String(error?.message || '').includes(indexName)
    )
  ) {
    throw new Error('This NHIS or insurance ID is already assigned to another patient.')
  }

  throw error
}

const asText = (value) => String(value ?? '').trim()
const asNumber = (value) => Number.parseFloat(value)
const getClaimField = (claim, camelKey, snakeKey = camelKey) =>
  asText(claim?.[camelKey] ?? claim?.[snakeKey])
const hasPrescriptionAttachment = (claimData = {}, options = {}) => {
  const hasSavedFile = Boolean(
    getClaimField(claimData, 'prescriptionFilePath', 'prescription_file_path') ||
      getClaimField(claimData, 'prescriptionFileUrl', 'prescription_file_url')
  )
  if (hasSavedFile) return true

  return Boolean(
    options.allowPendingFile &&
      getClaimField(claimData, 'prescriptionFileName', 'prescription_file_name')
  )
}
const VALID_ORGANIZATION_TYPES = ['pharmacy', 'hospital']
const MAX_DIAGNOSES_PER_CLAIM = 10
const NHIS_CC_CODE_DIGITS = 5
const NHIS_PRESCRIBING_LEVELS = ['A', 'M', 'B1', 'B2', 'C', 'D', 'SM']
// ✅ NHIA CONFIG PATCH START
const CLAIM_IT_PROVIDER_CLASS_LEVELS = ['B1', 'B2', 'C', 'D', 'M', 'SM']
// ✅ NHIA CONFIG PATCH END
const HOSPITAL_PROVIDER_CLASS_LEVELS = CLAIM_IT_PROVIDER_CLASS_LEVELS
const HOSPITAL_PROVIDER_CLASS_RANKS = HOSPITAL_PROVIDER_CLASS_LEVELS.reduce((levels, level, index) => ({
  ...levels,
  [level]: index + 1,
}), {})
const HOSPITAL_SERVICE_KIND_MINIMUM_LEVELS = {
  opd: 'B1',
  tariff: 'B1',
  zoom: 'B2',
  referral: 'B2',
  investigation: 'B2',
  inpatient: 'C',
  procedure: 'D',
}
const HOSPITAL_TARIFF_GROUP_MINIMUM_LEVELS = [
  { terms: ['tertiary', 'teaching', 'specialist'], level: 'SM' },
  { terms: ['secondary', 'regional'], level: 'M' },
  { terms: ['primary care hospital', 'private primary care hospital', 'chag primary care hospital'], level: 'D' },
  { terms: ['clinic', 'health center', 'health centre', 'maternity', 'dental', 'eye center', 'diagnostic center', 'chps'], level: 'C' },
]
const HOSPITAL_PROVIDER_CLASS_FIELD_KEYS = [
  'minimumProviderClassLevel',
  'minimum_provider_class_level',
  'requiredProviderClassLevel',
  'required_provider_class_level',
  'minProviderClassLevel',
  'min_provider_class_level',
  'providerClassLevel',
  'provider_class_level',
  'minimumProviderLevel',
  'minimum_provider_level',
  'requiredProviderLevel',
  'required_provider_level',
]
const HOSPITAL_PROVIDER_CLASS_LIST_FIELD_KEYS = [
  'allowedProviderClassLevels',
  'allowed_provider_class_levels',
  'providerClassLevels',
  'provider_class_levels',
  'allowedProviderLevels',
  'allowed_provider_levels',
]
const NHIS_PRESCRIBING_LEVEL_RANKS = NHIS_PRESCRIBING_LEVELS.reduce((levels, level, index) => ({
  ...levels,
  [level]: index + 1,
}), {})
const NHIS_PRESCRIPTION_BUCKET = 'nhis-prescriptions'
const MAX_PRESCRIPTION_ATTACHMENT_BYTES = 3 * 1024 * 1024
const MAX_CLAIMIT_ATTACHMENT_BYTES = 8 * 1024 * 1024
const PRESCRIPTION_ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png']
const PRESCRIPTION_ATTACHMENT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png']
const CLAIMIT_ATTACHMENT_MIME_TYPE = 'application/pdf'
const CLAIMIT_ATTACHMENT_FILE_TYPE = 'pdf'
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const OPTIONAL_CLAIM_SCHEMA_COLUMNS = [
  'patient_address',
  'child_weight_kg',
  'diagnosis',
  'unserved_medicines_note',
  'diagnosis_details',
  'prescription_file_url',
  'prescription_file_path',
  'prescription_file_name',
  'prescription_file_type',
  'prescription_file_size',
  'claimit_attachment_file_name',
  'claimit_attachment_file_type',
  'claimit_attachment_mime_type',
  'claimit_attachment_base64',
]
const CLAIMIT_EXPORT_FORMATS = ['cxf', 'xml', 'json', 'csv']
const NHIA_TARIFF_VERSION = 'FEB 2023'
const CLAIM_IT_MEDICINE_PRICE_VERSION = '2025-05-01.250531'
const CLAIM_IT_SERVICE_TARIFF_VERSION = '2023-02-01.250531'
const CLAIM_IT_POLICY_VERSION = 'cgs.2022-12-01.250531'
const NHIA_API_SETTINGS_CACHE_PREFIX = 'healthflow.nhiaApiSettings.v3'
const CLAIMIT_BRIDGE_QUEUE_KEY = 'healthflow.claimitBridgeQueue.v1'
const CLAIMIT_BRIDGE_RETRY_INTERVAL_MS = 60 * 1000
const CLAIMIT_BRIDGE_MODES = new Set(['claimit_bridge', 'claimit_assisted'])
const PENDING_CLAIMIT_CC_MESSAGE = 'Pending CLAIM-it validation'
const NHIA_API_SETTINGS_CACHE_FIELDS = [
  'id',
  'branchId',
  'branch_id',
  'mode',
  'organizationId',
  'organization_id',
  'providerId',
  'provider_id',
  'facilityCode',
  'facility_code',
  'providerNumber',
  'provider_number',
  'schemeName',
  'scheme_name',
  'facilityType',
  'facility_type',
  'pharmacyFacilityLevel',
  'pharmacy_facility_level',
  'providerClassLevel',
  'provider_class_level',
  'providerLevelCode',
  'provider_level_code',
  'credentialCode',
  'credential_code',
  'licenseNumber',
  'license_number',
  'accreditationExpiryDate',
  'accreditationExpiry',
  'nhiaAccreditationExpiry',
  'accreditation_expiry_date',
  'claimsOfficerName',
  'claims_officer_name',
  'admissionPaymentOption',
  'admission_payment_option',
  'claimitValidationEnabled',
  'claimit_validation_enabled',
  'submitterId',
  'submitter_id',
  'nhiaApiMode',
  'nhia_api_mode',
  'integrationMode',
  'integration_mode',
  'connectionProfile',
  'connection_profile',
  'validationMode',
  'validation_mode',
  'claimControlMode',
  'claim_control_mode',
  'apiEnvironment',
  'api_environment',
  'apiBaseUrl',
  'api_base_url',
  'sandboxBaseUrl',
  'sandbox_base_url',
  'productionBaseUrl',
  'production_base_url',
  'claimEndpointPath',
  'claim_endpoint_path',
  'claimSubmitEndpoint',
  'claim_submit_endpoint',
  'claimValidationEndpointPath',
  'claim_validation_endpoint_path',
  'ccEndpointPath',
  'cc_endpoint_path',
  'ccCodeEndpointPath',
  'cc_code_endpoint_path',
  'claimStatusEndpointPath',
  'claim_status_endpoint_path',
  'claimStatusEndpoint',
  'claim_status_endpoint',
  'memberLookupEndpointPath',
  'member_lookup_endpoint_path',
  'memberLookupEndpoint',
  'member_lookup_endpoint',
  'username',
  'hasPassword',
  'has_password',
  'directApiEnabled',
  'direct_api_enabled',
  'credentialMode',
  'credential_mode',
  'hasApiKey',
  'has_api_key',
  'hasApiSecret',
  'has_api_secret',
  'exportFormat',
  'export_format',
]
const NHIA_SECRET_FIELDS = new Set(['apiKey', 'apiSecret', 'password'])
const NHIA_API_CONFIG_TABLE = 'nhia_configuration'
const NHIA_CONFIG_TABLE = 'nhia_configuration'
const NHIA_LEGACY_INTEGRATIONS_TABLE = 'organization_nhia_integrations'
const NHIA_CONFIG_DEFAULTS = {
  id: '',
  branchId: '',
  mode: 'ONLINE_CLOUD',
  providerId: '',
  credentialCode: '',
  accreditationExpiryDate: '',
  claimsOfficerName: '',
  apiBaseUrl: '',
  submitterId: '',
  apiKeyEncrypted: '',
  apiSecretEncrypted: '',
  hasApiKey: false,
  hasApiSecret: false,
  username: '',
  passwordEncrypted: '',
  hasPassword: false,
  claimSubmitEndpoint: '',
  claimStatusEndpoint: '',
  memberLookupEndpoint: '',
  ccEndpointPath: '',
  validationMode: 'validate_before_submit',
  updatedAt: '',
  updatedBy: '',
}

const logNhiaAccreditationExpiryDate = (action, value) => {
  if (import.meta.env.DEV) {
    console.info(`[NHIA export] ${action} accreditationExpiryDate`, value || '')
  }
}

const NHIS_CLAIM_MEDICINES_SELECT = `
      *,
      nhis_claim_medicines (
        id, nhis_drug_id, drug_code, description, unit,
        unit_price, dispensed_qty, dispensary_date,
        dose, frequency, duration, total_amount,
        medicine_access_level, required_pharmacy_level
      )
    `

const NHIS_CLAIM_MEDICINES_SELECT_BASIC = `
      *,
      nhis_claim_medicines (
        id, nhis_drug_id, drug_code, description, unit,
        unit_price, dispensed_qty, dispensary_date,
        dose, frequency, duration, total_amount
      )
    `

const NHIS_CLAIM_SERVICE_SELECT = `
      id, nhia_tariff_item_id, tariff_version, facility_group, catering_option,
      mdc, gdrg_code, description, age_band, unit_price, quantity,
      service_date, total_amount, source_file, source_page
    `

export const normalizeOrganizationType = (value) => {
  const normalized = asText(value).toLowerCase()
  return VALID_ORGANIZATION_TYPES.includes(normalized) ? normalized : 'pharmacy'
}

const normalizeRuleOrganizationType = (value) => {
  const normalized = asText(value).toLowerCase()
  return ['hospital', 'pharmacy', 'all'].includes(normalized) ? normalized : 'hospital'
}

export const normalizeNhisPrescribingLevel = (value) => {
  const normalized = asText(value).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return NHIS_PRESCRIBING_LEVELS.includes(normalized) ? normalized : ''
}

// ✅ NHIA CONFIG PATCH START
const normalizeClaimItProviderClassLevel = (value, fallback = '') =>
  normalizeNhiaProviderClassLevel(value, fallback)

const normalizeClaimItPharmacyFacilityLevel = (value, fallback = '') =>
  normalizeNhiaPharmacyFacilityLevel(value, fallback)

const getClaimItCredentialCode = (payload = {}) =>
  normalizeText(payload.credentialCode || payload.credential_code || payload.facilityCode || payload.facility_code)

const getNhiaFacilityType = (payload = {}) => {
  const organizationType = normalizeOrganizationType(payload.organizationType || payload.organization_type)
  return normalizeNhiaFacilityTypeForOrganization(
    payload.facilityType || payload.facility_type || payload.providerTypeDescription,
    organizationType
  )
}

const isClaimItPharmacyType = (payload = {}) =>
  normalizeOrganizationType(payload.organizationType || payload.organization_type) === 'pharmacy' ||
  ['Pharmacy', 'Chemical Seller'].includes(getNhiaFacilityType(payload))

const resolveClaimItProviderClassLevel = (payload = {}) =>
  normalizeClaimItProviderClassLevel(
    payload.providerClassLevel || payload.provider_class_level,
    isClaimItPharmacyType(payload) ? 'C' : ''
  )

const resolveClaimItPharmacyFacilityLevel = (payload = {}) =>
  isClaimItPharmacyType(payload)
    ? normalizeClaimItPharmacyFacilityLevel(
        payload.pharmacyFacilityLevel || payload.pharmacy_facility_level || payload.pharmacyLevel || payload.pharmacy_level,
        'P1'
      )
    : ''

const resolveClaimItProviderLevelCode = (payload = {}, claimRow = {}) =>
  normalizeText(payload.providerLevelCode || payload.provider_level_code) ||
  [claimRow.ownershipTypeCode || 'PVT', claimRow.facilityTypeCode || getClaimItFacilityType(payload), claimRow.cateringStatusCode || 'CE']
    .filter(Boolean)
    .join('-')

export const buildClaimItConfigPreview = (settings = {}, options = {}) => {
  const organizationType = normalizeOrganizationType(options.organizationType || settings.organizationType || settings.organization_type)
  const facilityType = getNhiaFacilityType({ ...settings, organizationType })
  const payload = {
    ...settings,
    organizationType,
    facilityType,
    providerClassLevel: resolveClaimItProviderClassLevel({ ...settings, organizationType, facilityType }),
    pharmacyFacilityLevel: resolveClaimItPharmacyFacilityLevel({ ...settings, organizationType, facilityType }),
  }
  const credentialCode = getClaimItCredentialCode(payload)
  const credentialParts = splitClaimItCredentialCode(credentialCode)
  const facilityTypeCode = getClaimItFacilityType(payload)
  const providerLevel = resolveClaimItProviderLevelCode(payload, {
    ownershipTypeCode: credentialParts.ownershipCode === '02' ? 'PVT' : 'PVT',
    facilityTypeCode,
    cateringStatusCode: credentialParts.cateringStatusCode === '2' ? 'CE' : 'CE',
  })

  return {
    facilityName: normalizeText(payload.facilityName || payload.facility_name),
    providerID: getClaimItProviderCode(payload),
    providerLevel,
    providerClassLevel: payload.providerClassLevel,
    pharmacyFacilityLevel: payload.pharmacyFacilityLevel,
    facilityType,
    facilityCode: normalizeText(payload.facilityCode || payload.facility_code),
    credentialCode,
    licenseNumber: normalizeText(payload.licenseNumber || payload.license_number),
    accreditationExpiryDate: getNhiaAccreditationExpiryDate(payload),
  }
}
// ✅ NHIA CONFIG PATCH END

export const normalizeNhisCcCode = (value) => asText(value).replace(/\D/g, '')

const getNhisCcCodeIssue = (value) => {
  const digits = normalizeNhisCcCode(value)
  if (!digits) return 'CCC/CC code is required before serving this NHIS claim.'
  if (digits.length !== NHIS_CC_CODE_DIGITS) return `CCC/CC code must contain exactly ${NHIS_CC_CODE_DIGITS} digits.`
  return ''
}

const assertNhisCcCode = (value) => {
  const issue = getNhisCcCodeIssue(value)
  if (issue) throw new Error(issue)
  return normalizeNhisCcCode(value)
}

const shouldAllowPendingClaimControl = (options = {}) =>
  ['claimit_bridge', 'direct_api'].includes(normalizeText(options.claimControlMode || options.claim_control_mode))

const normalizeOptionalNhisCcCodeForMode = (value, options = {}) => {
  const digits = normalizeNhisCcCode(value)
  if (digits) return assertNhisCcCode(digits)
  if (shouldAllowPendingClaimControl(options)) return ''
  return assertNhisCcCode(value)
}

const normalizeMatchText = (value) => asText(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')

const validateMemberNumberFormat = (value, options = {}) => {
  return validateNhiaMemberNumberFormat(value, options)
}

const splitDiagnoses = (value) =>
  asText(value)
    .split(/[;\n|]/)
    .map(asText)
    .filter(Boolean)

const normalizeDiagnosisDetails = (value) => {
  const raw = typeof value === 'string'
    ? (() => {
        try {
          return JSON.parse(value)
        } catch {
          return []
        }
      })()
    : value

  if (!Array.isArray(raw)) return []

  return raw
    .map((diagnosis) => ({
      code: asText(diagnosis?.code) || null,
      label: asText(diagnosis?.label ?? diagnosis?.diagnosis ?? diagnosis?.name),
      source: asText(diagnosis?.source ?? diagnosis?.diagnosis_source) || 'Custom',
      sourceVersion: asText(diagnosis?.sourceVersion ?? diagnosis?.source_version) || null,
      custom: Boolean(diagnosis?.custom),
    }))
    .filter((diagnosis) => diagnosis.label)
}

const getDiagnosisDetailsPayload = (claimData) => {
  const details = normalizeDiagnosisDetails(claimData?.diagnosisDetails ?? claimData?.diagnosis_details)
  return details.length ? details : []
}

const isMissingOptionalClaimColumn = (error) => {
  const message = String(error?.message || '').toLowerCase()
  return (
    error?.code === 'PGRST204' ||
    message.includes('schema cache') ||
    OPTIONAL_CLAIM_SCHEMA_COLUMNS.some((column) => message.includes(column))
  )
}

const getMissingOptionalClaimColumns = (error) => {
  const message = String(error?.message || '').toLowerCase()
  return OPTIONAL_CLAIM_SCHEMA_COLUMNS.filter((column) => message.includes(column))
}

const isMissingClaimServicesTable = (error) => {
  const message = String(error?.message || '').toLowerCase()
  return (
    ['42P01', 'PGRST200', 'PGRST205'].includes(error?.code) ||
    message.includes('nhis_claim_services') ||
    message.includes('relationship') ||
    message.includes('schema cache')
  )
}

const isMissingOptionalClaimMedicineColumn = (error) => {
  const message = String(error?.message || '').toLowerCase()
  return (
    error?.code === 'PGRST204' ||
    message.includes('schema cache') ||
    message.includes('medicine_access_level') ||
    message.includes('required_pharmacy_level')
  )
}

const OPTIONAL_CLAIM_MEDICINE_SCHEMA_COLUMNS = ['medicine_access_level', 'required_pharmacy_level']

const stripClaimSchemaColumns = (payload, columns = OPTIONAL_CLAIM_SCHEMA_COLUMNS) => {
  const stripped = { ...payload }
  columns.forEach((column) => {
    delete stripped[column]
  })
  return stripped
}

const stripOptionalClaimSchemaColumns = (payload, error = null) => {
  const missingColumns = getMissingOptionalClaimColumns(error)
  return stripClaimSchemaColumns(payload, missingColumns.length ? missingColumns : OPTIONAL_CLAIM_SCHEMA_COLUMNS)
}

const insertNhisClaimWithSchemaFallback = async (payload) => {
  const insertPayload = { ...payload }
  const result = await supabase
    .from('nhis_claims')
    .insert([insertPayload])
    .select()
    .single()

  if (!result.error || !isMissingOptionalClaimColumn(result.error)) {
    return result
  }

  return await supabase
    .from('nhis_claims')
    .insert([stripOptionalClaimSchemaColumns(insertPayload, result.error)])
    .select()
    .single()
}

const updateNhisClaimWithSchemaFallback = async (id, payload) => {
  const updatePayload = { ...payload }
  const result = await supabase
    .from('nhis_claims')
    .update(updatePayload)
    .eq('id', id)
    .eq('status', 'served')
    .select()
    .single()

  if (!result.error || !isMissingOptionalClaimColumn(result.error)) {
    return result
  }

  return await supabase
    .from('nhis_claims')
    .update(stripOptionalClaimSchemaColumns(updatePayload, result.error))
    .eq('id', id)
    .eq('status', 'served')
    .select()
    .single()
}

const DIAGNOSIS_TREATMENT_RULES = [
  {
    label: 'Malaria',
    diagnosis: ['malaria', 'plasmodium', 'b50', 'b51', 'b52', 'b53', 'b54'],
    treatments: ['artem', 'lumefantrine', 'amodiaquine', 'artesunate', 'quinine', 'sulfadoxine', 'pyrimethamine', 'primaquine'],
  },
  {
    label: 'Hypertension',
    diagnosis: ['hypertension', 'blood pressure', 'hypertensive', 'i10', 'i11', 'i12', 'i13', 'i15'],
    treatments: ['amlodipine', 'nifedipine', 'lisinopril', 'losartan', 'bendro', 'bendroflumethiazide', 'atenolol', 'methyldopa', 'hydrochlorothiazide', 'bisoprolol', 'captopril', 'enalapril', 'valsartan'],
  },
  {
    label: 'Diabetes',
    diagnosis: ['diabetes', 'diabetic', 'e10', 'e11', 'e12', 'e13', 'e14'],
    treatments: ['metformin', 'insulin', 'glibenclamide', 'gliclazide', 'glimepiride', 'sitagliptin'],
  },
  {
    label: 'Asthma',
    diagnosis: ['asthma', 'wheeze', 'bronchospasm', 'j45', 'j46'],
    treatments: ['salbutamol', 'aminophylline', 'beclometasone', 'beclomethasone', 'prednisolone', 'hydrocortisone', 'ipratropium', 'budesonide'],
  },
  {
    label: 'Infection',
    diagnosis: ['infection', 'sepsis', 'pneumonia', 'tonsillitis', 'otitis', 'uti', 'urinary', 'cellulitis', 'abscess', 'wound', 'typhoid', 'bacterial'],
    treatments: ['amoxicillin', 'ampicillin', 'co amoxiclav', 'amoxiclav', 'cefuroxime', 'ceftriaxone', 'cefixime', 'cephalexin', 'ciprofloxacin', 'azithromycin', 'metronidazole', 'doxycycline', 'cloxacillin', 'flucloxacillin', 'gentamicin', 'erythromycin'],
  },
  {
    label: 'Pain or fever',
    diagnosis: ['pain', 'headache', 'fever', 'pyrexia', 'migraine', 'r50', 'r51'],
    treatments: ['paracetamol', 'acetaminophen', 'ibuprofen', 'diclofenac', 'aspirin', 'tramadol'],
  },
  {
    label: 'Diarrhoea',
    diagnosis: ['diarrhoea', 'diarrhea', 'gastroenteritis', 'dysentery', 'cholera', 'a09'],
    treatments: ['ors', 'oral rehydration', 'zinc', 'metronidazole', 'ciprofloxacin'],
  },
  {
    label: 'Gastritis or ulcer',
    diagnosis: ['ulcer', 'gastritis', 'gerd', 'dyspepsia', 'reflux', 'k21', 'k25', 'k26', 'k29', 'k30'],
    treatments: ['omeprazole', 'ranitidine', 'antacid', 'pantoprazole', 'lansoprazole', 'esomeprazole'],
  },
  {
    label: 'Anaemia',
    diagnosis: ['anaemia', 'anemia', 'd50', 'd51', 'd52', 'd53', 'd64'],
    treatments: ['ferrous', 'folic', 'iron'],
  },
  {
    label: 'Allergy',
    diagnosis: ['allergy', 'allergic', 'urticaria', 'pruritus', 'rash', 'l50', 't78'],
    treatments: ['chlorpheniramine', 'cetirizine', 'loratadine', 'promethazine', 'hydrocortisone', 'prednisolone'],
  },
  {
    label: 'Cough or cold',
    diagnosis: ['cough', 'cold', 'urti', 'upper respiratory', 'rhinitis', 'j00', 'j06'],
    treatments: ['chlorpheniramine', 'cetirizine', 'dextromethorphan', 'guaifenesin', 'salbutamol', 'paracetamol'],
  },
  {
    label: 'Eye infection',
    diagnosis: ['conjunctivitis', 'eye infection', 'keratitis', 'h10', 'h16'],
    treatments: ['chloramphenicol', 'tetracycline eye', 'ciprofloxacin eye', 'gentamicin eye', 'ofloxacin eye'],
  },
  {
    label: 'Helminthiasis',
    diagnosis: ['worm', 'helminth', 'helminthiasis', 'schistosomiasis', 'b65', 'b76', 'b77', 'b78', 'b79', 'b80', 'b82'],
    treatments: ['albendazole', 'mebendazole', 'praziquantel'],
  },
]

const SUPPORTIVE_TREATMENT_KEYWORDS = [
  'paracetamol', 'acetaminophen', 'ors', 'oral rehydration', 'zinc', 'multivitamin',
  'vitamin', 'normal saline', 'dextrose', 'water for injection', 'syringe', 'needle',
  'cotton wool', 'plaster', 'gloves',
]

const ALWAYS_REVIEW_TREATMENT_KEYWORDS = [
  'amoxicillin', 'ampicillin', 'augmentin', 'azithromycin', 'ceftriaxone', 'cefuroxime',
  'cefixime', 'cephalexin', 'ciprofloxacin', 'cloxacillin', 'co amoxiclav', 'doxycycline',
  'erythromycin', 'gentamicin', 'levofloxacin', 'metronidazole', 'tetracycline', 'tinidazole',
  'artem', 'lumefantrine', 'amodiaquine', 'artesunate', 'quinine',
  'metformin', 'insulin', 'glibenclamide', 'gliclazide',
  'amlodipine', 'nifedipine', 'lisinopril', 'losartan',
  'salbutamol', 'aminophylline',
]

const splitRuleTerms = (value) => {
  if (Array.isArray(value)) {
    return value.map(asText).filter(Boolean)
  }
  return asText(value)
    .split(/[;,|]/)
    .map(asText)
    .filter(Boolean)
}

const normalizeClinicalRule = (rule) => ({
  id: rule?.id || null,
  label: asText(rule?.label ?? rule?.diagnosis_label),
  diagnosis: splitRuleTerms(rule?.diagnosis ?? rule?.diagnosis_keywords),
  treatments: splitRuleTerms(rule?.treatments ?? rule?.allowed_drug_keywords),
  drugCodes: splitRuleTerms(rule?.drugCodes ?? rule?.allowed_drug_codes).map((code) => code.toUpperCase()),
  severity: asText(rule?.severity || 'block').toLowerCase() === 'warn' ? 'warn' : 'block',
  organizationType: normalizeRuleOrganizationType(rule?.organizationType ?? rule?.organization_type ?? 'hospital'),
  isActive: rule?.is_active !== false && rule?.isActive !== false,
})

const normalizeClinicalRules = (rules = []) =>
  (rules || [])
    .map(normalizeClinicalRule)
    .filter((rule) => rule.isActive && rule.label && rule.diagnosis.length && (rule.treatments.length || rule.drugCodes.length))

const getDefaultClinicalRules = () => DIAGNOSIS_TREATMENT_RULES.map((rule) => normalizeClinicalRule(rule))

const getEffectiveClinicalRules = (rules = DIAGNOSIS_TREATMENT_RULES) => {
  const defaultRules = getDefaultClinicalRules()
  const providedRules = normalizeClinicalRules(rules)
  const effectiveRules = new Map(
    defaultRules
      .filter((rule) => ['hospital', 'all'].includes(rule.organizationType))
      .map((rule) => [normalizeMatchText(rule.label), rule])
  )

  providedRules
    .filter((rule) => ['hospital', 'all'].includes(rule.organizationType))
    .forEach((rule) => {
      effectiveRules.set(normalizeMatchText(rule.label), rule)
    })

  return [...effectiveRules.values()]
}

const getDiagnosisMatchText = (claimData) => {
  const diagnosisDetails = normalizeDiagnosisDetails(claimData?.diagnosisDetails ?? claimData?.diagnosis_details)
  return normalizeMatchText([
    getClaimField(claimData, 'diagnosis'),
    ...diagnosisDetails.flatMap((diagnosis) => [diagnosis.label, diagnosis.code]),
  ].filter(Boolean).join(' '))
}

const ruleMatchesTreatment = (rule, treatmentText, treatmentCodes = new Set()) => {
  const codeMatches = rule.drugCodes.length && rule.drugCodes.some((code) => treatmentCodes.has(code))
  const keywordMatches = rule.treatments.length && rule.treatments.some((keyword) => treatmentText.includes(normalizeMatchText(keyword)))
  return Boolean(codeMatches || keywordMatches)
}

const getMedicineMismatchReviewText = (medicine = {}) =>
  normalizeMatchText([
    medicine?.description,
    medicine?.genericName,
    medicine?.generic_name,
    medicine?.drugName,
    medicine?.drug_name,
    medicine?.drugCode,
    medicine?.drug_code,
  ].filter(Boolean).join(' '))

const isSupportiveTreatment = (medicineText) =>
  SUPPORTIVE_TREATMENT_KEYWORDS.some((keyword) => medicineText.includes(normalizeMatchText(keyword)))

const shouldStrictlyExplainTreatment = (medicineText) =>
  ALWAYS_REVIEW_TREATMENT_KEYWORDS.some((keyword) => medicineText.includes(normalizeMatchText(keyword)))

const getDiagnosisTreatmentMismatchBlockers = (claimData, medicines = [], rules = DIAGNOSIS_TREATMENT_RULES, options = {}) => {
  const diagnosis = getDiagnosisMatchText(claimData)
  if (!diagnosis) return []

  const normalizedRules = getEffectiveClinicalRules(rules)
  const matchedRules = normalizedRules.filter((rule) =>
    rule.diagnosis.some((keyword) => diagnosis.includes(keyword))
  )

  if (!matchedRules.length) {
    return (medicines || []).length && (options.finalSubmission || options.requireMedicineDirections)
      ? ['Diagnosis-treatment rule not found for the recorded diagnosis. Import or add a clinical rule before final submission to reduce rejection risk.']
      : []
  }

  const treatmentText = normalizeMatchText(
    (medicines || [])
      .map((medicine) => [
        medicine?.description,
        medicine?.genericName,
        medicine?.generic_name,
        medicine?.drugCode,
        medicine?.drug_code,
      ].filter(Boolean).join(' '))
      .join(' ')
  )
  const treatmentCodes = new Set(
    (medicines || [])
      .map((medicine) => asText(medicine?.drugCode ?? medicine?.drug_code).toUpperCase())
      .filter(Boolean)
  )

  const blockers = matchedRules
    .filter((rule) => {
      if (rule.severity !== 'block') return false
      return !ruleMatchesTreatment(rule, treatmentText, treatmentCodes)
    })
    .map((rule) => `${rule.label}: treatment does not appear to match the diagnosis. Correct the diagnosis or add a matching medicine before saving corrections/submission.`)

  ;(medicines || []).forEach((medicine, index) => {
    const medicineText = getMedicineMismatchReviewText(medicine)
    if (!medicineText || isSupportiveTreatment(medicineText)) return

    const medicineCode = asText(medicine?.drugCode ?? medicine?.drug_code).toUpperCase()
    const medicineCodes = new Set(medicineCode ? [medicineCode] : [])
    const explainedByClaimDiagnosis = matchedRules.some((rule) => ruleMatchesTreatment(rule, medicineText, medicineCodes))
    if (explainedByClaimDiagnosis) return

    const explainedByOtherRule = normalizedRules.find((rule) => ruleMatchesTreatment(rule, medicineText, medicineCodes))
    const label = `Medicine ${index + 1}`
    if (explainedByOtherRule) {
      blockers.push(`${label}: ${getMedicineDescription(medicine)} appears to be for ${explainedByOtherRule.label}, but that diagnosis is not recorded on this claim.`)
      return
    }

    if (shouldStrictlyExplainTreatment(medicineText)) {
      blockers.push(`${label}: ${getMedicineDescription(medicine)} is clinically significant but is not explained by the recorded diagnosis. Add the supporting diagnosis or remove the medicine.`)
    }
  })

  return blockers
}

const getProviderPrescribingLevel = (claimData = {}, options = {}) =>
  normalizeClaimItProviderClassLevel(
    options.providerClassLevel ??
      options.provider_class_level ??
      options.facilityLevel ??
      options.facility_level ??
      claimData?.providerClassLevel ??
      claimData?.provider_class_level ??
      claimData?.facilityLevel ??
      claimData?.facility_level
  )

const getMedicineLevelLookup = (drugCatalog = []) => {
  const byCode = new Map()
  const byId = new Map()

  ;(drugCatalog || []).forEach((drug) => {
    const level = normalizeNhisPrescribingLevel(
      drug?.category ??
        drug?.levelOfPrescribing ??
        drug?.level_of_prescribing ??
        drug?.prescribingLevel ??
        drug?.prescribing_level
    )
    if (!level) return

    const code = asText(drug?.code ?? drug?.drugCode ?? drug?.drug_code).toUpperCase()
    const id = asText(drug?.id ?? drug?.nhisDrugId ?? drug?.nhis_drug_id)
    if (code) byCode.set(code, level)
    if (id) byId.set(id, level)
  })

  return { byCode, byId }
}

const getMedicinePrescribingLevel = (medicine = {}, lookup = getMedicineLevelLookup()) => {
  const directLevel = normalizeNhisPrescribingLevel(
    medicine?.category ??
      medicine?.levelOfPrescribing ??
      medicine?.level_of_prescribing ??
      medicine?.prescribingLevel ??
      medicine?.prescribing_level
  )
  if (directLevel) return directLevel

  const code = asText(medicine?.drugCode ?? medicine?.drug_code).toUpperCase()
  if (code && lookup.byCode.has(code)) return lookup.byCode.get(code)

  const id = asText(medicine?.nhisDrugId ?? medicine?.nhis_drug_id)
  if (id && lookup.byId.has(id)) return lookup.byId.get(id)

  return ''
}

const canProviderPrescribeLevel = (providerLevel, requiredLevel) => {
  if (!providerLevel || !requiredLevel) return false
  if (requiredLevel === 'SM') return providerLevel === 'SM'
  // ✅ NHIA CONFIG PATCH START
  if (CLAIM_IT_PROVIDER_CLASS_LEVELS.includes(providerLevel) && CLAIM_IT_PROVIDER_CLASS_LEVELS.includes(requiredLevel)) {
    return (HOSPITAL_PROVIDER_CLASS_RANKS[providerLevel] || 0) >= (HOSPITAL_PROVIDER_CLASS_RANKS[requiredLevel] || 0)
  }
  // ✅ NHIA CONFIG PATCH END
  return (NHIS_PRESCRIBING_LEVEL_RANKS[providerLevel] || 0) >= (NHIS_PRESCRIBING_LEVEL_RANKS[requiredLevel] || 0)
}

const getFirstPresentField = (source = {}, keys = []) => {
  for (const key of keys) {
    const value = source?.[key]
    if (Array.isArray(value) ? value.length : asText(value)) return value
  }
  return ''
}

const parseHospitalProviderClassList = (value) => {
  if (Array.isArray(value)) {
    return value.map((level) => normalizeClaimItProviderClassLevel(level)).filter(Boolean)
  }

  const text = asText(value)
  if (!text) return []

  if (text.startsWith('[')) {
    try {
      return parseHospitalProviderClassList(JSON.parse(text))
    } catch {
      // Fall through to delimiter parsing for malformed copied values.
    }
  }

  return text
    .split(/[,\s;/|]+/)
    .map((level) => normalizeClaimItProviderClassLevel(level))
    .filter(Boolean)
}

const getHighestHospitalProviderClassLevel = (levels = []) =>
  levels
    .map((level) => normalizeClaimItProviderClassLevel(level))
    .filter(Boolean)
    .sort((left, right) => (HOSPITAL_PROVIDER_CLASS_RANKS[right] || 0) - (HOSPITAL_PROVIDER_CLASS_RANKS[left] || 0))[0] || ''

const canHospitalProviderAccessLevel = (providerLevel, requiredLevel) => {
  const provider = normalizeClaimItProviderClassLevel(providerLevel)
  const required = normalizeClaimItProviderClassLevel(requiredLevel)
  return Boolean(provider && required && (HOSPITAL_PROVIDER_CLASS_RANKS[provider] || 0) >= (HOSPITAL_PROVIDER_CLASS_RANKS[required] || 0))
}

const ANTIBIOTIC_KEYWORDS = [
  'amoxicillin', 'ampicillin', 'augmentin', 'azithromycin', 'ceftriaxone', 'cefuroxime',
  'cefixime', 'cephalexin', 'ciprofloxacin', 'cloxacillin', 'co amoxiclav', 'doxycycline',
  'erythromycin', 'gentamicin', 'levofloxacin', 'metronidazole', 'tetracycline', 'tinidazole',
]

const INFECTION_DIAGNOSIS_KEYWORDS = [
  'abscess', 'cellulitis', 'cholera', 'diarrhoea', 'diarrhea', 'dysentery', 'infection',
  'otitis', 'pneumonia', 'sepsis', 'sinusitis', 'tonsillitis', 'typhoid', 'uti', 'urinary',
]

const SUPPORTING_INVESTIGATION_RULES = [
  {
    label: 'Malaria',
    diagnosis: ['malaria'],
    investigations: ['malaria test', 'rdt', 'rapid diagnostic', 'blood film', 'mp test'],
    message: 'Malaria: supporting malaria test/RDT or blood film should be documented before final submission.',
  },
  {
    label: 'Typhoid fever',
    diagnosis: ['typhoid'],
    investigations: ['widal', 'blood culture', 'stool culture', 'cbc', 'full blood count'],
    message: 'Typhoid fever: supporting Widal, culture, or CBC should be documented before final submission.',
  },
  {
    label: 'Diabetes',
    diagnosis: ['diabetes', 'diabetic'],
    investigations: ['glucose', 'fbs', 'rbs', 'hba1c', 'urinalysis'],
    message: 'Diabetes: glucose/HbA1c or urinalysis monitoring should be documented where applicable.',
  },
]

const GENDER_CONFLICT_RULES = [
  {
    gender: 'male',
    terms: ['antenatal', 'pregnancy', 'pregnant', 'labour', 'delivery', 'abortion', 'uterine', 'ovarian', 'cervix'],
    message: 'Critical: male patient has a pregnancy/obstetric or female reproductive diagnosis. Correct patient gender or diagnosis before submission.',
  },
  {
    gender: 'female',
    terms: ['prostate', 'prostatic', 'bph', 'testicular', 'testis', 'undescended testis'],
    message: 'Critical: female patient has a male reproductive diagnosis. Correct patient gender or diagnosis before submission.',
  },
]

const MAJOR_PROCEDURE_KEYWORDS = [
  'ct scan', 'mri', 'surgery', 'surgical', 'theatre', 'operation', 'laparotomy',
  'appendectomy', 'caesarean', 'cesarean', 'orthopaedic', 'orthopedic',
]

const SIMPLE_DIAGNOSIS_KEYWORDS = ['malaria', 'headache', 'urti', 'cold', 'gastroenteritis']
const PROCEDURE_DIAGNOSIS_KEYWORDS = ['appendicitis', 'fracture', 'trauma', 'obstetric', 'delivery', 'surgical', 'tumour', 'tumor']
const CHRONIC_DIAGNOSIS_KEYWORDS = ['hypertension', 'diabetes', 'diabetic', 'asthma', 'hiv', 'ckd', 'kidney']

const calculateAge = (dateOfBirth) => {
  if (!dateOfBirth) return null
  const dob = new Date(dateOfBirth)
  if (Number.isNaN(dob.getTime())) return null
  const today = new Date()
  let age = today.getFullYear() - dob.getFullYear()
  const monthDelta = today.getMonth() - dob.getMonth()
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < dob.getDate())) age -= 1
  return age
}

const getTariffAgeBandIssue = (ageBand, patientAge, serviceLabel) => {
  const raw = asText(ageBand).toLowerCase().replace(/\s+/g, '')
  const normalized = normalizeMatchText(ageBand)
  if (!normalized) return null
  if (patientAge === null) {
    return `${serviceLabel}: patient date of birth is required to validate tariff age band ${ageBand}.`
  }
  if (/under|below|less/.test(normalized) && normalized.includes('12') && patientAge >= 12) {
    return `${serviceLabel}: tariff age band ${ageBand} is for patients under 12, but this patient is ${patientAge}.`
  }
  if ((raw.includes('<12') || raw.includes('under12') || raw.includes('below12') || normalized.includes('lt12')) && patientAge >= 12) {
    return `${serviceLabel}: tariff age band ${ageBand} is for patients under 12, but this patient is ${patientAge}.`
  }
  if ((raw.includes('>=12') || raw.includes('≥12') || normalized.includes('12yrsandabove') || normalized.includes('12yearsandabove')) && patientAge < 12) {
    return `${serviceLabel}: tariff age band ${ageBand} is for patients 12 and above, but this patient is ${patientAge}.`
  }
  return null
}

const normalizeTariffCatalogItem = (item = {}) => ({
  id: asText(item.id ?? item.nhiaTariffItemId ?? item.nhia_tariff_item_id),
  tariffVersion: asText(item.tariffVersion ?? item.tariff_version) || NHIA_TARIFF_VERSION,
  facilityGroup: asText(item.facilityGroup ?? item.facility_group),
  cateringOption: asText(item.cateringOption ?? item.catering_option),
  mdc: asText(item.mdc),
  gdrgCode: asText(item.gdrgCode ?? item.gdrg_code).toUpperCase(),
  description: asText(item.description),
  tariffAmount: asNumber(item.tariffAmount ?? item.tariff_amount ?? item.unitPrice ?? item.unit_price),
  ageBand: asText(item.ageBand ?? item.age_band),
  providerClassLevel: normalizeClaimItProviderClassLevel(item.providerClassLevel ?? item.provider_class_level),
  minimumProviderClassLevel: normalizeClaimItProviderClassLevel(
    getFirstPresentField(item, HOSPITAL_PROVIDER_CLASS_FIELD_KEYS)
  ),
  allowedProviderClassLevels: parseHospitalProviderClassList(
    getFirstPresentField(item, HOSPITAL_PROVIDER_CLASS_LIST_FIELD_KEYS)
  ),
  sourceFile: asText(item.sourceFile ?? item.source_file),
  sourcePage: item.sourcePage ?? item.source_page ?? null,
})

const getTariffCatalogKey = ({ tariffVersion, facilityGroup, cateringOption, gdrgCode } = {}) =>
  [
    asText(tariffVersion || NHIA_TARIFF_VERSION).toLowerCase(),
    asText(facilityGroup).toLowerCase(),
    asText(cateringOption).toLowerCase(),
    asText(gdrgCode).toUpperCase(),
  ].join('|')

const getTariffCatalogLookup = (items = []) => {
  const byId = new Map()
  const byKey = new Map()
  ;(items || []).map(normalizeTariffCatalogItem).forEach((item) => {
    if (!item.gdrgCode) return
    if (item.id) byId.set(item.id, item)
    byKey.set(getTariffCatalogKey(item), item)
  })
  return { byId, byKey }
}

const getExpectedTariffForService = (service, lookup) => {
  if (!lookup) return null
  return lookup.byId.get(service.nhiaTariffItemId) ||
    lookup.byKey.get(getTariffCatalogKey(service)) ||
    null
}

const amountsDiffer = (a, b) => {
  const left = Number(a)
  const right = Number(b)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  return Math.abs(left - right) >= 0.01
}

const getMedicineCode = (medicine = {}) => asText(medicine?.drugCode ?? medicine?.drug_code).toUpperCase()

const getMedicineDescription = (medicine = {}) =>
  asText(
    medicine?.description ??
      medicine?.genericName ??
      medicine?.generic_name ??
      medicine?.drugName ??
      medicine?.drug_name ??
      getMedicineCode(medicine)
  )

const getMedicineClinicalText = (medicine = {}) =>
  normalizeMatchText([
    medicine?.description,
    medicine?.genericName,
    medicine?.generic_name,
    medicine?.drugName,
    medicine?.drug_name,
    medicine?.dosageForm,
    medicine?.dosage_form,
    medicine?.drugCode,
    medicine?.drug_code,
  ].filter(Boolean).join(' '))

const includesAnyTerm = (text, terms = []) =>
  terms.some((term) => text.includes(normalizeMatchText(term)))

const getClaimItemText = (item = {}) =>
  normalizeMatchText(
    typeof item === 'string'
      ? item
      : [
          item?.name,
          item?.label,
          item?.description,
          item?.service,
          item?.serviceName,
          item?.service_name,
          item?.procedure,
          item?.procedureName,
          item?.procedure_name,
          item?.code,
        ].filter(Boolean).join(' ')
  )

const getClaimItems = (claimData = {}, options = {}, keys = []) =>
  keys.flatMap((key) => {
    const value = options[key] ?? claimData[key]
    if (!value) return []
    return Array.isArray(value) ? value : [value]
  })

const getNhiaTariffServices = (claimData = {}, options = {}) =>
  getClaimItems(claimData, options, [
    'nhiaTariffServices',
    'nhia_tariff_services',
    'nhisClaimServices',
    'nhis_claim_services',
    'claimServices',
  ])

const getTariffServiceCode = (service = {}) =>
  asText(service?.gdrgCode ?? service?.gdrg_code ?? service?.serviceCode ?? service?.service_code).toUpperCase()

const getTariffServiceDescription = (service = {}) =>
  asText(service?.description ?? service?.serviceDescription ?? service?.service_description ?? getTariffServiceCode(service))

const normalizeNhiaTariffServiceLine = (line = {}, claimData = {}) => {
  const unitPrice = asNumber(line.unitPrice ?? line.unit_price ?? line.tariffAmount ?? line.tariff_amount)
  const quantity = asNumber(line.quantity ?? line.qty ?? 1)
  const totalAmount = asNumber(line.totalAmount ?? line.total_amount)
  const safeQuantity = Number.isFinite(quantity) ? quantity : 1
  const safeUnitPrice = Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0
  const computedTotal = safeUnitPrice * Math.max(safeQuantity, 0)

  return {
    nhiaTariffItemId: asText(line.nhiaTariffItemId ?? line.nhia_tariff_item_id ?? line.id) || null,
    tariffVersion: asText(line.tariffVersion ?? line.tariff_version) || NHIA_TARIFF_VERSION,
    facilityGroup: asText(line.facilityGroup ?? line.facility_group) || null,
    cateringOption: asText(line.cateringOption ?? line.catering_option) || null,
    mdc: asText(line.mdc) || null,
    gdrgCode: getTariffServiceCode(line),
    description: getTariffServiceDescription(line),
    ageBand: asText(line.ageBand ?? line.age_band) || null,
    unitPrice: safeUnitPrice,
    quantity: safeQuantity,
    serviceDate: asText(line.serviceDate ?? line.service_date) || asText(claimData.serviceDate ?? claimData.service_date_from) || null,
    totalAmount: Number.isFinite(totalAmount) && totalAmount >= 0 ? totalAmount : computedTotal,
    providerClassLevel: normalizeClaimItProviderClassLevel(line.providerClassLevel ?? line.provider_class_level),
    minimumProviderClassLevel: normalizeClaimItProviderClassLevel(
      getFirstPresentField(line, HOSPITAL_PROVIDER_CLASS_FIELD_KEYS)
    ),
    allowedProviderClassLevels: parseHospitalProviderClassList(
      getFirstPresentField(line, HOSPITAL_PROVIDER_CLASS_LIST_FIELD_KEYS)
    ),
    sourceFile: asText(line.sourceFile ?? line.source_file) || null,
    sourcePage: line.sourcePage ?? line.source_page ?? null,
  }
}

const normalizeNhiaTariffServiceLines = (lines = [], claimData = {}) =>
  (lines || []).map((line) => normalizeNhiaTariffServiceLine(line, claimData))

const addUnique = (list, message) => {
  if (message && !list.includes(message)) list.push(message)
}

const parseDurationDays = (duration) => {
  const value = normalizeMatchText(duration)
  if (!value) return null
  const fractionMatch = value.match(/\b(\d+)\s*\/\s*7\b/)
  if (fractionMatch) return Number(fractionMatch[1])
  const numberMatch = value.match(/\b(\d+(?:\.\d+)?)\b/)
  if (!numberMatch) return null
  const amount = Number(numberMatch[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  if (value.includes('week')) return Math.round(amount * 7)
  if (value.includes('month')) return Math.round(amount * 30)
  return Math.round(amount)
}

const parseFrequencyPerDay = (frequency) => {
  const value = normalizeMatchText(frequency)
  if (!value) return null
  if (/\b(qid|qds|four times)\b/.test(value)) return 4
  if (/\b(tds|tid|three times)\b/.test(value)) return 3
  if (/\b(bd|bid|twice|two times)\b/.test(value)) return 2
  if (/\b(od|daily|once|nocte|night)\b/.test(value)) return 1
  const hourlyMatch = value.match(/\b(\d+)\s*hour/)
  if (hourlyMatch) {
    const hours = Number(hourlyMatch[1])
    return hours > 0 ? Math.ceil(24 / hours) : null
  }
  const timesMatch = value.match(/\b(\d+)\s*(?:x|times)\b/)
  if (timesMatch) return Number(timesMatch[1])
  return null
}

const parseDoseUnits = (dose) => {
  const value = normalizeMatchText(dose)
  if (!value) return 1
  const match = value.match(/\b(\d+(?:\.\d+)?)\s*(tablet|tab|capsule|cap|ml|sachet|vial|ampoule|suppository|puff|drop)s?\b/)
  if (!match) return 1
  const amount = Number(match[1])
  return Number.isFinite(amount) && amount > 0 ? amount : 1
}

const getDuplicateMedicineIssues = (medicines = [], strict = false) => {
  const seenByCode = new Map()
  const seenByDescription = new Map()
  const blockers = []
  const warnings = []

  medicines.forEach((medicine, index) => {
    const label = `Medicine ${index + 1}`
    const code = getMedicineCode(medicine)
    const description = normalizeMatchText(getMedicineDescription(medicine))

    if (code) {
      if (seenByCode.has(code)) {
        addUnique(blockers, `High: duplicate medicine code ${code} appears on the claim. Merge the quantities or remove the repeated line.`)
      } else {
        seenByCode.set(code, label)
      }
      return
    }

    if (description) {
      if (seenByDescription.has(description)) {
        const message = `${label}: possible duplicate medicine "${getMedicineDescription(medicine)}"; confirm it is clinically intentional.`
        if (strict) addUnique(blockers, `High: ${message}`)
        else addUnique(warnings, message)
      } else {
        seenByDescription.set(description, label)
      }
    }
  })

  return { blockers, warnings }
}

const getGenderDiagnosisIssues = (claimData = {}) => {
  const gender = normalizeMatchText(getClaimField(claimData, 'gender'))
  const diagnosisText = getDiagnosisMatchText(claimData)
  if (!gender || !diagnosisText) return []

  return GENDER_CONFLICT_RULES
    .filter((rule) => gender.includes(rule.gender) && includesAnyTerm(diagnosisText, rule.terms))
    .map((rule) => rule.message)
}

const getAgeClinicalIssues = (patientAge, medicines = [], claimData = {}) => {
  const blockers = []
  const warnings = []
  if (patientAge === null) return { blockers, warnings }

  const diagnosisText = getDiagnosisMatchText(claimData)
  if (patientAge < 8) {
    medicines.forEach((medicine, index) => {
      const text = getMedicineClinicalText(medicine)
      if (includesAnyTerm(text, ['tetracycline', 'doxycycline'])) {
        blockers.push(`Medicine ${index + 1}: tetracycline/doxycycline is age-restricted for children under 8. Use an approved alternative or document specialist justification.`)
      }
    })
  }

  if (patientAge < 16) {
    medicines.forEach((medicine, index) => {
      const text = getMedicineClinicalText(medicine)
      if (includesAnyTerm(text, ['aspirin', 'acetylsalicylic'])) {
        warnings.push(`Medicine ${index + 1}: aspirin is usually restricted in children; confirm indication and documentation before submission.`)
      }
    })
  }

  if (patientAge < 12 && includesAnyTerm(diagnosisText, ['hypertension', 'diabetes', 'ckd'])) {
    warnings.push('Pediatric chronic diagnosis selected; confirm age, diagnosis, and specialist documentation before submission.')
  }

  return { blockers, warnings }
}

const getDrugDiagnosisIssues = (claimData = {}, medicines = [], strict = false) => {
  const blockers = []
  const warnings = []
  const diagnosisText = getDiagnosisMatchText(claimData)
  if (!diagnosisText || !medicines.length) return { blockers, warnings }

  const hasInfectionDiagnosis = includesAnyTerm(diagnosisText, INFECTION_DIAGNOSIS_KEYWORDS)
  const hasMalariaDiagnosis = diagnosisText.includes('malaria')

  medicines.forEach((medicine, index) => {
    const label = `Medicine ${index + 1}`
    const text = getMedicineClinicalText(medicine)
    const isAntibiotic = includesAnyTerm(text, ANTIBIOTIC_KEYWORDS)

    if (isAntibiotic && !hasInfectionDiagnosis) {
      const message = `${label}: antibiotic/antimicrobial medicine is not supported by the recorded diagnosis. Add the infection diagnosis/clinical notes or remove the medicine.`
      if (strict || hasMalariaDiagnosis) addUnique(blockers, `High: ${message}`)
      else addUnique(warnings, message)
    }

    if (hasMalariaDiagnosis && includesAnyTerm(text, ['ceftriaxone', 'ciprofloxacin', 'tinidazole', 'surgery', 'theatre'])) {
      addUnique(blockers, `High: ${label}: this item is unusual for malaria-only claims. Add a supporting diagnosis or remove it before submission.`)
    }
  })

  return { blockers, warnings }
}

const getQuantityCostIssues = (claimData = {}, medicines = [], strict = false) => {
  const blockers = []
  const warnings = []
  const diagnosisText = getDiagnosisMatchText(claimData)
  const isChronic = includesAnyTerm(diagnosisText, CHRONIC_DIAGNOSIS_KEYWORDS)

  medicines.forEach((medicine, index) => {
    const label = `Medicine ${index + 1}`
    const quantity = asNumber(medicine?.dispensedQty ?? medicine?.dispensed_qty)
    const unitPrice = asNumber(medicine?.unitPrice ?? medicine?.unit_price)
    const total = Number.isFinite(quantity) && Number.isFinite(unitPrice) ? quantity * unitPrice : 0

    if (quantity > 180 && !isChronic) {
      addUnique(blockers, `High: ${label}: quantity ${quantity} is unusually high for an acute claim. Reduce quantity or add chronic/clinical justification.`)
    } else if (quantity > 90 && !isChronic) {
      addUnique(warnings, `${label}: quantity ${quantity} looks high for an acute claim; confirm duration and clinical justification.`)
    }

    const days = parseDurationDays(medicine?.duration)
    const perDay = parseFrequencyPerDay(medicine?.frequency)
    const doseUnits = parseDoseUnits(medicine?.dose)
    if (quantity > 0 && days && perDay) {
      const expected = Math.ceil(days * perDay * doseUnits)
      if (expected > 0 && quantity > expected * 3) {
        const message = `${label}: dispensed quantity ${quantity} is far above the dose/frequency/duration estimate (${expected}). Correct the quantity or directions.`
        if (strict) addUnique(blockers, `High: ${message}`)
        else addUnique(warnings, message)
      }
    }

    if (total > 1500) {
      addUnique(warnings, `${label}: line total GHS ${total.toFixed(2)} is unusually high; confirm tariff, quantity, and authorization.`)
    }
  })

  return { blockers, warnings }
}

const getSupportingInvestigationIssues = (claimData = {}, options = {}, strict = false) => {
  if (!strict) return []
  const diagnosisText = getDiagnosisMatchText(claimData)
  const investigationText = getClaimItems(claimData, options, ['labs', 'labInvestigations', 'investigations', 'claimInvestigations'])
    .map(getClaimItemText)
    .join(' ')

  return SUPPORTING_INVESTIGATION_RULES
    .filter((rule) => includesAnyTerm(diagnosisText, rule.diagnosis))
    .filter((rule) => !investigationText || !includesAnyTerm(investigationText, rule.investigations))
    .map((rule) => rule.message)
}

const getProcedureMismatchIssues = (claimData = {}, options = {}, strict = false) => {
  const diagnosisText = getDiagnosisMatchText(claimData)
  const procedureText = getClaimItems(claimData, options, ['procedures', 'services', 'claimServices'])
    .map(getClaimItemText)
    .join(' ')
  if (!diagnosisText || !procedureText) return []
  if (!includesAnyTerm(procedureText, MAJOR_PROCEDURE_KEYWORDS)) return []
  if (!includesAnyTerm(diagnosisText, SIMPLE_DIAGNOSIS_KEYWORDS)) return []
  if (includesAnyTerm(diagnosisText, PROCEDURE_DIAGNOSIS_KEYWORDS)) return []

  const message = 'High: major procedure or imaging item is not supported by the recorded diagnosis. Add a supporting diagnosis/pre-authorization or remove the item.'
  return strict ? [message] : [`${message} Confirm before final submission.`]
}

const getChronicDiseaseWarnings = (claimData = {}, options = {}, strict = false) => {
  if (!strict) return []
  const diagnosisText = getDiagnosisMatchText(claimData)
  const clinicalText = getClaimItems(claimData, options, ['vitals', 'labs', 'labInvestigations', 'investigations', 'clinicalNotes'])
    .map(getClaimItemText)
    .join(' ')
  const warnings = []

  if (includesAnyTerm(diagnosisText, ['hypertension', 'blood pressure']) && !includesAnyTerm(clinicalText, ['bp', 'blood pressure'])) {
    warnings.push('Hypertension: BP reading/monitoring should be documented before final submission.')
  }
  if (includesAnyTerm(diagnosisText, ['diabetes', 'diabetic']) && !includesAnyTerm(clinicalText, ['glucose', 'fbs', 'rbs', 'hba1c'])) {
    warnings.push('Diabetes: glucose or HbA1c monitoring should be documented before final submission.')
  }
  if (includesAnyTerm(diagnosisText, ['asthma']) && !includesAnyTerm(clinicalText, ['spo2', 'oxygen saturation', 'peak flow', 'wheeze'])) {
    warnings.push('Asthma: respiratory findings such as SpO2/peak flow/wheeze should be documented before final submission.')
  }

  return warnings
}

const getClaimRisk = (blockers = [], warnings = []) => {
  const score = Math.min(100, blockers.length * 25 + warnings.length * 8)
  const level = score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'moderate' : score > 0 ? 'low' : 'clean'
  return { score, level }
}

// ✅ NHIS CLAIM LOGIC SEPARATION PATCH START
const hasIcd10DiagnosisCode = (claimData = {}) => {
  const diagnosisDetails = normalizeDiagnosisDetails(claimData?.diagnosisDetails ?? claimData?.diagnosis_details)
  if (diagnosisDetails.some((diagnosis) => asText(diagnosis.code))) return true
  return /\b[A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?\b/i.test(asText(claimData?.diagnosis))
}

const getConfiguredTariffFacilityGroup = (options = {}) =>
  asText(
    options.tariffFacilityGroup ??
      options.tariff_facility_group ??
      options.nhiaTariffFacilityGroup ??
      options.nhia_tariff_facility_group
  )

const getConfiguredTariffCateringOption = (options = {}) =>
  asText(
    options.tariffCateringOption ??
      options.tariff_catering_option ??
      options.nhiaTariffCateringOption ??
      options.nhia_tariff_catering_option
  )

const getHospitalServiceKind = (service = {}) => {
  const text = normalizeMatchText([
    service.gdrgCode,
    service.gdrg_code,
    service.mdc,
    service.description,
    service.facilityGroup,
    service.facility_group,
  ].filter(Boolean).join(' '))
  if (includesAnyTerm(text, ['inpatient', 'admission', 'ward', 'alos'])) return 'inpatient'
  if (includesAnyTerm(text, ['investigation', 'laboratory', 'lab', 'x ray', 'xray', 'scan', 'ultrasound'])) return 'investigation'
  if (includesAnyTerm(text, ['procedure', 'surgery', 'operation', 'theatre', 'incision', 'excision'])) return 'procedure'
  if (includesAnyTerm(text, ['zoom'])) return 'zoom'
  if (includesAnyTerm(text, ['referral', 'referred'])) return 'referral'
  if (includesAnyTerm(text, ['opd', 'out patient', 'outpatient', 'consultation'])) return 'opd'
  return 'tariff'
}

const getHospitalTariffSetIssue = (service, expectedFacilityGroup, expectedCateringOption, label) => {
  const serviceFacilityGroup = asText(service.facilityGroup ?? service.facility_group)
  const serviceCateringOption = asText(service.cateringOption ?? service.catering_option)
  if (expectedFacilityGroup && serviceFacilityGroup && serviceFacilityGroup !== expectedFacilityGroup) {
    return `${label}: tariff belongs to ${serviceFacilityGroup}, but Settings are configured for ${expectedFacilityGroup}. Select the correct hospital tariff set.`
  }
  if (expectedCateringOption && serviceCateringOption && serviceCateringOption !== expectedCateringOption) {
    return `${label}: tariff catering option is ${serviceCateringOption}, but Settings are configured for ${expectedCateringOption}. Select the correct tariff.`
  }
  return ''
}

const getHospitalTariffGroupMinimumLevel = (service = {}) => {
  const text = normalizeMatchText(
    [
      service.facilityGroup,
      service.facility_group,
      service.providerTypeDescription,
      service.provider_type_description,
    ].filter(Boolean).join(' ')
  )
  if (!text) return ''

  const match = HOSPITAL_TARIFF_GROUP_MINIMUM_LEVELS.find((rule) =>
    rule.terms.some((term) => text.includes(normalizeMatchText(term)))
  )
  return match?.level || ''
}

const getHospitalProviderClassIssue = (service = {}, providerClassLevel = '', serviceKind = 'tariff', label = 'Service') => {
  const providerLevel = normalizeClaimItProviderClassLevel(providerClassLevel)
  if (!providerLevel) {
    return `${label}: NHIA hospital provider class/level is required before selecting G-DRG/tariff services.`
  }

  const allowedLevels = parseHospitalProviderClassList(
    getFirstPresentField(service, HOSPITAL_PROVIDER_CLASS_LIST_FIELD_KEYS)
  )
  if (allowedLevels.length && !allowedLevels.includes(providerLevel)) {
    return `${label}: G-DRG/tariff is limited to hospital provider class ${allowedLevels.join(', ')}, but Settings are ${providerLevel}. Select an allowed tariff or update Settings.`
  }

  const minimumLevel = getHighestHospitalProviderClassLevel([
    getFirstPresentField(service, HOSPITAL_PROVIDER_CLASS_FIELD_KEYS),
    getHospitalTariffGroupMinimumLevel(service),
    HOSPITAL_SERVICE_KIND_MINIMUM_LEVELS[serviceKind],
  ])

  if (minimumLevel && !canHospitalProviderAccessLevel(providerLevel, minimumLevel)) {
    return `${label}: ${getTariffServiceCode(service) || 'G-DRG/tariff'} requires hospital provider class ${minimumLevel} or higher, but Settings are ${providerLevel}. Select an allowed G-DRG/tariff for this facility.`
  }

  return ''
}
// ✅ NHIS CLAIM LOGIC SEPARATION PATCH END

export const assessNhisClaimReadiness = (claimData, medicines = [], options = {}) => {
  const blockers = []
  const warnings = []
  const tariffServices = normalizeNhiaTariffServiceLines(getNhiaTariffServices(claimData, options), claimData)
  const dateOfBirth = getClaimField(claimData, 'dateOfBirth', 'date_of_birth')
  const childWeight = getClaimField(claimData, 'childWeightKg', 'child_weight_kg')
  const organizationType = normalizeOrganizationType(
    claimData?.organizationType ?? claimData?.organization_type ?? claimData?.facilityType
  )
  const isHospital = organizationType === 'hospital'
  const diagnosis = getClaimField(claimData, 'diagnosis')
  const diagnoses = splitDiagnoses(diagnosis)
  const cccNo = getClaimField(claimData, 'cccNo', 'ccc_no') || getClaimField(claimData, 'ccCode', 'cc_code')
  const patientAge = calculateAge(dateOfBirth)
  const requireMedicineDirections = options.finalSubmission || options.requireMedicineDirections === true
  const requirePrescriptionAttachment = options.finalSubmission || options.requirePrescriptionAttachment === true
  const shouldCheckDiagnosisTreatmentMatch =
    isHospital &&
    (options.finalSubmission || options.enforceDiagnosisTreatmentMatch === true || requireMedicineDirections)
  const shouldCheckPrescribingLevel =
    options.finalSubmission || options.enforcePrescribingLevel === true || requireMedicineDirections
  const hasMedicineClaims = medicines?.length > 0
  const shouldCheckHospitalProviderClass =
    isHospital &&
    (options.finalSubmission || options.enforceHospitalProviderLevel === true || tariffServices.length > 0)
  const shouldRunClinicalScrub =
    isHospital &&
    (options.finalSubmission || options.enforceClinicalScrub === true || requireMedicineDirections)
  const providerPrescribingLevel = getProviderPrescribingLevel(claimData, options)
  const hospitalProviderClassLevel = isHospital ? providerPrescribingLevel : ''
  const medicineLevelLookup = getMedicineLevelLookup(options.nhisDrugCatalog ?? options.drugCatalog ?? [])
  const tariffCatalogLookup = getTariffCatalogLookup(
    options.currentNhiaTariffItems ?? options.nhiaTariffCatalog ?? options.tariffCatalog ?? []
  )
  // ✅ NHIS CLAIM LOGIC SEPARATION PATCH START
  const configuredTariffFacilityGroup = getConfiguredTariffFacilityGroup(options)
  const configuredTariffCateringOption = getConfiguredTariffCateringOption(options)
  // ✅ NHIS CLAIM LOGIC SEPARATION PATCH END
  // ✅ NHIS PHARMACY LEVEL PATCH START
  const facilityPharmacyLevel = getEffectivePharmacyLevel(
    options.pharmacyLevel,
    options.nhiaSettings,
    claimData
  )
  const medicineCatalog = options.nhisDrugCatalog ?? options.drugCatalog ?? []
  const medicineCatalogById = new Map(
    medicineCatalog
      .map((drug) => [asText(drug?.id), drug])
      .filter(([id]) => id)
  )
  const medicineCatalogByCode = new Map(
    medicineCatalog
      .map((drug) => [asText(drug?.code ?? drug?.drug_code ?? drug?.nhis_code).toUpperCase(), drug])
      .filter(([code]) => code)
  )
  // ✅ NHIS PHARMACY LEVEL PATCH END
  const memberNumberIssue = validateMemberNumberFormat(
    getClaimField(claimData, 'memberNo', 'member_no'),
    options
  )

  if (memberNumberIssue) blockers.push(memberNumberIssue)
  if (shouldCheckHospitalProviderClass && !hospitalProviderClassLevel) {
    blockers.push('Set the NHIA hospital provider class/level in Settings before saving/submitting hospital claims.')
  }
  if (hasMedicineClaims && shouldCheckPrescribingLevel && !facilityPharmacyLevel) {
    blockers.push(
      isHospital
        ? 'Set the NHIS pharmacy/medicine level in Settings before saving/submitting medicine claims for the hospital pharmacy module.'
        : 'Set the NHIS pharmacy level in Settings before saving/submitting pharmacy medicine claims.'
    )
  }
  if (!getClaimField(claimData, 'surname')) blockers.push('Patient surname is required.')
  if (!getClaimField(claimData, 'otherNames', 'other_names')) warnings.push('Patient other names are missing on the claim.')
  if (!getClaimField(claimData, 'folderNo', 'folder_no')) blockers.push('Folder number is required.')
  if (isHospital && !getClaimField(claimData, 'patientAddress', 'patient_address')) warnings.push('Patient address is missing on the claim.')
  if (!dateOfBirth) warnings.push('Patient date of birth is missing on the claim.')
  if (isHospital && patientAge !== null && patientAge < 12 && !(asNumber(childWeight) > 0)) {
    warnings.push('Child weight is missing for a child patient.')
  }
  const cccNoIssue = shouldAllowPendingClaimControl(options) && !normalizeNhisCcCode(cccNo)
    ? ''
    : getNhisCcCodeIssue(cccNo)
  if (cccNoIssue) blockers.push(cccNoIssue)
  if (!diagnosis && isHospital) {
    blockers.push('Diagnosis is required for hospital NHIS claims.')
  } else if (isHospital && diagnoses.length > MAX_DIAGNOSES_PER_CLAIM) {
    blockers.push(`Enter no more than ${MAX_DIAGNOSES_PER_CLAIM} diagnoses on one NHIS claim.`)
  }
  // ✅ NHIS CLAIM LOGIC SEPARATION PATCH START
  if (isHospital && diagnosis && !hasIcd10DiagnosisCode(claimData)) {
    warnings.push('Hospital NHIS claims should use an ICD-10 coded diagnosis before selecting G-DRG/tariff services.')
  }
  if (!isHospital && tariffServices.length) {
    blockers.push('Pharmacy NHIS claims cannot include hospital G-DRG/tariff service lines. Remove tariff services or switch to a hospital claim.')
  }
  // ✅ NHIS CLAIM LOGIC SEPARATION PATCH END
  if (!getClaimField(claimData, 'serviceDate', 'service_date_from')) blockers.push('Date of dispensing/service is required.')
  if (!getClaimField(claimData, 'referringFacility', 'referring_facility')) blockers.push('Prescribing facility is required.')
  if (!getClaimField(claimData, 'physicianName', 'physician_name')) {
    warnings.push('Prescriber name or ID is missing from the prescription.')
  }
  if (
    requirePrescriptionAttachment &&
    !hasPrescriptionAttachment(claimData, {
      allowPendingFile: !options.finalSubmission && options.allowPendingPrescriptionAttachment !== false,
    })
  ) {
    blockers.push('Attach the scanned prescription PDF or JPEG before saving/submitting this NHIS claim.')
  }

  if (!medicines?.length && (!isHospital || !tariffServices.length)) {
    blockers.push(isHospital ? 'Add at least one medicine or NHIA tariff service to the claim.' : 'Add at least one medicine to the claim.')
  } else {
    medicines.forEach((medicine, index) => {
      const label = `Medicine ${index + 1}`
      const quantity = asNumber(medicine?.dispensedQty ?? medicine?.dispensed_qty)
      const unitPrice = asNumber(medicine?.unitPrice ?? medicine?.unit_price)
        // ✅ NHIS PHARMACY LEVEL PATCH START
        const catalogMedicine =
          medicineCatalogById.get(asText(medicine?.nhisDrugId ?? medicine?.nhis_drug_id)) ||
          medicineCatalogByCode.get(asText(medicine?.drugCode ?? medicine?.drug_code ?? medicine?.nhisCode ?? medicine?.nhis_code).toUpperCase()) ||
          {}
        const pharmacyLevelCheck = assessMedicinePharmacyLevel(
          { ...catalogMedicine, ...medicine },
          facilityPharmacyLevel
        )
        if (!pharmacyLevelCheck.allowed) {
          blockers.push(`${label}: ${pharmacyLevelCheck.message}`)
        } else if (pharmacyLevelCheck.message === 'Level not configured') {
          warnings.push(`${label}: Level not configured.`)
        }
        // ✅ NHIS PHARMACY LEVEL PATCH END

      if (!asText(medicine?.nhisDrugId ?? medicine?.nhis_drug_id) || !asText(medicine?.drugCode ?? medicine?.drug_code)) {
        blockers.push(`${label}: select a medicine from the NHIS catalog.`)
      }
      if (!asText(medicine?.description)) blockers.push(`${label}: generic medicine name/description is required.`)
      if (!asText(medicine?.unit)) blockers.push(`${label}: unit of pricing is required.`)
      if (!(quantity > 0)) blockers.push(`${label}: exact dispensed quantity must be greater than zero.`)
      if (!(unitPrice >= 0)) blockers.push(`${label}: NHIS unit price is required.`)

      const addDirectionIssue = (message) => {
        if (requireMedicineDirections) {
          blockers.push(`${label}: ${message} is required.`)
        } else {
          warnings.push(`${label}: ${message} is missing; claims officer must complete it before corrections/export.`)
        }
      }

      if (!asText(medicine?.dose)) addDirectionIssue('dose')
      if (!asText(medicine?.frequency)) addDirectionIssue('dosage schedule/frequency')
      if (!asText(medicine?.duration)) addDirectionIssue('duration')
    })
  }

  if (isHospital && tariffServices.length) {
    tariffServices.forEach((service, index) => {
      const label = `Service ${index + 1}`
      const expectedTariff = getExpectedTariffForService(service, tariffCatalogLookup)
      const serviceAllowedProviderLevels = Array.isArray(service.allowedProviderClassLevels)
        ? service.allowedProviderClassLevels
        : parseHospitalProviderClassList(service.allowedProviderClassLevels ?? service.allowed_provider_class_levels)
      const serviceForProviderRules = expectedTariff
        ? {
            ...expectedTariff,
            ...service,
            providerClassLevel: service.providerClassLevel || service.provider_class_level || expectedTariff.providerClassLevel,
            minimumProviderClassLevel:
              service.minimumProviderClassLevel ||
              service.minimum_provider_class_level ||
              expectedTariff.minimumProviderClassLevel,
            allowedProviderClassLevels: serviceAllowedProviderLevels.length
              ? serviceAllowedProviderLevels
              : expectedTariff.allowedProviderClassLevels,
          }
        : service
      const ageBand = expectedTariff?.ageBand || service.ageBand
      const expectedUnitPrice = expectedTariff?.tariffAmount
      // ✅ NHIS CLAIM LOGIC SEPARATION PATCH START
      const tariffSetIssue = getHospitalTariffSetIssue(service, configuredTariffFacilityGroup, configuredTariffCateringOption, label)
      if (tariffSetIssue) blockers.push(tariffSetIssue)
      const serviceKind = getHospitalServiceKind(serviceForProviderRules)
      const providerClassIssue = getHospitalProviderClassIssue(serviceForProviderRules, hospitalProviderClassLevel, serviceKind, label)
      if (providerClassIssue) blockers.push(providerClassIssue)
      if (serviceKind === 'referral' && !getClaimField(claimData, 'referralCode', 'referral_code')) {
        warnings.push(`${label}: referral tariff selected; add the referral code/CCC before export.`)
      }
      if (serviceKind === 'zoom' && !asText(service.sourceFile ?? service.source_file)) {
        warnings.push(`${label}: ZOOM tariff selected; confirm source tariff/documentation before export.`)
      }
      if (['investigation', 'procedure'].includes(serviceKind) && !service.description) {
        blockers.push(`${label}: ${serviceKind} tariff description is required.`)
      }
      // ✅ NHIS CLAIM LOGIC SEPARATION PATCH END
      if (!service.nhiaTariffItemId) blockers.push(`${label}: select an item from the FEB 2023 NHIA tariff catalog.`)
      if (!service.gdrgCode) blockers.push(`${label}: G-DRG/tariff code is required.`)
      if (!service.description) blockers.push(`${label}: service description is required.`)
      if (!(service.quantity > 0)) blockers.push(`${label}: quantity must be greater than zero.`)
      if (!(service.unitPrice >= 0)) blockers.push(`${label}: official tariff amount is required.`)
      if (!(service.totalAmount >= 0)) blockers.push(`${label}: service line total is required.`)
      if (ageBand) {
        const ageIssue = getTariffAgeBandIssue(ageBand, patientAge, label)
        if (ageIssue) blockers.push(ageIssue)
      }
      if (expectedTariff) {
        const expectedTotal = Number(expectedUnitPrice || 0) * Number(service.quantity || 0)
        if (amountsDiffer(service.unitPrice, expectedUnitPrice)) {
          blockers.push(`${label}: tariff price is outdated. Current official amount is GHS ${Number(expectedUnitPrice || 0).toFixed(2)}.`)
        }
        if (amountsDiffer(service.totalAmount, expectedTotal)) {
          blockers.push(`${label}: service total is outdated. Current official total is GHS ${expectedTotal.toFixed(2)}.`)
        }
      }
      if (!service.serviceDate) warnings.push(`${label}: service date is missing; claim service date will be used for export.`)
    })
  }

  if (shouldCheckDiagnosisTreatmentMatch) {
    blockers.push(...getDiagnosisTreatmentMismatchBlockers(claimData, medicines, options.clinicalRules || DIAGNOSIS_TREATMENT_RULES, options))
  }

  if (shouldRunClinicalScrub) {
    const duplicateIssues = getDuplicateMedicineIssues(medicines, true)
    const ageIssues = getAgeClinicalIssues(patientAge, medicines, claimData)
    const drugDiagnosisIssues = getDrugDiagnosisIssues(claimData, medicines, true)
    const quantityCostIssues = getQuantityCostIssues(claimData, medicines, true)

    blockers.push(
      ...getGenderDiagnosisIssues(claimData),
      ...duplicateIssues.blockers,
      ...ageIssues.blockers,
      ...drugDiagnosisIssues.blockers,
      ...quantityCostIssues.blockers,
      ...getProcedureMismatchIssues(claimData, { ...options, claimServices: tariffServices }, true)
    )
    warnings.push(
      ...duplicateIssues.warnings,
      ...ageIssues.warnings,
      ...drugDiagnosisIssues.warnings,
      ...quantityCostIssues.warnings,
      ...getSupportingInvestigationIssues(claimData, { ...options, claimServices: tariffServices }, true),
      ...getChronicDiseaseWarnings(claimData, options, true)
    )
  }

  const risk = getClaimRisk(blockers, warnings)

  return {
    blockers,
    warnings,
    issues: [...blockers, ...warnings],
    riskScore: risk.score,
    riskLevel: risk.level,
  }
}

export const validateNhisClaimReadiness = (claimData, medicines = []) =>
  assessNhisClaimReadiness(claimData, medicines, { finalSubmission: true }).blockers

export const getAllNhisClinicalRules = async () => {
  if (shouldUseBranchServer()) {
    return DIAGNOSIS_TREATMENT_RULES.map((rule) => normalizeClinicalRule(rule))
  }

  const { data, error } = await supabase
    .from('nhis_clinical_rules')
    .select('*')
    .eq('is_active', true)
    .in('organization_type', ['hospital', 'all'])
    .order('diagnosis_label')

  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code)) {
      return DIAGNOSIS_TREATMENT_RULES.map((rule) => normalizeClinicalRule(rule))
    }
    throw error
  }

  const rules = normalizeClinicalRules(data || [])
  return rules.length ? rules : DIAGNOSIS_TREATMENT_RULES.map((rule) => normalizeClinicalRule(rule))
}

export const upsertNhisClinicalRules = async (rules, actorId = null) => {
  if (!rules?.length) throw new Error('No clinical rules to import.')
  if (shouldUseBranchServer()) {
    throw new Error('Clinical rule import requires Supabase access.')
  }

  const rows = normalizeClinicalRules(rules).map((rule) => ({
    diagnosis_label: rule.label,
    diagnosis_keywords: rule.diagnosis,
    allowed_drug_codes: rule.drugCodes,
    allowed_drug_keywords: rule.treatments,
    severity: rule.severity,
    organization_type: rule.organizationType,
    is_active: true,
    created_by: actorId,
  }))

  if (!rows.length) throw new Error('No valid clinical rules found to import.')

  const { error } = await supabase
    .from('nhis_clinical_rules')
    .upsert(rows, { onConflict: 'organization_id,diagnosis_label', ignoreDuplicates: false })

  if (error) throw error
  return rows.length
}

const getNhiaApiSettingsCacheKey = (organizationId = '') =>
  `${NHIA_API_SETTINGS_CACHE_PREFIX}:${normalizeText(organizationId) || 'current'}`

const canUseNhiaApiSettingsCache = () => {
  try {
    return typeof window !== 'undefined' && Boolean(window.localStorage)
  } catch {
    return false
  }
}

const pickCacheableNhiaApiSettings = (settings = {}, organizationId = '') => {
  const cacheable = {}
  for (const field of NHIA_API_SETTINGS_CACHE_FIELDS) {
    if (settings[field] !== undefined) {
      cacheable[field] = settings[field]
    }
  }

  const resolvedOrganizationId = normalizeText(
    organizationId || cacheable.organizationId || cacheable.organization_id
  )
  if (resolvedOrganizationId) {
    cacheable.organizationId = resolvedOrganizationId
    cacheable.organization_id = resolvedOrganizationId
  }

  const accreditationExpiryDate = getNhiaAccreditationExpiryDate(settings, cacheable)
  if (accreditationExpiryDate) {
    cacheable.accreditationExpiryDate = accreditationExpiryDate
  }

  return cacheable
}

const writeCachedNhiaApiSettings = (settings = {}, organizationId = '') => {
  if (!canUseNhiaApiSettingsCache()) return
  const cacheable = pickCacheableNhiaApiSettings(settings, organizationId)
  if (!Object.keys(cacheable).length) return

  try {
    window.localStorage.setItem(
      getNhiaApiSettingsCacheKey(cacheable.organizationId || organizationId),
      JSON.stringify({ settings: cacheable, cachedAt: new Date().toISOString() })
    )
  } catch {
    // Browser storage is only a convenience fallback.
  }
}

const readCachedNhiaApiSettings = (organizationId = '') => {
  if (!canUseNhiaApiSettingsCache()) return null

  const cacheKeys = [
    getNhiaApiSettingsCacheKey(organizationId),
    getNhiaApiSettingsCacheKey(),
  ].filter((key, index, keys) => key && keys.indexOf(key) === index)

  for (const cacheKey of cacheKeys) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(cacheKey) || 'null')
      if (parsed?.settings && typeof parsed.settings === 'object') return parsed.settings
    } catch {
      try {
        window.localStorage.removeItem(cacheKey)
      } catch {
        // Ignore storage cleanup failures.
      }
    }
  }

  return null
}

const getNhiaConfigMode = async () => {
  await refreshConnectivityState().catch(() => null)
  if (shouldUseBranchServer()) {
    const state = getConnectivityState()
    return state?.internetAvailable === false ? 'OFFLINE_LOCAL' : 'ONLINE_LOCAL_SYNC'
  }

  return 'ONLINE_CLOUD'
}

const readOfflineNhiaConfig = (organizationId = '') => readCachedNhiaApiSettings(organizationId)

const getCurrentUserBranchIdForNhiaConfig = async () => {
  try {
    const { data: authData } = await supabase.auth.getUser()
    const userId = authData?.user?.id
    if (!userId) return ''

    const { data, error } = await supabase
      .from('users')
      .select('branch_id')
      .eq('id', userId)
      .maybeSingle()

    if (error) return ''
    return normalizeText(data?.branch_id)
  } catch {
    return ''
  }
}

const readHostedNhiaConfigDirect = async (organizationId = '', preferredSettings = null) => {
  if (!supabase) return null

  try {
    let preferredConfigRow = null
    const preferredId = normalizeText(preferredSettings?.id)
    if (preferredId) {
      const { data, error } = await supabase
        .from(NHIA_CONFIG_TABLE)
        .select('*')
        .eq('id', preferredId)
        .maybeSingle()

      if (!error && data) preferredConfigRow = data
    }

    const branchId = normalizeText(
      preferredSettings?.branchId ||
        preferredSettings?.branch_id ||
        await getCurrentUserBranchIdForNhiaConfig()
    )

    let query = supabase
      .from(NHIA_CONFIG_TABLE)
      .select('*')
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1)

    if (organizationId) query = query.eq('organization_id', organizationId)
    query = branchId ? query.eq('branch_id', branchId) : query.is('branch_id', null)

    const { data, error } = await query.maybeSingle()
    const configRow = !error && data ? data : null

    let fallbackQuery = supabase
      .from(NHIA_CONFIG_TABLE)
      .select('*')
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1)

    if (organizationId) fallbackQuery = fallbackQuery.eq('organization_id', organizationId)

    const { data: fallbackData, error: fallbackError } = await fallbackQuery.maybeSingle()
    const fallbackConfigRow = !fallbackError && fallbackData ? fallbackData : null
    const legacyRow = await readLatestHostedNhiaIntegrationDirect(organizationId)
    return pickLatestNhiaConfigRow(preferredConfigRow, configRow, fallbackConfigRow, legacyRow)
  } catch {
    // Keep the function response/cache path as the graceful fallback.
  }

  return null
}

const getNhiaUpdatedAtTime = (settings = null) => {
  const value = settings?.updated_at || settings?.updatedAt || settings?.created_at || settings?.createdAt
  const time = value ? new Date(value).getTime() : 0
  return Number.isNaN(time) ? 0 : time
}

const pickLatestNhiaConfigRow = (...rows) =>
  rows
    .filter(Boolean)
    .sort((left, right) => getNhiaUpdatedAtTime(right) - getNhiaUpdatedAtTime(left))[0] || null

const normalizeHostedNhiaIntegrationRow = (row = null) => {
  if (!row) return null

  const credentialPayload = row.credential_payload && typeof row.credential_payload === 'object'
    ? row.credential_payload
    : {}
  const hasApiKey = Boolean(row.has_api_key || normalizeText(credentialPayload.apiKey))
  const hasApiSecret = Boolean(row.has_api_secret || normalizeText(credentialPayload.apiSecret))
  const hasPassword = Boolean(row.has_password || normalizeText(credentialPayload.password))

  return {
    ...row,
    organizationId: row.organization_id || '',
    branchId: row.branch_id || '',
    facilityCode: row.facility_code || '',
    providerNumber: row.provider_number || row.provider_id || '',
    providerId: row.provider_id || row.provider_number || '',
    credentialCode: row.credential_code || row.facility_code || '',
    accreditationExpiryDate: getNhiaAccreditationExpiryDate(row),
    claimsOfficerName: row.claims_officer_name || '',
    apiBaseUrl: row.api_base_url || '',
    claimEndpointPath: row.claim_endpoint_path || row.claim_submit_endpoint || '',
    claimSubmitEndpoint: row.claim_submit_endpoint || row.claim_endpoint_path || '',
    claimStatusEndpointPath: row.claim_status_endpoint_path || row.claim_status_endpoint || '',
    claimStatusEndpoint: row.claim_status_endpoint || row.claim_status_endpoint_path || '',
    memberLookupEndpointPath: row.member_lookup_endpoint_path || row.member_lookup_endpoint || '',
    memberLookupEndpoint: row.member_lookup_endpoint || row.member_lookup_endpoint_path || '',
    ccEndpointPath: row.cc_endpoint_path || row.cc_code_endpoint_path || '',
    ccCodeEndpointPath: row.cc_code_endpoint_path || row.cc_endpoint_path || '',
    integrationMode: row.integration_mode || 'claimit_export',
    credentialMode: row.credential_mode || 'api_key',
    credentials: credentialPayload,
    credentialSummary: {
      apiKey: hasApiKey,
      apiSecret: hasApiSecret,
      password: hasPassword,
      username: Boolean(row.username || credentialPayload.username),
    },
    hasApiKey,
    has_api_key: hasApiKey,
    hasApiSecret,
    has_api_secret: hasApiSecret,
    hasPassword,
    has_password: hasPassword,
    sourceTable: NHIA_LEGACY_INTEGRATIONS_TABLE,
  }
}

const readLatestHostedNhiaIntegrationDirect = async (organizationId = '') => {
  if (!supabase || !organizationId) return null

  try {
    const { data, error } = await supabase
      .from(NHIA_LEGACY_INTEGRATIONS_TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error || !data) return null
    return normalizeHostedNhiaIntegrationRow(data)
  } catch {
    return null
  }
}

const getHostedNhiaConfigRowPayload = async (settings = {}, organizationId = '', preferredSettings = null) => {
  const resolvedOrganizationId = normalizeText(
    organizationId || settings.organizationId || settings.organization_id || preferredSettings?.organizationId || preferredSettings?.organization_id
  )
  if (!resolvedOrganizationId) {
    throw new Error('Organization is required to save NHIA configuration.')
  }

  const branchId = normalizeText(
    settings.branchId ||
      settings.branch_id ||
      preferredSettings?.branchId ||
      preferredSettings?.branch_id ||
      await getCurrentUserBranchIdForNhiaConfig()
  )
  const activeBaseUrl = normalizeText(
    settings.apiBaseUrl ||
      settings.api_base_url ||
      (normalizeText(settings.apiEnvironment || settings.api_environment).toLowerCase() === 'sandbox'
        ? settings.sandboxBaseUrl || settings.sandbox_base_url
        : settings.productionBaseUrl || settings.production_base_url)
  ).replace(/\/+$/, '')
  const facilityCode = normalizeText(settings.facilityCode || settings.facility_code)
  const providerNumber = normalizeText(settings.providerNumber || settings.provider_number || settings.providerId || settings.provider_id)
  const credentialCode = normalizeText(settings.credentialCode || settings.credential_code || facilityCode)
  const claimEndpointPath = normalizeText(settings.claimEndpointPath || settings.claim_endpoint_path || settings.claimSubmitEndpoint || settings.claim_submit_endpoint)
  const claimStatusEndpointPath = normalizeText(settings.claimStatusEndpointPath || settings.claim_status_endpoint_path || settings.claimStatusEndpoint || settings.claim_status_endpoint)
  const memberLookupEndpointPath = normalizeText(settings.memberLookupEndpointPath || settings.member_lookup_endpoint_path || settings.memberLookupEndpoint || settings.member_lookup_endpoint)
  const ccEndpointPath = normalizeText(settings.ccEndpointPath || settings.cc_endpoint_path || settings.ccCodeEndpointPath || settings.cc_code_endpoint_path)
  const ccCodeEndpointPath = normalizeText(settings.ccCodeEndpointPath || settings.cc_code_endpoint_path || settings.ccEndpointPath || settings.cc_endpoint_path)

  return {
    organization_id: resolvedOrganizationId,
    branch_id: branchId || null,
    mode: 'ONLINE_CLOUD',
    provider_id: providerNumber || null,
    facility_code: facilityCode || null,
    provider_number: providerNumber || null,
    scheme_name: normalizeText(settings.schemeName || settings.scheme_name) || 'National Health Insurance',
    facility_type: normalizeText(settings.facilityType || settings.facility_type) || null,
    pharmacy_facility_level: normalizeText(settings.pharmacyFacilityLevel || settings.pharmacy_facility_level) || null,
    provider_level_code: normalizeText(settings.providerLevelCode || settings.provider_level_code) || null,
    credential_code: credentialCode || null,
    license_number: normalizeText(settings.licenseNumber || settings.license_number) || null,
    accreditation_expiry_date: getNhiaAccreditationExpiryDate(settings) || null,
    integration_mode: normalizeText(settings.integrationMode || settings.integration_mode || settings.nhiaApiMode || settings.nhia_api_mode) || 'claimit_export',
    connection_profile: normalizeText(settings.connectionProfile || settings.connection_profile) || 'local_server',
    validation_mode: normalizeText(settings.validationMode || settings.validation_mode) || 'validate_before_submit',
    claim_control_mode: normalizeText(settings.claimControlMode || settings.claim_control_mode) || 'manual',
    sandbox_base_url: normalizeText(settings.sandboxBaseUrl || settings.sandbox_base_url).replace(/\/+$/, '') || null,
    production_base_url: normalizeText(settings.productionBaseUrl || settings.production_base_url).replace(/\/+$/, '') || null,
    provider_type_description: normalizeText(settings.providerTypeDescription || settings.provider_type_description) || null,
    provider_class_level: normalizeText(settings.providerClassLevel || settings.provider_class_level) || null,
    claims_officer_name: normalizeText(settings.claimsOfficerName || settings.claims_officer_name) || null,
    admission_payment_option: normalizeText(settings.admissionPaymentOption || settings.admission_payment_option) || 'nhis_pays_admission',
    claimit_validation_enabled: settings.claimitValidationEnabled !== false && settings.claimit_validation_enabled !== false,
    claims_officer_signature_url: normalizeText(settings.claimsOfficerSignatureUrl || settings.claims_officer_signature_url) || null,
    submitter_id: normalizeText(settings.submitterId || settings.submitter_id) || null,
    api_environment: normalizeText(settings.apiEnvironment || settings.api_environment).toLowerCase() === 'sandbox' ? 'sandbox' : 'production',
    api_base_url: activeBaseUrl || null,
    claim_endpoint_path: claimEndpointPath || null,
    claim_submit_endpoint: claimEndpointPath || null,
    claim_validation_endpoint_path: normalizeText(settings.claimValidationEndpointPath || settings.claim_validation_endpoint_path) || null,
    cc_endpoint_path: ccEndpointPath || null,
    cc_code_endpoint_path: ccCodeEndpointPath || null,
    claim_status_endpoint_path: claimStatusEndpointPath || null,
    claim_status_endpoint: claimStatusEndpointPath || null,
    member_lookup_endpoint_path: memberLookupEndpointPath || null,
    member_lookup_endpoint: memberLookupEndpointPath || null,
    direct_api_enabled: Boolean(settings.directApiEnabled || settings.direct_api_enabled),
    credential_mode: normalizeText(settings.credentialMode || settings.credential_mode) || 'api_key',
    nhis_member_digits: Number(settings.nhisMemberDigits || settings.nhis_member_digits || 8),
    ghana_card_digits: Number(settings.ghanaCardDigits || settings.ghana_card_digits || 10),
    export_format: normalizeText(settings.exportFormat || settings.export_format) || 'json',
    max_retry_attempts: Math.min(Math.max(Number(settings.maxRetryAttempts || settings.max_retry_attempts || 3), 1), 10),
    is_active: true,
    updated_at: new Date().toISOString(),
  }
}

const saveHostedNhiaConfigDirect = async (settings = {}, organizationId = '', preferredSettings = null) => {
  if (!supabase) {
    throw new Error('Supabase is not configured for direct NHIA configuration save.')
  }

  const row = await getHostedNhiaConfigRowPayload(settings, organizationId, preferredSettings)
  const { data, error } = await supabase
    .from(NHIA_CONFIG_TABLE)
    .upsert(row, { onConflict: 'organization_id,branch_id' })
    .select('*')
    .maybeSingle()

  if (error) {
    throw error
  }

  return data || row
}

const removeHostedNhiaCredentialsDirect = async (organizationId = '', preferredSettings = null) => {
  if (!supabase) {
    throw new Error('Supabase is not configured for direct NHIA credential removal.')
  }

  const resolvedOrganizationId = normalizeText(
    organizationId || preferredSettings?.organizationId || preferredSettings?.organization_id
  )
  if (!resolvedOrganizationId) {
    throw new Error('Organization is required to remove NHIA API credentials.')
  }

  const branchId = normalizeText(
    preferredSettings?.branchId ||
      preferredSettings?.branch_id ||
      await getCurrentUserBranchIdForNhiaConfig()
  )

  let query = supabase
    .from(NHIA_CONFIG_TABLE)
    .update({
      api_key_encrypted: null,
      api_secret_encrypted: null,
      has_api_key: false,
      has_api_secret: false,
      updated_at: new Date().toISOString(),
    })
    .eq('organization_id', resolvedOrganizationId)

  query = branchId ? query.eq('branch_id', branchId) : query.is('branch_id', null)

  const { data, error } = await query
    .select('*')
    .maybeSingle()

  if (error) {
    throw error
  }

  return data || await readHostedNhiaConfigDirect(resolvedOrganizationId, preferredSettings)
}

const normalizeNhiaConfig = (settings = null, {
  mode = '',
  source = 'default',
  organizationId = '',
  branchId = '',
} = {}) => {
  const raw = settings && typeof settings === 'object' ? settings : {}
  const credentials = raw.credentials && typeof raw.credentials === 'object' ? raw.credentials : {}
  const providerId = normalizeText(raw.providerId || raw.provider_id || raw.providerNumber || raw.provider_number)
  const claimSubmitEndpoint = normalizeText(
    raw.claimSubmitEndpoint || raw.claim_submit_endpoint || raw.claimEndpointPath || raw.claim_endpoint_path
  )
  const claimStatusEndpoint = normalizeText(
    raw.claimStatusEndpoint || raw.claim_status_endpoint || raw.claimStatusEndpointPath || raw.claim_status_endpoint_path
  )
  const memberLookupEndpoint = normalizeText(
    raw.memberLookupEndpoint || raw.member_lookup_endpoint || raw.memberLookupEndpointPath || raw.member_lookup_endpoint_path
  )
  const ccEndpointPath = normalizeText(raw.ccEndpointPath || raw.cc_endpoint_path || raw.ccCodeEndpointPath || raw.cc_code_endpoint_path)
  const facilityCode = normalizeText(raw.facilityCode || raw.facility_code)
  const credentialCode = normalizeText(raw.credentialCode || raw.credential_code || facilityCode)
  const schemeName = normalizeText(raw.schemeName || raw.scheme_name) || 'National Health Insurance'
  const facilityType = normalizeText(raw.facilityType || raw.facility_type)
  const pharmacyFacilityLevel = normalizeText(raw.pharmacyFacilityLevel || raw.pharmacy_facility_level)
  const providerLevelCode = normalizeText(raw.providerLevelCode || raw.provider_level_code)
  const licenseNumber = normalizeText(raw.licenseNumber || raw.license_number)
  const providerTypeDescription = normalizeText(raw.providerTypeDescription || raw.provider_type_description)
  const providerClassLevel = normalizeText(raw.providerClassLevel || raw.provider_class_level)
  const hasApiKey = hasNhiaSavedCredential(raw, 'hasApiKey', 'has_api_key') || Boolean(normalizeText(credentials.apiKey))
  const hasApiSecret = hasNhiaSavedCredential(raw, 'hasApiSecret', 'has_api_secret') || Boolean(normalizeText(credentials.apiSecret))
  const username = normalizeText(raw.username || credentials.username)
  const hasPassword = Boolean(raw.hasPassword || raw.has_password || normalizeText(credentials.password))
  const resolvedMode = mode || normalizeText(raw.mode) || 'ONLINE_CLOUD'
  const normalized = {
    ...NHIA_CONFIG_DEFAULTS,
    ...raw,
    id: normalizeText(raw.id),
    organizationId: normalizeText(raw.organizationId || raw.organization_id || organizationId),
    organization_id: normalizeText(raw.organization_id || raw.organizationId || organizationId),
    branchId: normalizeText(raw.branchId || raw.branch_id || branchId),
    branch_id: normalizeText(raw.branch_id || raw.branchId || branchId),
    mode: resolvedMode,
    source,
    configSource: source,
    providerId,
    provider_id: providerId,
    providerNumber: providerId,
    provider_number: providerId,
    facilityCode,
    facility_code: facilityCode,
    schemeName,
    scheme_name: schemeName,
    facilityType,
    facility_type: facilityType,
    pharmacyFacilityLevel,
    pharmacy_facility_level: pharmacyFacilityLevel,
    providerLevelCode,
    provider_level_code: providerLevelCode,
    credentialCode,
    credential_code: credentialCode,
    licenseNumber,
    license_number: licenseNumber,
    accreditationExpiryDate: getNhiaAccreditationExpiryDate(raw),
    accreditation_expiry_date: getNhiaAccreditationExpiryDate(raw),
    claimsOfficerName: normalizeText(raw.claimsOfficerName || raw.claims_officer_name),
    claims_officer_name: normalizeText(raw.claims_officer_name || raw.claimsOfficerName),
    providerTypeDescription,
    provider_type_description: providerTypeDescription,
    providerClassLevel,
    provider_class_level: providerClassLevel,
    apiBaseUrl: normalizeText(raw.apiBaseUrl || raw.api_base_url),
    api_base_url: normalizeText(raw.api_base_url || raw.apiBaseUrl),
    submitterId: normalizeText(raw.submitterId || raw.submitter_id),
    submitter_id: normalizeText(raw.submitter_id || raw.submitterId),
    apiKeyEncrypted: '',
    api_key_encrypted: '',
    apiSecretEncrypted: '',
    api_secret_encrypted: '',
    hasApiKey,
    has_api_key: hasApiKey,
    hasApiSecret,
    has_api_secret: hasApiSecret,
    username,
    passwordEncrypted: '',
    password_encrypted: '',
    hasPassword,
    has_password: hasPassword,
    claimEndpointPath: claimSubmitEndpoint,
    claim_endpoint_path: claimSubmitEndpoint,
    claimSubmitEndpoint,
    claim_submit_endpoint: claimSubmitEndpoint,
    claimStatusEndpointPath: claimStatusEndpoint,
    claim_status_endpoint_path: claimStatusEndpoint,
    claimStatusEndpoint,
    claim_status_endpoint: claimStatusEndpoint,
    memberLookupEndpointPath: memberLookupEndpoint,
    member_lookup_endpoint_path: memberLookupEndpoint,
    memberLookupEndpoint,
    member_lookup_endpoint: memberLookupEndpoint,
    ccEndpointPath,
    cc_endpoint_path: ccEndpointPath,
    ccCodeEndpointPath: normalizeText(raw.ccCodeEndpointPath || raw.cc_code_endpoint_path || ccEndpointPath),
    cc_code_endpoint_path: normalizeText(raw.cc_code_endpoint_path || raw.ccCodeEndpointPath || ccEndpointPath),
    validationMode: normalizeText(raw.validationMode || raw.validation_mode) || NHIA_CONFIG_DEFAULTS.validationMode,
    validation_mode: normalizeText(raw.validation_mode || raw.validationMode) || NHIA_CONFIG_DEFAULTS.validationMode,
    integrationMode: normalizeText(raw.integrationMode || raw.integration_mode || raw.nhiaApiMode || raw.nhia_api_mode) || 'claimit_export',
    integration_mode: normalizeText(raw.integration_mode || raw.integrationMode || raw.nhiaApiMode || raw.nhia_api_mode) || 'claimit_export',
    claimControlMode: normalizeText(raw.claimControlMode || raw.claim_control_mode) || 'manual',
    claim_control_mode: normalizeText(raw.claim_control_mode || raw.claimControlMode) || 'manual',
    updatedAt: normalizeText(raw.updatedAt || raw.updated_at),
    updated_at: normalizeText(raw.updated_at || raw.updatedAt),
    updatedBy: normalizeText(raw.updatedBy || raw.updated_by),
    updated_by: normalizeText(raw.updated_by || raw.updatedBy),
    credentials: {},
    credentialSummary: {
      ...(raw.credentialSummary || {}),
      apiKey: hasApiKey,
      apiSecret: hasApiSecret,
      password: hasPassword,
      username: Boolean(username || raw.credentialSummary?.username),
    },
  }

  return normalized
}

const logNhiaConfigEvent = (event, details = {}) => {
  const payload = {
    mode: details.mode || '',
    saveTarget: details.saveTarget || details.target || '',
    endpoint: details.endpoint || '',
    saveSuccess: details.saveSuccess ?? null,
    saveFailed: details.saveFailed ?? null,
    configSource: details.configSource || details.source || '',
    hasApiKey: Boolean(details.hasApiKey),
    hasApiSecret: Boolean(details.hasApiSecret),
  }
  console.info(`[NHIA CONFIG] ${event}`, payload)
}

const buildNhiaCredentialsPayload = (credentials = {}) => {
  const payload = {}

  for (const [field, value] of Object.entries(credentials || {})) {
    if (NHIA_SECRET_FIELDS.has(field) && !normalizeText(value)) continue
    if (value !== undefined && value !== null && value !== '') payload[field] = value
  }

  return payload
}

const sanitizeNhiaApiSettingsPayload = (settings = {}) => {
  const sanitized = { ...(settings || {}) }
  const credentials = buildNhiaCredentialsPayload(sanitized.credentials)
  if (Object.keys(credentials).length) {
    sanitized.credentials = credentials
  } else {
    delete sanitized.credentials
  }
  return sanitized
}

const hasUsableNhiaSecret = (value) => {
  const normalized = normalizeText(value)
  return Boolean(normalized)
}

export const validateNhiaConfigForMode = (settings = {}) => {
  const credentials = settings.credentials && typeof settings.credentials === 'object' ? settings.credentials : {}
  const integrationMode = normalizeText(settings.integrationMode || settings.integration_mode || settings.nhiaApiMode || settings.nhia_api_mode) || 'claimit_export'
  const hasApiKey = Boolean(settings.hasApiKey || settings.has_api_key || settings.credentialSummary?.apiKey || hasUsableNhiaSecret(credentials.apiKey))
  const hasApiSecret = Boolean(settings.hasApiSecret || settings.has_api_secret || settings.credentialSummary?.apiSecret || hasUsableNhiaSecret(credentials.apiSecret))
  const hasUsername = Boolean(normalizeText(settings.username || credentials.username))
  const hasPassword = Boolean(settings.hasPassword || settings.has_password || settings.credentialSummary?.password || hasUsableNhiaSecret(credentials.password))
  const providerId = normalizeText(settings.providerId || settings.provider_id || settings.providerNumber || settings.provider_number)
  const claimSubmitEndpoint = normalizeText(settings.claimSubmitEndpoint || settings.claim_submit_endpoint || settings.claimEndpointPath || settings.claim_endpoint_path)
  const claimStatusEndpoint = normalizeText(settings.claimStatusEndpoint || settings.claim_status_endpoint || settings.claimStatusEndpointPath || settings.claim_status_endpoint_path)
  const memberLookupEndpoint = normalizeText(settings.memberLookupEndpoint || settings.member_lookup_endpoint || settings.memberLookupEndpointPath || settings.member_lookup_endpoint_path)
  const apiBaseUrl = normalizeText(settings.apiBaseUrl || settings.api_base_url || settings.productionBaseUrl || settings.production_base_url || settings.sandboxBaseUrl || settings.sandbox_base_url)
  const missing = [
    !providerId && 'providerId',
    !normalizeText(settings.credentialCode || settings.credential_code) && 'credentialCode',
    !getNhiaAccreditationExpiryDate(settings) && 'accreditationExpiryDate',
    !normalizeText(settings.claimsOfficerName || settings.claims_officer_name) && 'claimsOfficerName',
  ].filter(Boolean)

  if (isClaimItBridgeMode(integrationMode)) {
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

  return {
    valid: missing.length === 0,
    missing,
    integrationMode,
  }
}

const getNhiaCredentialKeys = (settings = {}) =>
  Object.keys(settings.credentials && typeof settings.credentials === 'object' ? settings.credentials : {}).sort()

const getNhiaPayloadKeys = (settings = {}) =>
  Object.keys(settings || {})
    .filter((key) => key !== 'credentials')
    .sort()

const hasOwnNhiaCredentialValue = (settings = {}, camelKey, snakeKey) =>
  Object.prototype.hasOwnProperty.call(settings || {}, camelKey) ||
  Object.prototype.hasOwnProperty.call(settings || {}, snakeKey)

const hasNhiaSavedCredential = (settings = {}, camelKey, snakeKey) => {
  const encryptedCamelKey = camelKey === 'hasApiKey' ? 'apiKeyEncrypted' : 'apiSecretEncrypted'
  const encryptedSnakeKey = camelKey === 'hasApiKey' ? 'api_key_encrypted' : 'api_secret_encrypted'
  const hasEncryptedValue = Boolean(normalizeText(settings?.[encryptedCamelKey] || settings?.[encryptedSnakeKey]))

  if (hasOwnNhiaCredentialValue(settings, camelKey, snakeKey)) {
    return Boolean(settings?.[camelKey] || settings?.[snakeKey])
  }

  if (settings?.credentialSummary) {
    return Boolean(
      settings.credentialSummary?.[camelKey.replace(/^has/, '').replace(/^Api/, 'api')] ||
        settings.credentialSummary?.[camelKey === 'hasApiKey' ? 'apiKey' : 'apiSecret']
    )
  }

  return hasEncryptedValue
}

const summarizeNhiaApiSettingsForLog = (settings = null) => ({
  table: NHIA_API_CONFIG_TABLE,
  hasSettings: Boolean(settings),
  keys: getNhiaPayloadKeys(settings || {}),
  credentialKeys: getNhiaCredentialKeys(settings || {}),
  hasApiKey: hasNhiaSavedCredential(settings || {}, 'hasApiKey', 'has_api_key'),
  hasApiSecret: hasNhiaSavedCredential(settings || {}, 'hasApiSecret', 'has_api_secret'),
})

const summarizeNhiaApiErrorForLog = (error) => ({
  table: NHIA_API_CONFIG_TABLE,
  message: error?.message || String(error || 'Unknown Supabase error'),
  code: error?.code || error?.status || error?.statusCode || '',
  details: error?.details || '',
})

const canUseClaimItBridgeQueue = () =>
  typeof window !== 'undefined' && Boolean(window.localStorage)

const readClaimItBridgeQueue = () => {
  if (!canUseClaimItBridgeQueue()) return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CLAIMIT_BRIDGE_QUEUE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeClaimItBridgeQueue = (queue = []) => {
  if (!canUseClaimItBridgeQueue()) return
  window.localStorage.setItem(CLAIMIT_BRIDGE_QUEUE_KEY, JSON.stringify(queue))
}

const isClaimItBridgeMode = (mode = '') => CLAIMIT_BRIDGE_MODES.has(normalizeText(mode))

const isLocalClaimItBridgeProfile = (profile = '') =>
  ['local_server', 'lan_ip'].includes(normalizeText(profile) || 'local_server')

const isLocalClaimItBridgeUrl = (baseUrl = '') => {
  try {
    const hostname = new URL(normalizeText(baseUrl)).hostname.toLowerCase()
    return hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  } catch {
    return false
  }
}

const joinClaimItBridgeUrl = (baseUrl = '', path = '') =>
  `${normalizeText(baseUrl).replace(/\/+$/, '')}/${normalizeText(path).replace(/^\/+/, '')}`

const getClaimControlEndpointPath = (settings = {}) =>
  normalizeText(
    settings.ccEndpointPath ||
      settings.cc_endpoint_path ||
      settings.ccCodeEndpointPath ||
      settings.cc_code_endpoint_path ||
      settings.claimEndpointPath ||
      settings.claim_endpoint_path
  )

const buildClaimItBridgeHeaders = (settings = {}) => {
  const credentials = settings.credentials && typeof settings.credentials === 'object' ? settings.credentials : {}
  const credentialMode = normalizeText(settings.credentialMode || settings.credential_mode || 'api_key')
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  const apiKey = normalizeText(credentials.apiKey || credentials.token)
  const apiSecret = normalizeText(credentials.apiSecret)
  const username = normalizeText(credentials.username)
  const password = normalizeText(credentials.password)

  if (credentialMode === 'api_key' && apiKey) {
    const configuredHeaderName = normalizeText(credentials.headerName)
    const headerName = configuredHeaderName || 'Authorization'
    const headerPrefix = normalizeText(credentials.headerPrefix) ||
      (!configuredHeaderName && headerName.toLowerCase() === 'authorization' ? 'Bearer' : '')
    headers[headerName] = headerPrefix ? `${headerPrefix} ${apiKey}` : apiKey
  }
  if (credentialMode === 'api_key' && apiSecret) {
    headers[normalizeText(credentials.secretHeaderName) || 'x-api-secret'] = apiSecret
  }
  if (credentialMode === 'basic_auth' && (username || password)) {
    headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`
  }
  if (credentialMode === 'bearer_token' && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  return headers
}

const extractClaimControlCode = (body) => {
  if (!body || typeof body !== 'object') return ''
  const record = body
  const direct = normalizeNhisCcCode(
    record.ccCode ||
      record.cc_code ||
      record.cccNo ||
      record.ccc_no ||
      record.claimControlCode ||
      record.claim_control_code ||
      record.controlCode ||
      record.control_code ||
      record.code
  )
  if (direct) return direct
  return record.data && typeof record.data === 'object' ? extractClaimControlCode(record.data) : ''
}

const logClaimItBridgeStatus = (action, detail = {}) => {
  console.info(`[CLAIM-it Bridge] ${action}`, {
    status: detail.status || '',
    httpStatus: detail.httpStatus || null,
    endpointPath: detail.endpointPath || '',
    claimCount: detail.claimCount || null,
    message: detail.message || '',
  })
}

const isClaimItBridgeUnavailableError = (error) => {
  const message = normalizeText(error?.message || error).toLowerCase()
  return [
    'failed to fetch',
    'network',
    'unavailable',
    'refused',
    'timed out',
    'timeout',
    'unreachable',
    'connection',
    'connect',
    'dns',
    'error sending request',
    'http 502',
    'http 503',
    'http 504',
    'http 521',
    'http 522',
    'http 523',
    'http 524',
  ].some((term) => message.includes(term))
}

const enqueueClaimItBridgeSubmission = ({ claims = [], directPayload = {}, request = {}, error = null } = {}) => {
  const queue = readClaimItBridgeQueue()
  const item = {
    id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `claimit-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    claims: claims.map((claim) => ({
      id: claim.id,
      status: claim.status,
      claim_number: claim.claim_number,
    })).filter((claim) => claim.id),
    request,
    directPayload,
    attempts: 0,
    lastError: normalizeText(error?.message || error),
    queuedAt: new Date().toISOString(),
    nextRetryAt: new Date(Date.now() + CLAIMIT_BRIDGE_RETRY_INTERVAL_MS).toISOString(),
  }
  writeClaimItBridgeQueue([...queue, item])
  return item
}

export const getClaimItBridgeQueueSummary = () => {
  const queue = readClaimItBridgeQueue()
  return {
    pending: queue.length,
    nextRetryAt: queue[0]?.nextRetryAt || null,
  }
}

export const flushClaimItBridgeQueue = async () => {
  const queue = readClaimItBridgeQueue()
  if (!queue.length) return { checked: 0, submitted: 0, failed: 0 }

  const now = Date.now()
  const remaining = []
  let submitted = 0
  let failed = 0

  for (const item of queue) {
    if (item.nextRetryAt && Date.parse(item.nextRetryAt) > now) {
      remaining.push(item)
      continue
    }

    try {
      if (item.request?.localBridge) {
        await submitBrowserClaimItBridgePayload(item.request)
      } else {
        await submitHostedNhiaDirectPayload(item.request)
      }
      await markNhisClaimsSubmittedByRoute(item.claims || [])
      submitted += item.claims?.length || 0
    } catch (error) {
      failed += 1
      remaining.push({
        ...item,
        attempts: (item.attempts || 0) + 1,
        lastError: normalizeText(error?.message || error),
        nextRetryAt: new Date(now + CLAIMIT_BRIDGE_RETRY_INTERVAL_MS * Math.min((item.attempts || 0) + 1, 10)).toISOString(),
      })
    }
  }

  writeClaimItBridgeQueue(remaining)
  return { checked: queue.length, submitted, failed }
}

let claimItBridgeQueueTimer = null

export const startClaimItBridgeQueueAutoSync = ({ onSynced } = {}) => {
  if (typeof window === 'undefined') return () => {}
  const run = async () => {
    const result = await flushClaimItBridgeQueue().catch(() => null)
    if (result?.submitted > 0) onSynced?.(result)
  }
  window.addEventListener('online', run)
  if (!claimItBridgeQueueTimer) {
    claimItBridgeQueueTimer = window.setInterval(run, CLAIMIT_BRIDGE_RETRY_INTERVAL_MS)
  }
  void run()
  return () => {
    window.removeEventListener('online', run)
  }
}

export const testClaimItConnection = async (settings = {}) => {
  return await invokeTierAccess({
    action: 'test_claimit_connection',
    settings: sanitizeNhiaApiSettingsPayload(settings),
  })
}

export const generateBrowserClaimItBridgeCcCode = async (settings = {}, claimContext = {}) => {
  const endpointPath = getClaimControlEndpointPath(settings)
  const baseUrl = normalizeText(settings.apiBaseUrl || settings.api_base_url)
  if (!baseUrl || !endpointPath) {
    return { source: 'pending', status: 'pending', message: PENDING_CLAIMIT_CC_MESSAGE }
  }

  const requestPayload = {
    action: 'generate_or_validate_cc_code',
    claimControlMode: normalizeText(settings.claimControlMode || settings.claim_control_mode) || 'claimit_bridge',
    batch: {
      batchNumber: normalizeText(claimContext.batchNumber),
      organizationType: normalizeOrganizationType(claimContext.organizationType || claimContext.organization_type),
      facilityCode: normalizeText(settings.facilityCode || settings.facility_code),
      providerNumber: normalizeText(settings.providerNumber || settings.provider_number),
      claimCount: 1,
    },
    claims: [{
      patientName: normalizeText(claimContext.patientName),
      memberNumber: normalizeText(claimContext.memberNumber || claimContext.memberNo),
      hin: normalizeText(claimContext.hin),
      diagnosis: normalizeText(claimContext.diagnosis),
      serviceDate: normalizeText(claimContext.serviceDate),
      totalAmount: Number(claimContext.totalAmount || 0),
    }],
    requestedAt: new Date().toISOString(),
  }

  logClaimItBridgeStatus('cc_code.request', { status: 'pending', endpointPath, claimCount: 1 })
  const response = await fetch(joinClaimItBridgeUrl(baseUrl, endpointPath), {
    method: 'POST',
    headers: buildClaimItBridgeHeaders(settings),
    body: JSON.stringify(requestPayload),
  })
  const responseText = await response.text()
  let body = {}
  try {
    body = responseText ? JSON.parse(responseText) : {}
  } catch {
    body = { raw: responseText }
  }
  logClaimItBridgeStatus('cc_code.response', {
    status: response.ok ? 'success' : 'failed',
    httpStatus: response.status,
    endpointPath,
    claimCount: 1,
  })
  if (!response.ok) throw new Error(`CLAIM-it bridge returned HTTP ${response.status}.`)

  const ccCode = extractClaimControlCode(body)
  if (!ccCode) return { source: 'pending', status: 'pending', message: PENDING_CLAIMIT_CC_MESSAGE, response: body }
  if (ccCode.length !== NHIS_CC_CODE_DIGITS) {
    throw new Error(`CLAIM-it returned a CCC/CC code that is not exactly ${NHIS_CC_CODE_DIGITS} digits.`)
  }
  return { ccCode, source: 'claimit_bridge', response: body }
}

export const getNhiaApiSettings = async (options = {}) => {
  const organizationId = normalizeText(options.organizationId || options.organization_id)
  const mode = await getNhiaConfigMode()

  if (mode === 'ONLINE_LOCAL_SYNC' || mode === 'OFFLINE_LOCAL') {
    try {
      const localSettings = await getBranchNhiaSettings()
      const nhiaConfig = normalizeNhiaConfig(localSettings, {
        mode,
        source: 'local_branch_server',
        organizationId,
      })
      writeCachedNhiaApiSettings(nhiaConfig, organizationId)
      logNhiaConfigEvent('load', {
        mode,
        configSource: 'local_branch_server',
        endpoint: '/api/nhia-config',
        hasApiKey: nhiaConfig.hasApiKey,
        hasApiSecret: nhiaConfig.hasApiSecret,
      })
      return nhiaConfig
    } catch (error) {
      const cachedSettings = readOfflineNhiaConfig(organizationId)
      if (mode === 'OFFLINE_LOCAL' && cachedSettings) {
        const nhiaConfig = normalizeNhiaConfig(cachedSettings, {
          mode,
          source: 'local_cache',
          organizationId,
        })
        logNhiaConfigEvent('load', {
          mode,
          configSource: 'local_cache',
          endpoint: 'localStorage',
          hasApiKey: nhiaConfig.hasApiKey,
          hasApiSecret: nhiaConfig.hasApiSecret,
        })
        return nhiaConfig
      }
      throw error
    }
  }

  let hostedError = null
  let hostedSettings = null
  try {
    const response = await invokeTierAccess({ action: 'get_nhia_api_settings' })
    hostedSettings = response?.settings || null
  } catch (error) {
    hostedError = error
  }

  const directHostedSettings = await readHostedNhiaConfigDirect(organizationId, hostedSettings)
  const cachedSettings = readCachedNhiaApiSettings(organizationId)
  const selectedSettings = directHostedSettings
    ? { ...(hostedSettings || {}), ...directHostedSettings }
    : hostedSettings || cachedSettings
  if (selectedSettings) {
    const nhiaConfig = normalizeNhiaConfig(selectedSettings, {
      mode,
      source: directHostedSettings || hostedSettings ? 'cloud_supabase' : 'local_cache',
      organizationId,
    })
    writeCachedNhiaApiSettings(nhiaConfig, organizationId)
    logNhiaAccreditationExpiryDate('loaded', nhiaConfig.accreditationExpiryDate)
    logNhiaConfigEvent('load', {
      mode,
      configSource: nhiaConfig.configSource,
      endpoint: 'tier-access:get_nhia_api_settings',
      hasApiKey: nhiaConfig.hasApiKey,
      hasApiSecret: nhiaConfig.hasApiSecret,
    })
    return nhiaConfig
  }

  if (hostedError) throw hostedError
  return normalizeNhiaConfig(null, { mode, source: 'default_app_config', organizationId })
}

export const saveNhiaApiSettings = async (settings, options = {}) => {
  const organizationId = normalizeText(
    options.organizationId || options.organization_id || settings?.organizationId || settings?.organization_id
  )
  const mode = await getNhiaConfigMode()
  const sanitizedSettings = sanitizeNhiaApiSettingsPayload(settings)
  sanitizedSettings.mode = mode
  const validation = validateNhiaConfigForMode(sanitizedSettings)
  if (!validation.valid) {
    logNhiaConfigEvent('save failed', {
      mode,
      saveTarget: mode === 'ONLINE_LOCAL_SYNC' || mode === 'OFFLINE_LOCAL' ? 'local_branch_server' : 'cloud_supabase',
      endpoint: 'validation',
      saveFailed: true,
      hasApiKey: Boolean(sanitizedSettings.hasApiKey || sanitizedSettings.credentials?.apiKey),
      hasApiSecret: Boolean(sanitizedSettings.hasApiSecret || sanitizedSettings.credentials?.apiSecret),
    })
    throw new Error(`NHIA configuration is incomplete for ${validation.integrationMode}: ${validation.missing.join(', ')}.`)
  }
  const saveTarget = mode === 'ONLINE_LOCAL_SYNC' || mode === 'OFFLINE_LOCAL' ? 'local_branch_server' : 'cloud_supabase'
  logNhiaConfigEvent('save started', {
    mode,
    saveTarget,
    endpoint: saveTarget === 'local_branch_server' ? '/api/nhia-config' : 'tier-access:save_nhia_api_settings',
    hasApiKey: Boolean(sanitizedSettings.hasApiKey || sanitizedSettings.credentials?.apiKey),
    hasApiSecret: Boolean(sanitizedSettings.hasApiSecret || sanitizedSettings.credentials?.apiSecret),
  })
  console.info('[NHIA CONFIG] payload keys only', {
    table: saveTarget === 'local_branch_server' ? NHIA_CONFIG_TABLE : NHIA_CONFIG_TABLE,
    keys: getNhiaPayloadKeys(sanitizedSettings),
    credentialKeys: getNhiaCredentialKeys(sanitizedSettings),
  })

  if (saveTarget === 'local_branch_server') {
    try {
      await saveBranchNhiaSettings(sanitizedSettings)
      const savedSettings = await getBranchNhiaSettings()
      const nhiaConfig = normalizeNhiaConfig(savedSettings, {
        mode,
        source: 'local_branch_server',
        organizationId,
      })
      writeCachedNhiaApiSettings(nhiaConfig, organizationId)
      logNhiaAccreditationExpiryDate('saved', nhiaConfig.accreditationExpiryDate)
      logNhiaConfigEvent('save completed', {
        mode,
        saveTarget,
        endpoint: '/api/nhia-config',
        saveSuccess: true,
        configSource: 'local_branch_server',
        hasApiKey: nhiaConfig.hasApiKey,
        hasApiSecret: nhiaConfig.hasApiSecret,
      })
      return nhiaConfig
    } catch (error) {
      logNhiaConfigEvent('save failed', {
        mode,
        saveTarget,
        endpoint: error?.endpoint || '/api/nhia-config',
        saveFailed: true,
        hasApiKey: Boolean(sanitizedSettings.hasApiKey || sanitizedSettings.credentials?.apiKey),
        hasApiSecret: Boolean(sanitizedSettings.hasApiSecret || sanitizedSettings.credentials?.apiSecret),
      })
      throw error
    }
  }

  try {
    const response = await invokeTierAccess({
      action: 'save_nhia_api_settings',
      settings: sanitizedSettings,
    })
    const directSavedSettings = await saveHostedNhiaConfigDirect(
      sanitizedSettings,
      organizationId,
      response?.settings || null
    )
    const readBack = await invokeTierAccess({ action: 'get_nhia_api_settings' })
    const directReadBackSettings = await readHostedNhiaConfigDirect(organizationId, directSavedSettings)
    const hostedSettings = {
      ...(response?.settings || {}),
      ...(readBack?.settings || {}),
      ...(directReadBackSettings || directSavedSettings || {}),
    }
    console.info('[NHIA CONFIG] cloud response/error', {
      response: summarizeNhiaApiSettingsForLog(hostedSettings),
      error: null,
    })

    if (!hostedSettings || !normalizeText(
      hostedSettings.facility_code ||
        hostedSettings.facilityCode ||
        hostedSettings.credential_code ||
        hostedSettings.credentialCode ||
        hostedSettings.provider_number ||
        hostedSettings.providerNumber
    )) {
      throw new Error('Unable to read the saved NHIA API settings response.')
    }

    const nhiaConfig = normalizeNhiaConfig(hostedSettings, {
      mode: 'ONLINE_CLOUD',
      source: 'cloud_supabase',
      organizationId,
    })
    writeCachedNhiaApiSettings(nhiaConfig, organizationId)
    logNhiaAccreditationExpiryDate('saved', nhiaConfig.accreditationExpiryDate)
    logNhiaConfigEvent('save completed', {
      mode: 'ONLINE_CLOUD',
      saveTarget: 'cloud_supabase',
      endpoint: 'tier-access:save_nhia_api_settings',
      saveSuccess: true,
      configSource: 'cloud_supabase',
      hasApiKey: nhiaConfig.hasApiKey,
      hasApiSecret: nhiaConfig.hasApiSecret,
    })
    console.info('[NHIA CONFIG] saved successfully', summarizeNhiaApiSettingsForLog(nhiaConfig))
    return nhiaConfig
  } catch (error) {
    console.error('[NHIA CONFIG] cloud response/error', {
      response: null,
      error: summarizeNhiaApiErrorForLog(error),
    })
    logNhiaConfigEvent('save failed', {
      mode: 'ONLINE_CLOUD',
      saveTarget: 'cloud_supabase',
      endpoint: 'tier-access:save_nhia_api_settings',
      saveFailed: true,
      hasApiKey: Boolean(sanitizedSettings.hasApiKey || sanitizedSettings.credentials?.apiKey),
      hasApiSecret: Boolean(sanitizedSettings.hasApiSecret || sanitizedSettings.credentials?.apiSecret),
    })
    throw error
  }
}

export const removeNhiaApiCredentials = async (options = {}) => {
  const organizationId = normalizeText(options.organizationId || options.organization_id)
  const mode = await getNhiaConfigMode()

  if (mode === 'ONLINE_LOCAL_SYNC' || mode === 'OFFLINE_LOCAL') {
    const currentSettings = await getBranchNhiaSettings()
    await saveBranchNhiaSettings({
      ...(currentSettings || {}),
      credentials: {},
      hasApiKey: false,
      hasApiSecret: false,
      has_api_key: false,
      has_api_secret: false,
    })
    const savedSettings = await getBranchNhiaSettings()
    const nhiaConfig = normalizeNhiaConfig({
      ...(savedSettings || {}),
      hasApiKey: false,
      hasApiSecret: false,
      has_api_key: false,
      has_api_secret: false,
      apiKeyEncrypted: '',
      apiSecretEncrypted: '',
      api_key_encrypted: '',
      api_secret_encrypted: '',
    }, {
      mode,
      source: 'local_branch_server',
      organizationId,
    })
    writeCachedNhiaApiSettings(nhiaConfig, organizationId)
    return nhiaConfig
  }

  let responseSettings = null
  try {
    const response = await invokeTierAccess({ action: 'remove_nhia_api_credentials' })
    responseSettings = response?.settings || null
  } catch (error) {
    console.warn('[NHIA CONFIG] tier-access credential removal failed; trying direct update', summarizeNhiaApiErrorForLog(error))
  }

  let directSettings = null
  if (!responseSettings) {
    directSettings = await removeHostedNhiaCredentialsDirect(organizationId, responseSettings)
  } else {
    try {
      directSettings = await removeHostedNhiaCredentialsDirect(organizationId, responseSettings)
    } catch {
      directSettings = null
    }
  }
  const hostedSettings = {
    ...(responseSettings || {}),
    ...(directSettings || {}),
    hasApiKey: false,
    has_api_key: false,
    hasApiSecret: false,
    has_api_secret: false,
    apiKeyEncrypted: '',
    api_key_encrypted: '',
    apiSecretEncrypted: '',
    api_secret_encrypted: '',
  }
  const nhiaConfig = normalizeNhiaConfig(hostedSettings, {
    mode: 'ONLINE_CLOUD',
    source: 'cloud_supabase',
    organizationId,
  })
  writeCachedNhiaApiSettings(nhiaConfig, organizationId)
  logNhiaConfigEvent('credentials removed', {
    mode: 'ONLINE_CLOUD',
    saveTarget: 'cloud_supabase',
    endpoint: 'nhia_configuration',
    hasApiKey: false,
    hasApiSecret: false,
  })
  return nhiaConfig
}

export const generateHostedNhiaCcCode = async (claimContext = {}) => {
  if (shouldUseBranchServer()) {
    throw new Error('Hosted NHIA CCC/CC code generation requires Supabase access.')
  }

  return await invokeTierAccess({
    action: 'generate_nhia_cc_code',
    ...claimContext,
  })
}

const submitHostedNhiaDirectPayload = async ({
  payload,
  payloadContent = '',
  contentType = 'application/json',
  claimIds = [],
  submissionAction = '',
} = {}) => {
  return await invokeTierAccess({
    action: 'submit_nhia_claims_direct',
    payload,
    payloadContent,
    contentType,
    claimIds,
    submissionAction,
  })
}

const submitBrowserClaimItBridgePayload = async ({
  payload,
  payloadContent = '',
  contentType = 'application/json',
  settings = {},
} = {}) => {
  const baseUrl = normalizeText(settings.apiBaseUrl || settings.api_base_url)
  const claimEndpointPath = normalizeText(settings.claimEndpointPath || settings.claim_endpoint_path)
  if (!baseUrl) throw new Error('CLAIM-it bridge base URL is required.')
  if (!claimEndpointPath) throw new Error('CLAIM-it claim submission endpoint path is required.')

  const body = normalizeText(payloadContent) || JSON.stringify(payload)
  const headers = {
    Accept: 'application/json',
    'Content-Type': contentType,
  }
  const validationMode = normalizeText(settings.validationMode || settings.validation_mode) || 'validate_before_submit'
  const validationEndpointPath = normalizeText(settings.claimValidationEndpointPath || settings.claim_validation_endpoint_path)
  if (validationMode !== 'submit_only' && validationEndpointPath) {
    const validationResponse = await fetch(joinClaimItBridgeUrl(baseUrl, validationEndpointPath), {
      method: 'POST',
      headers,
      body,
    })
    if (!validationResponse.ok) {
      throw new Error(`CLAIM-it validation returned HTTP ${validationResponse.status}.`)
    }
  }

  const response = await fetch(joinClaimItBridgeUrl(baseUrl, claimEndpointPath), {
    method: 'POST',
    headers,
    body,
  })
  const responseText = await response.text()
  let responseBody = {}
  try {
    responseBody = responseText ? JSON.parse(responseText) : {}
  } catch {
    responseBody = { raw: responseText }
  }
  if (!response.ok) {
    throw new Error(`CLAIM-it bridge returned HTTP ${response.status}.`)
  }
  return { ok: true, status: response.status, response: responseBody }
}

const getNhisReadinessContext = async (claimData = {}, options = {}) => {
  let providerClassLevel = getProviderPrescribingLevel(claimData, options)
  if (!providerClassLevel) {
    const settings = options.nhiaSettings || options.settings || await getNhiaApiSettings().catch(() => null)
    // ✅ NHIA CONFIG PATCH START
    providerClassLevel = normalizeClaimItProviderClassLevel(
      settings?.providerClassLevel ?? settings?.provider_class_level,
      normalizeOrganizationType(claimData?.organizationType ?? claimData?.organization_type ?? options.organizationType) === 'pharmacy' ? 'C' : ''
    )
    // ✅ NHIA CONFIG PATCH END
  }

  const hasCatalogOption = Array.isArray(options.nhisDrugCatalog) || Array.isArray(options.drugCatalog)
  const nhisDrugCatalog = hasCatalogOption
    ? (options.nhisDrugCatalog ?? options.drugCatalog)
    : await getAllNhisDrugs().catch(() => [])

  return { providerClassLevel, nhisDrugCatalog }
}

export const validateNhisClaimFinalReadiness = async (claimData, medicines = [], options = {}) => {
  const organizationType = normalizeOrganizationType(
    claimData?.organizationType ?? claimData?.organization_type ?? options.organizationType
  )
  const clinicalRules = organizationType === 'hospital'
    ? await getAllNhisClinicalRules()
    : DIAGNOSIS_TREATMENT_RULES
  const { providerClassLevel, nhisDrugCatalog } = await getNhisReadinessContext(claimData, options)
  const tariffServices = options.nhiaTariffServices ?? claimData?.nhis_claim_services ?? []
  const currentNhiaTariffItems = await getMergedCurrentNhiaTariffItemsForServices(
    tariffServices,
    options.currentNhiaTariffItems ?? options.nhiaTariffCatalog
  )

  return assessNhisClaimReadiness(
    { ...claimData, organizationType, providerClassLevel },
    medicines,
    {
      finalSubmission: true,
      clinicalRules,
      providerClassLevel,
      // ✅ NHIS PHARMACY LEVEL PATCH START
      pharmacyLevel: options.pharmacyLevel,
      // ✅ NHIS PHARMACY LEVEL PATCH END
      nhisDrugCatalog,
      enforcePrescribingLevel: true,
      nhiaTariffServices: tariffServices,
      currentNhiaTariffItems,
      tariffFacilityGroup: options.tariffFacilityGroup || options.tariff_facility_group,
      tariffCateringOption: options.tariffCateringOption || options.tariff_catering_option,
    }
  ).blockers
}

// ─── NHIS Drug Catalog ────────────────────────────────────────────────────────

const normalizePrescriptionFileSize = (value) => {
  const size = Number(value)
  return Number.isFinite(size) && size >= 0 ? Math.round(size) : null
}

const stripDataUrlPrefix = (value = '') => String(value || '').replace(/^data:[^,]*,/i, '').trim()

const bytesToBase64 = (bytes = new Uint8Array()) => {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

const base64ToBytes = (value = '') => {
  const cleanBase64 = stripDataUrlPrefix(value).replace(/\s+/g, '')
  if (!cleanBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64) || cleanBase64.length % 4 === 1) {
    throw new Error('base64 is invalid')
  }

  try {
    const binary = atob(cleanBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    throw new Error('base64 is invalid')
  }
}

const bytesStartWithPdfHeader = (bytes = new Uint8Array()) =>
  bytes.length >= 5 &&
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d

const bytesStartWithJpegHeader = (bytes = new Uint8Array()) =>
  bytes.length >= 3 &&
  bytes[0] === 0xff &&
  bytes[1] === 0xd8 &&
  bytes[2] === 0xff

const bytesStartWithPngHeader = (bytes = new Uint8Array()) =>
  bytes.length >= 8 &&
  bytes[0] === 0x89 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x4e &&
  bytes[3] === 0x47 &&
  bytes[4] === 0x0d &&
  bytes[5] === 0x0a &&
  bytes[6] === 0x1a &&
  bytes[7] === 0x0a

const normalizeClaimItAttachmentBase64 = (value = '') => stripDataUrlPrefix(value).replace(/\s+/g, '')

const getSafeClaimItPrescriptionFileName = (claimNumber = '') => {
  const safeClaimNumber = normalizeText(claimNumber)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'claim'
  return `prescription_${safeClaimNumber}.pdf`
}

const validateClaimItAttachmentBase64 = (base64, fileName = 'prescription attachment') => {
  const bytes = base64ToBytes(base64)
  if (!bytes.length) {
    throw new Error(`Unable to include ${fileName} in CLAIM-it CXF export: attachment is empty.`)
  }
  if (bytes.length > MAX_CLAIMIT_ATTACHMENT_BYTES) {
    throw new Error(`Unable to include ${fileName} in CLAIM-it CXF export: attachment is larger than 8 MB.`)
  }
  if (!bytesStartWithPdfHeader(bytes)) {
    throw new Error(`Unable to include ${fileName} in CLAIM-it CXF export: attachment must be a valid PDF.`)
  }
  return bytes
}

const getClaimItAttachmentBinaryDiagnostic = ({
  base64 = '',
  bytes = new Uint8Array(),
  mimeType = CLAIMIT_ATTACHMENT_MIME_TYPE,
  fileType = CLAIMIT_ATTACHMENT_FILE_TYPE,
} = {}) => ({
  embeddedPdfHeaderDetected: bytesStartWithPdfHeader(bytes),
  attachmentBase64Length: normalizeClaimItAttachmentBase64(base64).length,
  attachmentDecodedStartsWithPdf: bytesStartWithPdfHeader(bytes),
  attachmentMimeType: mimeType,
  attachmentFileType: fileType,
})

const getPrescriptionAttachmentPayload = (claimData = {}) => ({
  prescription_file_url: normalizeText(claimData.prescriptionFileUrl ?? claimData.prescription_file_url) || null,
  prescription_file_path: normalizeText(claimData.prescriptionFilePath ?? claimData.prescription_file_path) || null,
  prescription_file_name: normalizeText(claimData.prescriptionFileName ?? claimData.prescription_file_name) || null,
  prescription_file_type: normalizeText(claimData.prescriptionFileType ?? claimData.prescription_file_type) || null,
  prescription_file_size: normalizePrescriptionFileSize(
    claimData.prescriptionFileSize ?? claimData.prescription_file_size
  ),
  claimit_attachment_file_name: normalizeText(
    claimData.claimitAttachmentFileName ?? claimData.claimit_attachment_file_name
  ) || null,
  claimit_attachment_file_type: normalizeText(
    claimData.claimitAttachmentFileType ?? claimData.claimit_attachment_file_type
  ) || null,
  claimit_attachment_mime_type: normalizeText(
    claimData.claimitAttachmentMimeType ?? claimData.claimit_attachment_mime_type
  ) || null,
  claimit_attachment_base64: normalizeClaimItAttachmentBase64(
    claimData.claimitAttachmentBase64 ?? claimData.claimit_attachment_base64
  ) || null,
})

const sanitizeStoragePathSegment = (value, fallback = 'unknown') =>
  String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback

export const validateNhisPrescriptionPdfFile = (file) => {
  if (!file) return 'Select a scanned prescription PDF, JPEG, or PNG.'
  const fileName = String(file.name || '').toLowerCase()
  const isAllowedType =
    PRESCRIPTION_ATTACHMENT_TYPES.includes(file.type) ||
    PRESCRIPTION_ATTACHMENT_EXTENSIONS.some((extension) => fileName.endsWith(extension))
  if (!isAllowedType) return 'Only scanned prescription files in PDF, JPEG, or PNG format can be attached.'
  if (Number(file.size || 0) > MAX_PRESCRIPTION_ATTACHMENT_BYTES) {
    return 'Prescription attachment must be 3 MB or smaller.'
  }
  return ''
}

const getPrescriptionAttachmentContentType = (file = {}) => {
  const fileName = String(file.name || '').toLowerCase()
  if (file.type === 'image/jpeg' || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
    return 'image/jpeg'
  }
  if (file.type === 'image/png' || fileName.endsWith('.png')) {
    return 'image/png'
  }
  return 'application/pdf'
}

const getImageDimensions = (dataUrl) =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({
      width: image.naturalWidth || image.width || 1,
      height: image.naturalHeight || image.height || 1,
    })
    image.onerror = () => reject(new Error('Unable to read prescription image.'))
    image.src = dataUrl
  })

const fileToArrayBuffer = async (file) => {
  if (typeof file?.arrayBuffer === 'function') return await file.arrayBuffer()

  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('Unable to read prescription attachment.'))
    reader.readAsArrayBuffer(file)
  })
}

const fileToBytes = async (file) => new Uint8Array(await fileToArrayBuffer(file))

const fileToDataUrl = async (file) =>
  await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Unable to read prescription attachment.'))
    reader.readAsDataURL(file)
  })

const fileToBase64 = async (file) => {
  return bytesToBase64(await fileToBytes(file))
}

const imageDataUrlToPdfBase64 = async (dataUrl, contentType) => {
  const dimensions = await getImageDimensions(dataUrl)
  const orientation = dimensions.width > dimensions.height ? 'landscape' : 'portrait'
  const doc = new jsPDF({ orientation, unit: 'pt', format: 'a4', compress: true })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 24
  const maxWidth = pageWidth - margin * 2
  const maxHeight = pageHeight - margin * 2
  const scale = Math.min(maxWidth / dimensions.width, maxHeight / dimensions.height)
  const width = Math.max(1, dimensions.width * scale)
  const height = Math.max(1, dimensions.height * scale)
  const x = (pageWidth - width) / 2
  const y = (pageHeight - height) / 2
  doc.addImage(dataUrl, contentType === 'image/png' ? 'PNG' : 'JPEG', x, y, width, height)
  return normalizeClaimItAttachmentBase64(doc.output('datauristring'))
}

const createClaimItAttachmentFields = async (file, options = {}) => {
  const contentType = getPrescriptionAttachmentContentType(file)
  const fileName = getSafeClaimItPrescriptionFileName(options.claimNumber || options.claim_number || options.claimId)
  const base64 = contentType === CLAIMIT_ATTACHMENT_MIME_TYPE
    ? await fileToBase64(file)
    : await imageDataUrlToPdfBase64(await fileToDataUrl(file), contentType)

  validateClaimItAttachmentBase64(base64, fileName)

  return {
    claimitAttachmentFileName: fileName,
    claimitAttachmentFileType: CLAIMIT_ATTACHMENT_FILE_TYPE,
    claimitAttachmentMimeType: CLAIMIT_ATTACHMENT_MIME_TYPE,
    claimitAttachmentBase64: base64,
  }
}

const withClaimItAttachmentFileName = (payload = {}, claimNumber = '') => {
  if (!normalizeText(payload.claimit_attachment_base64)) return payload
  return {
    ...payload,
    claimit_attachment_file_name: getSafeClaimItPrescriptionFileName(claimNumber),
    claimit_attachment_file_type: CLAIMIT_ATTACHMENT_FILE_TYPE,
    claimit_attachment_mime_type: CLAIMIT_ATTACHMENT_MIME_TYPE,
  }
}

export const uploadNhisPrescriptionPdf = async (file, options = {}) => {
  const validationError = validateNhisPrescriptionPdfFile(file)
  if (validationError) throw new Error(validationError)
  const contentType = getPrescriptionAttachmentContentType(file)
  const claimItAttachment = await createClaimItAttachmentFields(file, options)
  if (shouldUseBranchServer()) {
    const dataUrl = await fileToDataUrl(file)

    if (!dataUrl) {
      throw new Error('Unable to read prescription attachment.')
    }

    return {
      prescriptionFilePath: '',
      prescriptionFileName: file.name || 'prescription',
      prescriptionFileType: contentType,
      prescriptionFileSize: file.size || 0,
      prescriptionFileUrl: dataUrl,
      ...claimItAttachment,
    }
  }
  if (!supabase?.storage) {
    throw new Error('Supabase storage is not configured for prescription attachments.')
  }

  const organizationId = sanitizeStoragePathSegment(options.organizationId, 'unknown-org')
  const month = sanitizeStoragePathSegment(
    options.yearMonth || new Date().toISOString().slice(0, 7),
    'unknown-month'
  )
  const randomId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : String(Date.now())
  const claimId = sanitizeStoragePathSegment(options.claimId || randomId, 'claim')
  const fileName = sanitizeStoragePathSegment(file.name || 'prescription', 'prescription')
  const path = `${organizationId}/${month}/${claimId}/${Date.now()}-${fileName}`

  const { data, error } = await supabase.storage
    .from(NHIS_PRESCRIPTION_BUCKET)
    .upload(path, file, {
      contentType,
      cacheControl: '3600',
      upsert: true,
    })

  if (error) {
    const message = String(error.message || '').toLowerCase()
    if (message.includes('bucket') || message.includes('not found')) {
      throw new Error('Prescription storage bucket is missing. Run supabase-patch-nhis-prescription-attachments.sql first.')
    }
    throw error
  }

  return {
    prescriptionFilePath: data?.path || path,
    prescriptionFileName: file.name || 'prescription',
    prescriptionFileType: contentType,
    prescriptionFileSize: file.size || 0,
    prescriptionFileUrl: '',
    ...claimItAttachment,
  }
}

export const getNhisPrescriptionSignedUrl = async (path, expiresInSeconds = 5 * 60) => {
  const cleanPath = normalizeText(path)
  if (!cleanPath) throw new Error('Prescription file path is missing.')
  if (!supabase?.storage) throw new Error('Supabase storage is not configured.')

  const { data, error } = await supabase.storage
    .from(NHIS_PRESCRIPTION_BUCKET)
    .createSignedUrl(cleanPath, expiresInSeconds)

  if (error) throw error
  return data?.signedUrl || ''
}

export const getAllNhiaTariffItems = async (filters = {}) => {
  if (shouldUseBranchServer()) return []

  let query = supabase
    .from('nhia_tariff_items')
    .select(`
      id, tariff_version, facility_group, catering_option, mdc, gdrg_code,
      description, age_band, tariff_amount, currency, source_file, source_page
    `)
    .eq('is_active', true)
    .eq('tariff_version', filters.tariffVersion || NHIA_TARIFF_VERSION)
    .order('facility_group')
    .order('catering_option')
    .order('mdc')
    .order('gdrg_code')
    .limit(filters.limit || 5000)

  if (filters.facilityGroup) query = query.eq('facility_group', filters.facilityGroup)
  if (filters.cateringOption) query = query.eq('catering_option', filters.cateringOption)
  if (filters.mdc) query = query.eq('mdc', filters.mdc)

  const term = sanitizeSearchTerm(filters.searchTerm || filters.search || '')
  if (term) {
    query = query.or(`gdrg_code.ilike.%${term}%,description.ilike.%${term}%,mdc.ilike.%${term}%`)
  }

  const { data, error } = await query
  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code)) return []
    throw error
  }
  return data || []
}

export const updateNhiaTariffItem = async (id, tariffData = {}) => {
  const description = assertRequiredText(tariffData.description, 'G-DRG description')
  const tariffAmount = assertNonNegativeNumber(tariffData.tariffAmount ?? tariffData.tariff_amount, 'Tariff amount')

  if (shouldUseBranchServer()) {
    throw new Error('Editing G-DRG tariffs requires online Supabase access.')
  }

  const { data, error } = await supabase
    .from('nhia_tariff_items')
    .update({
      facility_group: normalizeText(tariffData.facilityGroup ?? tariffData.facility_group) || null,
      catering_option: normalizeText(tariffData.cateringOption ?? tariffData.catering_option) || null,
      mdc: normalizeText(tariffData.mdc) || null,
      description,
      age_band: normalizeText(tariffData.ageBand ?? tariffData.age_band) || null,
      tariff_amount: tariffAmount,
      currency: normalizeText(tariffData.currency) || 'GHS',
      source_file: normalizeText(tariffData.sourceFile ?? tariffData.source_file) || null,
      source_page: tariffData.sourcePage || tariffData.source_page ? Number(tariffData.sourcePage ?? tariffData.source_page) : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

const getCurrentNhiaTariffItemsForServices = async (serviceLines = []) => {
  if (shouldUseBranchServer()) return []
  const ids = Array.from(new Set(
    normalizeNhiaTariffServiceLines(serviceLines)
      .map((service) => service.nhiaTariffItemId)
      .filter(Boolean)
  ))
  if (!ids.length) return []

  const { data, error } = await supabase
    .from('nhia_tariff_items')
    .select(`
      id, tariff_version, facility_group, catering_option, mdc, gdrg_code,
      description, age_band, tariff_amount, currency, source_file, source_page
    `)
    .in('id', ids)
    .eq('is_active', true)

  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code)) return []
    throw error
  }
  return data || []
}

const getMergedCurrentNhiaTariffItemsForServices = async (serviceLines = [], providedItems = null) => {
  const provided = Array.isArray(providedItems) ? providedItems : []
  const fetched = await getCurrentNhiaTariffItemsForServices(serviceLines).catch(() => [])
  const byId = new Map()
  ;[...provided, ...fetched].forEach((item) => {
    const normalized = normalizeTariffCatalogItem(item)
    if (normalized.id) byId.set(normalized.id, item)
  })
  return byId.size ? Array.from(byId.values()) : [...provided, ...fetched]
}

export const getAllNhisDrugs = async (searchTerm = '') => {
  if (shouldUseBranchServer()) {
    return await listBranchRecords('nhis/drugs', { searchTerm })
  }

  let query = supabase
    .from('nhis_drugs')
    .select('*')
    .eq('is_active', true)
    .order('description')

  const term = sanitizeSearchTerm(searchTerm)
  if (term) {
    query = query.or(
      `code.ilike.%${term}%,description.ilike.%${term}%,generic_name.ilike.%${term}%`
    )
  }

  const { data, error } = await query
  if (error) throw error
  return data || []
}

export const getNhisDrugByCode = async (code) => {
  if (shouldUseBranchServer()) {
    const drugs = await listBranchRecords('nhis/drugs', { searchTerm: code, limit: 1 })
    return drugs.find((drug) => String(drug.code || '').toUpperCase() === code.trim().toUpperCase()) || null
  }

  const { data, error } = await supabase
    .from('nhis_drugs')
    .select('*')
    .eq('code', code.trim().toUpperCase())
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error
  return data
}

export const createNhisDrug = async (drugData) => {
  const code        = assertRequiredText(drugData.code,        'Drug code').toUpperCase()
  const description = assertRequiredText(drugData.description, 'Description')

  if (shouldUseBranchServer()) {
    return await createBranchRecord('nhis/drugs', {
      code,
      description,
      generic_name: normalizeText(drugData.genericName) || null,
      strength: normalizeText(drugData.strength) || null,
      dosage_form: normalizeText(drugData.dosageForm) || null,
      category: normalizeText(drugData.category) || null,
      // ✅ NHIS PHARMACY LEVEL PATCH START
      medicine_access_level: normalizeMedicineAccessLevel(drugData.medicineAccessLevel) || null,
      required_pharmacy_level: normalizePharmacyLevel(drugData.requiredPharmacyLevel) || null,
      // ✅ NHIS PHARMACY LEVEL PATCH END
      unit: normalizeText(drugData.unit) || 'unit',
      unit_price: assertNonNegativeNumber(drugData.unitPrice, 'Unit price'),
      is_active: true,
    })
  }

  const { data, error } = await supabase
    .from('nhis_drugs')
    .insert([{
      code,
      description,
      generic_name: normalizeText(drugData.genericName)  || null,
      strength:     normalizeText(drugData.strength)     || null,
      dosage_form:  normalizeText(drugData.dosageForm)   || null,
      category:     normalizeText(drugData.category)     || null,
      // ✅ NHIS PHARMACY LEVEL PATCH START
      medicine_access_level: normalizeMedicineAccessLevel(drugData.medicineAccessLevel) || null,
      required_pharmacy_level: normalizePharmacyLevel(drugData.requiredPharmacyLevel) || null,
      // ✅ NHIS PHARMACY LEVEL PATCH END
      unit:         normalizeText(drugData.unit)         || 'unit',
      unit_price:   assertNonNegativeNumber(drugData.unitPrice, 'Unit price'),
    }])
    .select()
    .single()

  if (error) throw error
  return data
}

export const updateNhisDrug = async (id, drugData) => {
  if (shouldUseBranchServer()) {
    return await updateBranchRecord('nhis/drugs', id, {
      description: normalizeText(drugData.description),
      generic_name: normalizeText(drugData.genericName) || null,
      strength: normalizeText(drugData.strength) || null,
      dosage_form: normalizeText(drugData.dosageForm) || null,
      category: normalizeText(drugData.category) || null,
      // ✅ NHIS PHARMACY LEVEL PATCH START
      medicine_access_level: normalizeMedicineAccessLevel(drugData.medicineAccessLevel) || null,
      required_pharmacy_level: normalizePharmacyLevel(drugData.requiredPharmacyLevel) || null,
      // ✅ NHIS PHARMACY LEVEL PATCH END
      unit: normalizeText(drugData.unit) || 'unit',
      unit_price: assertNonNegativeNumber(drugData.unitPrice, 'Unit price'),
      updated_at: new Date().toISOString(),
    })
  }

  const { data, error } = await supabase
    .from('nhis_drugs')
    .update({
      description:  normalizeText(drugData.description),
      generic_name: normalizeText(drugData.genericName)  || null,
      strength:     normalizeText(drugData.strength)     || null,
      dosage_form:  normalizeText(drugData.dosageForm)   || null,
      category:     normalizeText(drugData.category)     || null,
      // ✅ NHIS PHARMACY LEVEL PATCH START
      medicine_access_level: normalizeMedicineAccessLevel(drugData.medicineAccessLevel) || null,
      required_pharmacy_level: normalizePharmacyLevel(drugData.requiredPharmacyLevel) || null,
      // ✅ NHIS PHARMACY LEVEL PATCH END
      unit:         normalizeText(drugData.unit)         || 'unit',
      unit_price:   assertNonNegativeNumber(drugData.unitPrice, 'Unit price'),
      updated_at:   new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

export const deleteNhisDrug = async (id) => {
  if (shouldUseBranchServer()) {
    await updateBranchRecord('nhis/drugs', id, {
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    return
  }

  const { error } = await supabase
    .from('nhis_drugs')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw error
}

/**
 * Bulk upsert NHIS drugs from an import (CSV/Excel).
 * Existing drugs (matched by code) are updated; new ones are inserted.
 * @param {Array} drugs - validated drug rows
 * @returns {{ inserted: number, updated: number, errors: string[] }}
 */
export const upsertNhisDrugs = async (drugs, options = {}) => {
  if (!drugs?.length) throw new Error('No drugs to import.')

  const rows = drugs.map((d) => ({
    code:         String(d.code || '').trim().toUpperCase(),
    description:  String(d.description || '').trim(),
    generic_name: String(d.generic_name || d.genericName || '').trim() || null,
    strength:     String(d.strength     || '').trim() || null,
    dosage_form:  String(d.dosage_form  || d.dosageForm || '').trim() || null,
    category:     String(d.category     || '').trim() || null,
    unit:         String(d.unit         || 'unit').trim(),
    unit_price:   Number.parseFloat(d.unit_price ?? d.unitPrice ?? 0) || 0,
    is_active:    true,
    updated_at:   new Date().toISOString(),
  })).filter((r) => r.code && r.description)

  if (!rows.length) throw new Error('No valid rows found to import.')

  if (shouldUseBranchServer()) {
    for (const row of rows) {
      await createBranchRecord('nhis/drugs', row)
    }
    return rows.length
  }

  const { error } = await supabase
    .from('nhis_drugs')
    .upsert(rows, { onConflict: 'organization_id,code', ignoreDuplicates: false })

  if (error) throw error

  if (options.syncInventory !== false) {
    try {
      await invokeTierAccess({
        action: 'sync_nhis_drugs_to_inventory',
        drugs: rows,
      })
    } catch (inventoryError) {
      throw new Error(
        `NHIS catalog imported, but inventory sync failed: ${
          inventoryError.message || 'Please apply the NHIS inventory pricing patch and try again.'
        }`
      )
    }
  }

  await tryLogAuditEvent({
    eventType: 'nhis_drugs.imported',
    entityType: 'nhis_drugs',
    entityId: null,
    action: 'import',
    details: { count: rows.length },
  })

  return rows.length
}

// ─── NHIS Claims ─────────────────────────────────────────────────────────────

const hydrateClaimsWithServiceLines = async (claims = []) => {
  if (!claims.length || shouldUseBranchServer()) return claims
  const claimIds = claims.map((claim) => claim.id).filter(Boolean)
  if (!claimIds.length) return claims

  const { data, error } = await supabase
    .from('nhis_claim_services')
    .select(`claim_id, ${NHIS_CLAIM_SERVICE_SELECT}`)
    .in('claim_id', claimIds)
    .order('created_at')

  if (error) {
    if (isMissingClaimServicesTable(error)) {
      return claims.map((claim) => ({ ...claim, nhis_claim_services: [] }))
    }
    throw error
  }

  const linesByClaim = new Map()
  ;(data || []).forEach((line) => {
    const lines = linesByClaim.get(line.claim_id) || []
    lines.push(line)
    linesByClaim.set(line.claim_id, lines)
  })

  return claims.map((claim) => ({
    ...claim,
    nhis_claim_services: linesByClaim.get(claim.id) || [],
  }))
}

const hydrateClaimsWithMedicineLines = async (claims = []) => {
  if (!claims.length || shouldUseBranchServer()) return claims
  const claimIds = claims
    .filter((claim) => !Array.isArray(claim.nhis_claim_medicines) || (!claim.nhis_claim_medicines.length && Number(claim.total_amount || 0) > 0))
    .map((claim) => claim.id)
    .filter(Boolean)
  if (!claimIds.length) return claims

  const { data, error } = await supabase
    .from('nhis_claim_medicines')
    .select(`
      id, claim_id, nhis_drug_id, drug_code, description, unit,
      unit_price, dispensed_qty, dispensary_date,
      dose, frequency, duration, total_amount
    `)
    .in('claim_id', claimIds)
    .order('created_at')

  if (error) return claims

  const linesByClaim = new Map()
  ;(data || []).forEach((line) => {
    const lines = linesByClaim.get(line.claim_id) || []
    lines.push(line)
    linesByClaim.set(line.claim_id, lines)
  })

  return claims.map((claim) => ({
    ...claim,
    nhis_claim_medicines: Array.isArray(claim.nhis_claim_medicines) && claim.nhis_claim_medicines.length
      ? claim.nhis_claim_medicines
      : (linesByClaim.get(claim.id) || claim.nhis_claim_medicines || []),
  }))
}

const hydrateNhisClaimsForUi = async (claims = []) =>
  await hydrateClaimsWithServiceLines(await hydrateClaimsWithMedicineLines(claims))

const toNhisClaimServiceRows = (claimId, serviceLines = [], claimData = {}) =>
  normalizeNhiaTariffServiceLines(serviceLines, claimData).map((service) => ({
    claim_id: claimId,
    nhia_tariff_item_id: service.nhiaTariffItemId,
    tariff_version: service.tariffVersion,
    facility_group: service.facilityGroup,
    catering_option: service.cateringOption,
    mdc: service.mdc,
    gdrg_code: service.gdrgCode,
    description: assertRequiredText(service.description, 'Service description'),
    age_band: service.ageBand,
    unit_price: assertNonNegativeNumber(service.unitPrice, 'Service tariff amount'),
    quantity: assertPositiveNumber(service.quantity, 'Service quantity'),
    service_date: service.serviceDate || null,
    total_amount: assertNonNegativeNumber(service.totalAmount, 'Service total amount'),
    source_file: service.sourceFile,
    source_page: service.sourcePage,
  }))

const insertNhisClaimServiceRows = async (serviceRows) => {
  if (!serviceRows.length) return
  const { error } = await supabase
    .from('nhis_claim_services')
    .insert(serviceRows)

  if (error) {
    if (isMissingClaimServicesTable(error)) {
      throw new Error('NHIA tariff service lines need the claim-services SQL patch. Run supabase-patch-nhia-claim-services.sql, then save this hospital claim again.')
    }
    throw error
  }
}

const stripOptionalClaimMedicineSchemaColumns = (medicineRows = []) =>
  medicineRows.map((row) => {
    const stripped = { ...row }
    OPTIONAL_CLAIM_MEDICINE_SCHEMA_COLUMNS.forEach((column) => {
      delete stripped[column]
    })
    return stripped
  })

const insertNhisClaimMedicineRows = async (medicineRows = []) => {
  if (!medicineRows.length) return

  let { error } = await supabase
    .from('nhis_claim_medicines')
    .insert(medicineRows)

  if (error && isMissingOptionalClaimMedicineColumn(error)) {
    ;({ error } = await supabase
      .from('nhis_claim_medicines')
      .insert(stripOptionalClaimMedicineSchemaColumns(medicineRows)))
  }

  if (error) throw error
}

export const getAllNhisClaims = async (filters = {}) => {
  if (shouldUseBranchServer()) {
    return await listBranchRecords('nhis/claims', filters)
  }

  const buildQuery = (select = NHIS_CLAIM_MEDICINES_SELECT) => {
    let query = supabase
      .from('nhis_claims')
      .select(select)
      .order('created_at', { ascending: false })

    if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status)
    }

    if (filters.month) {
      query = query.eq('submission_month', filters.month)
    }

    if (filters.searchTerm) {
      const term = sanitizeSearchTerm(filters.searchTerm)
      if (term) {
        query = query.or(
          `surname.ilike.%${term}%,other_names.ilike.%${term}%,member_no.ilike.%${term}%,claim_number.ilike.%${term}%,hin.ilike.%${term}%`
        )
      }
    }

    return query
  }

  let { data, error } = await buildQuery()
  if (error && isMissingOptionalClaimMedicineColumn(error)) {
    ;({ data, error } = await buildQuery(NHIS_CLAIM_MEDICINES_SELECT_BASIC))
  }
  if (error) throw error
  return await hydrateNhisClaimsForUi(data || [])
}

export const getNhisClaimStats = async () => {
  if (shouldUseBranchServer()) {
    const rows = await getAllNhisClaims()
    return {
      total: rows.length,
      served: rows.filter((r) => r.status === 'served').length,
      submitted: rows.filter((r) => r.status === 'submitted').length,
      paid: rows.filter((r) => r.status === 'paid').length,
      rejected: rows.filter((r) => r.status === 'rejected').length,
      totalPaid: rows
        .filter((r) => r.status === 'paid')
        .reduce((s, r) => s + Number(r.total_amount || 0), 0),
    }
  }

  const { data, error } = await supabase
    .from('nhis_claims')
    .select('status, total_amount')

  if (error) throw error

  const rows = data || []
  return {
    total:     rows.length,
    served:    rows.filter((r) => r.status === 'served').length,
    submitted: rows.filter((r) => r.status === 'submitted').length,
    paid:      rows.filter((r) => r.status === 'paid').length,
    rejected:  rows.filter((r) => r.status === 'rejected').length,
    totalPaid: rows
      .filter((r) => r.status === 'paid')
      .reduce((s, r) => s + Number(r.total_amount || 0), 0),
  }
}

/**
 * Creates an NHIS claim with medicines.
 * Also saves HIN/member_no back to the patient record if patient_id is provided.
 */
export const createNhisClaim = async (claimData, medicines, options = {}) => {
  const organizationType = normalizeOrganizationType(claimData?.organizationType ?? claimData?.organization_type)
  const tariffServices = normalizeNhiaTariffServiceLines(
    options.nhiaTariffServices ?? claimData?.nhiaTariffServices ?? claimData?.nhis_claim_services ?? [],
    claimData
  )
  const { providerClassLevel, nhisDrugCatalog } = await getNhisReadinessContext(claimData, options)
  const currentNhiaTariffItems = await getMergedCurrentNhiaTariffItemsForServices(
    tariffServices,
    options.currentNhiaTariffItems ?? options.nhiaTariffCatalog
  )
  const allowIncompleteReview = Boolean(claimData?.allowIncompleteReview || claimData?.reviewOnly)
  const readiness = assessNhisClaimReadiness(
    { ...claimData, organizationType, providerClassLevel },
    medicines,
    {
      enforcePrescribingLevel: true,
      requirePrescriptionAttachment: !allowIncompleteReview,
      providerClassLevel,
      // ✅ NHIS PHARMACY LEVEL PATCH START
      pharmacyLevel: options.pharmacyLevel,
      // ✅ NHIS PHARMACY LEVEL PATCH END
      nhisDrugCatalog,
      nhiaTariffServices: tariffServices,
      currentNhiaTariffItems,
      tariffFacilityGroup: options.tariffFacilityGroup || options.tariff_facility_group,
      tariffCateringOption: options.tariffCateringOption || options.tariff_catering_option,
    }
  )
  if (readiness.blockers.length && !allowIncompleteReview) {
    throw new Error(`NHIS claim readiness check failed: ${readiness.blockers.slice(0, 5).join(' ')}`)
  }

  const isHospital = organizationType === 'hospital'
  assertRequiredText(claimData.surname, 'Surname')
  assertRequiredText(claimData.folderNo, 'Folder number')
  assertRequiredText(claimData.referringFacility, 'Prescribing facility')
  const memberNo = normalizeNhiaMemberNumber(
    assertRequiredText(claimData.memberNo, 'NHIS member number or Ghana Card number')
  )
  const cccNo = normalizeOptionalNhisCcCodeForMode(
    claimData.cccNo ?? claimData.ccc_no ?? claimData.ccCode ?? claimData.cc_code,
    options
  )
  const serviceDate = normalizeText(claimData.serviceDate || claimData.serviceDateFrom)

  const medicineTotal = medicines.reduce((s, m) => s + Number(m.totalAmount || 0), 0)
  const serviceTotal = tariffServices.reduce((s, line) => s + Number(line.totalAmount || 0), 0)
  const totalAmount = medicineTotal + serviceTotal
  const diagnosisDetails = getDiagnosisDetailsPayload(claimData)
  let claimPayload = {
    patient_id:         claimData.patientId         || null,
    member_no:          memberNo,
    hin:                normalizeText(claimData.hin)               || null,
    surname:            normalizeText(claimData.surname),
    other_names:        normalizeText(claimData.otherNames)        || null,
    folder_no:          normalizeText(claimData.folderNo)          || null,
    gender:             normalizeText(claimData.gender)            || null,
    date_of_birth:      claimData.dateOfBirth                      || null,
    patient_address:    isHospital ? normalizeText(claimData.patientAddress) || null : null,
    child_weight_kg:    isHospital && claimData.childWeightKg
      ? assertNonNegativeNumber(claimData.childWeightKg, 'Child weight')
      : null,
    ccc_no:             cccNo,
    diagnosis:          normalizeText(claimData.diagnosis)         || null,
    diagnosis_details:  diagnosisDetails,
    service_date_from:  serviceDate                                || null,
    service_date_to:    serviceDate                                || null,
    branch_id:          claimData.branchId                         || null,
    referring_facility: normalizeText(claimData.referringFacility) || null,
    referral_code:      normalizeText(claimData.referralCode)      || null,
    physician_name:     normalizeText(claimData.physicianName)     || null,
    pre_auth_codes:     normalizeText(claimData.preAuthCodes)      || null,
    total_amount:       totalAmount,
    status:             'served',
    notes:              normalizeText(claimData.notes)             || null,
    unserved_medicines_note: normalizeText(
      claimData.unservedMedicinesNote ?? claimData.unserved_medicines_note
    ) || null,
    ...getPrescriptionAttachmentPayload(claimData),
    created_by:         claimData.createdBy                        || null,
  }

  if (options.useBranchServer || shouldUseBranchServer()) {
    return await createBranchRecord('nhis/claims', {
      ...claimPayload,
      nhis_claim_medicines: medicines.map((m) => ({
        nhis_drug_id: m.nhisDrugId || null,
        drug_code: normalizeText(m.drugCode) || null,
        description: assertRequiredText(m.description, 'Medicine description'),
        unit: normalizeText(m.unit) || 'unit',
        unit_price: assertNonNegativeNumber(m.unitPrice, 'Unit price'),
        dispensed_qty: assertNonNegativeNumber(m.dispensedQty, 'Dispensed qty'),
        dispensary_date: m.dispensaryDate || null,
        dose: normalizeText(m.dose) || null,
        frequency: normalizeText(m.frequency) || null,
        duration: normalizeText(m.duration) || null,
        total_amount: assertNonNegativeNumber(m.totalAmount, 'Total amount'),
        // ✅ NHIS PHARMACY LEVEL PATCH START
        medicine_access_level: normalizeMedicineAccessLevel(m.medicineAccessLevel ?? m.medicine_access_level) || null,
        required_pharmacy_level: normalizePharmacyLevel(m.requiredPharmacyLevel ?? m.required_pharmacy_level) || null,
        // ✅ NHIS PHARMACY LEVEL PATCH END
      })),
      nhis_claim_services: tariffServices.map((service) => ({
        nhia_tariff_item_id: service.nhiaTariffItemId,
        tariff_version: service.tariffVersion,
        facility_group: service.facilityGroup,
        catering_option: service.cateringOption,
        mdc: service.mdc,
        gdrg_code: service.gdrgCode,
        description: service.description,
        age_band: service.ageBand,
        unit_price: service.unitPrice,
        quantity: service.quantity,
        service_date: service.serviceDate,
        total_amount: service.totalAmount,
        source_file: service.sourceFile,
        source_page: service.sourcePage,
      })),
    })
  }

  const { data: claim, error: claimError } = await insertNhisClaimWithSchemaFallback(claimPayload)

  if (claimError) throw claimError

  const claimItNamedPayload = withClaimItAttachmentFileName(claimPayload, claim.claim_number)
  if (claimItNamedPayload.claimit_attachment_file_name !== claimPayload.claimit_attachment_file_name) {
    await updateNhisClaimWithSchemaFallback(claim.id, claimItNamedPayload)
    claimPayload = claimItNamedPayload
  }

  // Insert medicines
  const medicineRows = medicines.map((m) => ({
    claim_id:       claim.id,
    nhis_drug_id:   m.nhisDrugId      || null,
    drug_code:      normalizeText(m.drugCode)      || null,
    description:    assertRequiredText(m.description, 'Medicine description'),
    unit:           normalizeText(m.unit)           || 'unit',
    unit_price:     assertNonNegativeNumber(m.unitPrice, 'Unit price'),
    dispensed_qty:  assertNonNegativeNumber(m.dispensedQty, 'Dispensed qty'),
    dispensary_date: m.dispensaryDate || null,
    dose:           normalizeText(m.dose)           || null,
    frequency:      normalizeText(m.frequency)      || null,
    duration:       normalizeText(m.duration)       || null,
    total_amount:   assertNonNegativeNumber(m.totalAmount, 'Total amount'),
    // ✅ NHIS PHARMACY LEVEL PATCH START
    medicine_access_level: normalizeMedicineAccessLevel(m.medicineAccessLevel ?? m.medicine_access_level) || null,
    required_pharmacy_level: normalizePharmacyLevel(m.requiredPharmacyLevel ?? m.required_pharmacy_level) || null,
    // ✅ NHIS PHARMACY LEVEL PATCH END
  }))

  await insertNhisClaimMedicineRows(medicineRows)

  await insertNhisClaimServiceRows(toNhisClaimServiceRows(claim.id, tariffServices, claimData))

  // Save NHIS member info back to patient record for auto-fill on future visits
  if (claimData.patientId && (claimData.memberNo || claimData.hin)) {
    const { error: patientUpdateError } = await supabase
      .from('patients')
      .update({
        nhis_member_no:    memberNo || null,
        nhis_hin:          normalizeText(claimData.hin)      || null,
        insurance_provider: 'NHIS',
        insurance_id:      normalizeText(memberNo || claimData.hin) || null,
      })
      .eq('id', claimData.patientId)

    if (patientUpdateError) throwFriendlyNhisPatientError(patientUpdateError)
  }

  await tryLogAuditEvent({
    eventType: 'nhis_claim.created',
    entityType: 'nhis_claims',
    entityId: claim.id,
    action: 'create',
    details: {
      claim_number:  claim.claim_number,
      patient_name:  `${claimData.surname} ${claimData.otherNames || ''}`.trim(),
      medicine_count: medicines.length,
      service_count:  tariffServices.length,
      total_amount:   totalAmount,
    },
  })

  return claim
}

export const updateNhisClaim = async (id, claimData, medicines, options = {}) => {
  const organizationType = normalizeOrganizationType(claimData?.organizationType ?? claimData?.organization_type)
  const tariffServices = normalizeNhiaTariffServiceLines(
    options.nhiaTariffServices ?? claimData?.nhiaTariffServices ?? claimData?.nhis_claim_services ?? [],
    claimData
  )
  const { providerClassLevel, nhisDrugCatalog } = await getNhisReadinessContext(claimData, options)
  const currentNhiaTariffItems = await getMergedCurrentNhiaTariffItemsForServices(
    tariffServices,
    options.currentNhiaTariffItems ?? options.nhiaTariffCatalog
  )
  const clinicalRules = organizationType === 'hospital'
    ? await getAllNhisClinicalRules()
    : DIAGNOSIS_TREATMENT_RULES
  const readiness = assessNhisClaimReadiness(
    { ...claimData, organizationType, providerClassLevel },
    medicines,
    {
      requireMedicineDirections: true,
      enforceDiagnosisTreatmentMatch: organizationType === 'hospital',
      enforcePrescribingLevel: true,
      requirePrescriptionAttachment: true,
      providerClassLevel,
      // ✅ NHIS PHARMACY LEVEL PATCH START
      pharmacyLevel: options.pharmacyLevel,
      // ✅ NHIS PHARMACY LEVEL PATCH END
      nhisDrugCatalog,
      clinicalRules,
      nhiaTariffServices: tariffServices,
      currentNhiaTariffItems,
      tariffFacilityGroup: options.tariffFacilityGroup || options.tariff_facility_group,
      tariffCateringOption: options.tariffCateringOption || options.tariff_catering_option,
    }
  )
  if (readiness.blockers.length) {
    throw new Error(`NHIS correction check failed: ${readiness.blockers.slice(0, 5).join(' ')}`)
  }

  const isHospital = organizationType === 'hospital'
  assertRequiredText(claimData.surname, 'Surname')
  assertRequiredText(claimData.folderNo, 'Folder number')
  assertRequiredText(claimData.referringFacility, 'Prescribing facility')
  const memberNo = normalizeNhiaMemberNumber(
    assertRequiredText(claimData.memberNo, 'NHIS member number or Ghana Card number')
  )
  const cccNo = normalizeOptionalNhisCcCodeForMode(
    claimData.cccNo ?? claimData.ccc_no ?? claimData.ccCode ?? claimData.cc_code,
    options
  )
  const serviceDate = normalizeText(claimData.serviceDate || claimData.serviceDateFrom)
  const medicineTotal = medicines.reduce((s, m) => s + Number(m.totalAmount || 0), 0)
  const serviceTotal = tariffServices.reduce((s, line) => s + Number(line.totalAmount || 0), 0)
  const totalAmount = medicineTotal + serviceTotal
  const diagnosisDetails = getDiagnosisDetailsPayload(claimData)
  const medicineRows = medicines.map((m) => ({
    nhis_drug_id: m.nhisDrugId || null,
    drug_code: normalizeText(m.drugCode) || null,
    description: assertRequiredText(m.description, 'Medicine description'),
    unit: normalizeText(m.unit) || 'unit',
    unit_price: assertNonNegativeNumber(m.unitPrice, 'Unit price'),
    dispensed_qty: assertNonNegativeNumber(m.dispensedQty, 'Dispensed qty'),
    dispensary_date: m.dispensaryDate || null,
    dose: normalizeText(m.dose) || null,
    frequency: normalizeText(m.frequency) || null,
    duration: normalizeText(m.duration) || null,
    total_amount: assertNonNegativeNumber(m.totalAmount, 'Total amount'),
    // ✅ NHIS PHARMACY LEVEL PATCH START
    medicine_access_level: normalizeMedicineAccessLevel(m.medicineAccessLevel ?? m.medicine_access_level) || null,
    required_pharmacy_level: normalizePharmacyLevel(m.requiredPharmacyLevel ?? m.required_pharmacy_level) || null,
    // ✅ NHIS PHARMACY LEVEL PATCH END
  }))

  let claimPayload = {
    patient_id: claimData.patientId || null,
    member_no: memberNo,
    hin: normalizeText(claimData.hin) || null,
    surname: normalizeText(claimData.surname),
    other_names: normalizeText(claimData.otherNames) || null,
    folder_no: normalizeText(claimData.folderNo) || null,
    gender: normalizeText(claimData.gender) || null,
    date_of_birth: claimData.dateOfBirth || null,
    patient_address: isHospital ? normalizeText(claimData.patientAddress) || null : null,
    child_weight_kg: isHospital && claimData.childWeightKg
      ? assertNonNegativeNumber(claimData.childWeightKg, 'Child weight')
      : null,
    ccc_no: cccNo,
    diagnosis: normalizeText(claimData.diagnosis) || null,
    diagnosis_details: diagnosisDetails,
    service_date_from: serviceDate || null,
    service_date_to: serviceDate || null,
    branch_id: claimData.branchId || null,
    referring_facility: normalizeText(claimData.referringFacility) || null,
    referral_code: normalizeText(claimData.referralCode) || null,
    physician_name: normalizeText(claimData.physicianName) || null,
    pre_auth_codes: normalizeText(claimData.preAuthCodes) || null,
    total_amount: totalAmount,
    notes: normalizeText(claimData.notes) || null,
    unserved_medicines_note: normalizeText(
      claimData.unservedMedicinesNote ?? claimData.unserved_medicines_note
    ) || null,
    ...getPrescriptionAttachmentPayload(claimData),
    updated_at: new Date().toISOString(),
  }

  if (shouldUseBranchServer()) {
    return await updateBranchRecord('nhis/claims', id, {
      ...claimPayload,
      nhis_claim_medicines: medicineRows,
      nhis_claim_services: tariffServices.map((service) => ({
        nhia_tariff_item_id: service.nhiaTariffItemId,
        tariff_version: service.tariffVersion,
        facility_group: service.facilityGroup,
        catering_option: service.cateringOption,
        mdc: service.mdc,
        gdrg_code: service.gdrgCode,
        description: service.description,
        age_band: service.ageBand,
        unit_price: service.unitPrice,
        quantity: service.quantity,
        service_date: service.serviceDate,
        total_amount: service.totalAmount,
        source_file: service.sourceFile,
        source_page: service.sourcePage,
      })),
    })
  }

  const { data: existingClaim, error: existingError } = await supabase
    .from('nhis_claims')
    .select('id, claim_number, status')
    .eq('id', id)
    .single()

  if (existingError) throw existingError
  if (existingClaim.status !== 'served') {
    throw new Error('Only served NHIS claims can be edited before submission/export.')
  }

  claimPayload = withClaimItAttachmentFileName(claimPayload, existingClaim.claim_number)
  const { data: claim, error: claimError } = await updateNhisClaimWithSchemaFallback(id, claimPayload)

  if (claimError) throw claimError

  const { error: deleteError } = await supabase
    .from('nhis_claim_medicines')
    .delete()
    .eq('claim_id', id)

  if (deleteError) throw deleteError

  await insertNhisClaimMedicineRows(medicineRows.map((row) => ({ ...row, claim_id: id })))

  const { error: deleteServicesError } = await supabase
    .from('nhis_claim_services')
    .delete()
    .eq('claim_id', id)

  if (deleteServicesError && !isMissingClaimServicesTable(deleteServicesError)) throw deleteServicesError

  await insertNhisClaimServiceRows(toNhisClaimServiceRows(id, tariffServices, claimData))

  if (claimData.patientId && (claimData.memberNo || claimData.hin)) {
    const { error: patientUpdateError } = await supabase
      .from('patients')
      .update({
        nhis_member_no: memberNo || null,
        nhis_hin: normalizeText(claimData.hin) || null,
        insurance_provider: 'NHIS',
        insurance_id: normalizeText(memberNo || claimData.hin) || null,
      })
      .eq('id', claimData.patientId)

    if (patientUpdateError) throwFriendlyNhisPatientError(patientUpdateError)
  }

  await tryLogAuditEvent({
    eventType: 'nhis_claim.corrected',
    entityType: 'nhis_claims',
    entityId: claim.id,
    action: 'update',
    details: {
      claim_number: claim.claim_number,
      patient_name: `${claimData.surname} ${claimData.otherNames || ''}`.trim(),
      medicine_count: medicines.length,
      service_count: tariffServices.length,
      total_amount: totalAmount,
    },
  })

  return claim
}

const recordNhisPaidLedgerEntry = async (id, actorId = null) => {
  const { data: claim, error } = await supabase
    .from('nhis_claims')
    .select(`
      id,
      organization_id,
      branch_id,
      total_amount,
      created_by,
      nhis_claim_payments (paid_amount)
    `)
    .eq('id', id)
    .single()

  if (error) throw error

  const approvedAmount = Number(claim.total_amount || 0)
  const totalPaid = (claim.nhis_claim_payments || []).reduce(
    (sum, payment) => sum + Number(payment.paid_amount || 0),
    0
  )
  const outstanding = Math.max(0, approvedAmount - totalPaid)
  if (outstanding <= 0) {
    return
  }

  const { error: paymentError } = await supabase
    .from('nhis_claim_payments')
    .insert([{
      organization_id: claim.organization_id,
      branch_id: claim.branch_id || null,
      nhis_claim_id: claim.id,
      insurer_name: 'NHIS',
      approved_amount: approvedAmount,
      paid_amount: outstanding,
      payment_date: new Date().toISOString().split('T')[0],
      payment_method: 'bank_transfer',
      notes: 'Marked paid from NHIS claims.',
      created_by: actorId || claim.created_by || null,
    }])

  if (paymentError) throw paymentError
}

export const updateNhisClaimStatus = async (id, status, rejectionReason = '', actorId = null) => {
  const validStatuses = ['served', 'submitted', 'paid', 'rejected']
  if (!validStatuses.includes(status)) throw new Error('Invalid claim status.')

  const updatePayload = {
    status,
    updated_at: new Date().toISOString(),
    ...(status === 'rejected' && rejectionReason
      ? { rejection_reason: rejectionReason }
      : {}),
  }

  const updateLocalStatus = async () =>
    await updateBranchRecord('nhis/claims', id, updatePayload)

  const updateCloudStatus = async () => {
    if (status === 'paid') {
      await recordNhisPaidLedgerEntry(id, actorId)
    }

    const { data, error } = await supabase
      .from('nhis_claims')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    await tryLogAuditEvent({
      eventType: 'nhis_claim.status_updated',
      entityType: 'nhis_claims',
      entityId: id,
      action: 'update_status',
      details: { status, rejection_reason: rejectionReason || null },
    })

    return data
  }

  return await routeWrite({
    label: 'NHIS claim status',
    local: updateLocalStatus,
    cloud: updateCloudStatus,
  })
}

const markNhisClaimsSubmittedByRoute = async (claims) => {
  const servedClaims = claims.filter((claim) => claim.status === 'served')
  const servedClaimIds = servedClaims.map((claim) => claim.id).filter(Boolean)
  if (!servedClaimIds.length) return

  const submittedPayload = {
    status: 'submitted',
    updated_at: new Date().toISOString(),
  }

  const markLocalSubmitted = async () => {
    await Promise.all(
      servedClaims.map((claim) => updateBranchRecord('nhis/claims', claim.id, submittedPayload))
    )
  }

  const markCloudSubmitted = async () => {
    const { error } = await supabase
      .from('nhis_claims')
      .update(submittedPayload)
      .in('id', servedClaimIds)

    if (error) throw error
  }

  await routeWrite({
    label: 'NHIS submitted claim status',
    local: markLocalSubmitted,
    cloud: markCloudSubmitted,
  })
}

// ─── Batch Export ──────────────────────────────────────────────────────────────

/**
 * Normalizes monthly or custom-period export filters for NHIA submission.
 */
export const normalizeNhisExportPeriod = (options = {}) => {
  const requestedMode = normalizeText(options.mode || options.exportMode || '').toLowerCase()
  const mode = requestedMode === 'custom'
    ? 'custom'
    : ['partial', 'month-to-date', 'month_to_date', 'mtd'].includes(requestedMode)
      ? 'partial'
      : 'month'
  const generatedAt = options.generatedAt || new Date().toISOString()

  if (mode === 'custom') {
    const fromDate = normalizeText(options.fromDate || options.dateFrom || options.periodFrom)
    const toDate = normalizeText(options.toDate || options.dateTo || options.periodTo)

    if (!isValidIsoDate(fromDate) || !isValidIsoDate(toDate)) {
      throw new Error('Custom export period must include valid From and To dates.')
    }
    if (fromDate > toDate) {
      throw new Error('Custom export From date cannot be after To date.')
    }

    return {
      mode,
      yearMonth: '',
      fromDate,
      toDate,
      label: `${fromDate} to ${toDate}`,
      fileTag: `${fromDate.replace(/-/g, '')}-${toDate.replace(/-/g, '')}`,
    }
  }

  if (mode === 'partial') {
    const toDate = normalizeText(options.toDate || options.dateTo || options.periodTo || generatedAt.slice(0, 10))
    if (!isValidIsoDate(toDate)) {
      throw new Error('Partial export period must include a valid Up To date.')
    }
    const yearMonth = toDate.slice(0, 7)
    const fromDate = `${yearMonth}-01`

    return {
      mode,
      yearMonth,
      fromDate,
      toDate,
      label: `${fromDate} to ${toDate}`,
      fileTag: `${fromDate.replace(/-/g, '')}-${toDate.replace(/-/g, '')}`,
    }
  }

  const yearMonth = normalizeText(options.yearMonth || options.month || generatedAt.slice(0, 7))
  if (!YEAR_MONTH_RE.test(yearMonth)) throw new Error('Month must be in YYYY-MM format.')

  return {
    mode,
    yearMonth,
    fromDate: `${yearMonth}-01`,
    toDate: getMonthEndDate(yearMonth),
    label: yearMonth,
    fileTag: yearMonth.replace(/-/g, ''),
  }
}

export const getNhisClaimsForPeriod = async (periodOptions = {}) => {
  const period = normalizeNhisExportPeriod(periodOptions)

  if (shouldUseBranchServer()) {
    const rows = await listBranchRecords(
      'nhis/claims',
      period.mode === 'month'
        ? { month: period.yearMonth, limit: 5000 }
        : { fromDate: period.fromDate, toDate: period.toDate, limit: 5000 }
    )
    return period.mode === 'month'
      ? rows
      : rows.filter((claim) => claimMatchesExportPeriod(claim, period))
  }

  const buildQuery = (select = NHIS_CLAIM_MEDICINES_SELECT) => {
    let query = supabase
      .from('nhis_claims')
      .select(select)
      .order('created_at')

    if (period.mode === 'month') {
      query = query.eq('submission_month', period.yearMonth)
    } else {
      query = query
        .gte('service_date_from', period.fromDate)
        .lte('service_date_from', period.toDate)
    }

    return query
  }

  let { data, error } = await buildQuery()
  if (error && isMissingOptionalClaimMedicineColumn(error)) {
    ;({ data, error } = await buildQuery(NHIS_CLAIM_MEDICINES_SELECT_BASIC))
  }

  if (error) throw error
  return await hydrateNhisClaimsForUi(data || [])
}

/**
 * Returns all claims for a given month (YYYY-MM) ready for NHIA submission.
 */
export const getNhisClaimsForMonth = async (yearMonth) =>
  await getNhisClaimsForPeriod({ mode: 'month', yearMonth })

export const getNhisClaimForSubmission = async (id) => {
  if (!id) throw new Error('NHIS claim ID is required.')

  if (shouldUseBranchServer()) {
    const rows = await listBranchRecords('nhis/claims', { id, limit: 1 })
    const claim = rows?.[0]
    if (!claim) throw new Error('NHIS claim not found.')
    return claim
  }

  const loadClaim = async (select = NHIS_CLAIM_MEDICINES_SELECT) =>
    await supabase
      .from('nhis_claims')
      .select(select)
      .eq('id', id)
      .single()

  let { data, error } = await loadClaim()
  if (error && isMissingOptionalClaimMedicineColumn(error)) {
    ;({ data, error } = await loadClaim(NHIS_CLAIM_MEDICINES_SELECT_BASIC))
  }
  if (error) throw error
  return (await hydrateNhisClaimsForUi([data]))[0]
}

const normalizeClaimItExportFormat = (format = 'cxf') => {
  const normalized = normalizeText(format).toLowerCase()
  return CLAIMIT_EXPORT_FORMATS.includes(normalized) ? normalized : 'cxf'
}

const toClaimItDate = (value) => normalizeText(value).slice(0, 10)

const toClaimItDateTime = (value = new Date().toISOString()) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return normalizeText(value).replace('T', ' ').slice(0, 19)
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const toClaimItAmount = (value, decimals = 2) =>
  Number(value || 0).toFixed(decimals)

const toClaimItGender = (value) => {
  const text = normalizeText(value).toLowerCase()
  if (text.startsWith('f')) return 'F'
  if (text.startsWith('m')) return 'M'
  return normalizeText(value).toUpperCase()
}

const getClaimItAge = (dateOfBirth, serviceDate) => {
  const dob = new Date(`${toClaimItDate(dateOfBirth)}T00:00:00Z`)
  const dosp = new Date(`${toClaimItDate(serviceDate)}T00:00:00Z`)
  if (Number.isNaN(dob.getTime()) || Number.isNaN(dosp.getTime())) return ''
  const years = (dosp.getTime() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
  return Math.max(years, 0).toFixed(2)
}

const getClaimItAgeGroup = (dateOfBirth, serviceDate) => {
  const age = Number(getClaimItAge(dateOfBirth, serviceDate))
  if (!Number.isFinite(age)) return ''
  return age < 12 ? 'C' : 'A'
}

const claimItDigitsOnly = (value) => normalizeText(value).replace(/\D/g, '')

const splitClaimItCredentialCode = (credentialCode = '') => {
  const parts = normalizeText(credentialCode).split('-')
  return {
    agencyCode: parts[0] || '',
    regionCode: parts[1] || '',
    districtCode: parts[2] || '',
    ownershipCode: parts[3] || '',
    sequenceNumber: parts[4] || '',
    facilityTypeCode: parts[5] || '',
    prescriptionLevelCode: parts[6] || '',
    cateringStatusCode: parts[7] || '',
    effectiveDateCode: parts[8] || '',
  }
}

const getClaimItEffectiveDate = (credentialCode = '') => {
  const { effectiveDateCode } = splitClaimItCredentialCode(credentialCode)
  if (/^\d{6}$/.test(effectiveDateCode)) {
    return `20${effectiveDateCode.slice(4, 6)}-${effectiveDateCode.slice(2, 4)}-${effectiveDateCode.slice(0, 2)}`
  }
  return ''
}

const getClaimItProviderCode = (payload = {}) => {
  const providerNumber = normalizeText(payload.providerNumber)
  if (providerNumber) return providerNumber
  const credential = getClaimItCredentialCode(payload)
  const { agencyCode, regionCode, sequenceNumber } = splitClaimItCredentialCode(credential)
  return [agencyCode, regionCode, sequenceNumber].filter(Boolean).join('-')
}

const getClaimItPrescriptionLevel = (payload = {}) => {
  const credential = getClaimItCredentialCode(payload)
  const { prescriptionLevelCode } = splitClaimItCredentialCode(credential)
  // ✅ NHIA CONFIG PATCH START
  return prescriptionLevelCode || resolveClaimItPharmacyFacilityLevel(payload) || ''
  // ✅ NHIA CONFIG PATCH END
}

const getClaimItFacilityType = (payload = {}) => {
  // ✅ NHIA CONFIG PATCH START
  const facilityType = getNhiaFacilityType(payload).toLowerCase()
  const description = normalizeText(payload.providerTypeDescription || payload.facilityType).toLowerCase()
  if (facilityType.includes('chemical')) return 'CHS'
  if (facilityType.includes('maternity')) return 'MAT'
  if (facilityType.includes('clinic')) return 'CL'
  if (facilityType.includes('pharmacy') || description.includes('pharmacy')) return 'PHC'
  // ✅ NHIA CONFIG PATCH END
  if (description.includes('hospital')) return 'HOSP'
  if (description.includes('clinic')) return 'CL'
  return 'PHC'
}

const getClaimItClaimType = (payload = {}) =>
  normalizeOrganizationType(payload.organizationType) === 'hospital' ? 'INP' : 'NHIS'

const getClaimItServiceType = (payload = {}) =>
  normalizeOrganizationType(payload.organizationType) === 'hospital' ? 'INP' : 'PHC'

const CLAIM_IT_MONTH_TAGS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

const sanitizeClaimItFilenameText = (value, fallback) =>
  (normalizeText(value) || fallback)
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()

const getClaimItGuid = (seed = '', salt = '') => {
  const randomId = globalThis.crypto?.randomUUID?.() || String(Date.now())
  const source = `${seed || randomId}-${salt}`
  let output = ''
  for (let block = 0; output.length < 40; block += 1) {
    let hash = (2166136261 ^ block) >>> 0
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index) + block + index
      hash ^= code
      hash = Math.imul(hash, 16777619) >>> 0
    }
    output += hash.toString(16).padStart(8, '0')
  }
  return output.slice(0, 40)
}

const getClaimItFileMonthTag = (dateValue) => {
  const date = new Date(`${toClaimItDate(dateValue)}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return 'CLAIMS'
  return `${CLAIM_IT_MONTH_TAGS[date.getUTCMonth()]}${date.getUTCFullYear()}`
}

const buildClaimItCxfFileName = (payload) => {
  const providerId = getClaimItProviderCode(payload)
  const providerTag = normalizeText(providerId).replace(/[^a-z0-9]/gi, '') || 'PROVIDER'
  const facilityName = sanitizeClaimItFilenameText(
    payload.facilityName || payload.providerTypeDescription,
    'HEALTHFLOW FACILITY'
  )
  const exportId = getClaimItGuid(
    `${providerTag}-${payload.periodFrom}-${payload.periodTo}-${payload.claimCount}-${payload.totalAmount}`,
    'file'
  ).slice(0, 12).toUpperCase()

  return `${getClaimItFileMonthTag(payload.periodFrom)}__${exportId} [${providerTag}] (${facilityName})_${payload.periodFrom}-${payload.periodTo}.cxf`
}

const parseDirectionsNumber = (value, fallback = '1.00') => {
  const match = normalizeText(value).match(/(\d+(?:\.\d+)?)/)
  return Number(match?.[1] || fallback).toFixed(2)
}

const parseFrequencyValue = (value) => {
  const text = normalizeText(value).toLowerCase()
  if (/\b(qid|qds|four)\b/.test(text)) return '4.00'
  if (/\b(tid|tds|three)\b/.test(text)) return '3.00'
  if (/\b(bid|bd|twice|two)\b/.test(text)) return '2.00'
  if (/\b(od|daily|once)\b/.test(text)) return '1.00'
  return parseDirectionsNumber(text, '1.00')
}

const CLAIM_IT_DOCTRINE_MIGRATIONS = [
  'DoctrineMigrations\\Version20240629224941',
  'DoctrineMigrations\\Version20240125165114',
  'DoctrineMigrations\\Version20231109002747',
  'DoctrineMigrations\\Version20231023180333',
  'DoctrineMigrations\\Version20230607141151',
  'DoctrineMigrations\\Version20230417132348',
  'DoctrineMigrations\\Version20220627160453',
  'DoctrineMigrations\\Version20210723124850',
  'DoctrineMigrations\\Version20210410200656',
  'DoctrineMigrations\\Version20200423115101',
  'DoctrineMigrations\\Version20190813200553',
  'DoctrineMigrations\\Version20170814193015',
  'DoctrineMigrations\\Version20170709122733',
  'DoctrineMigrations\\Version20170617124727',
  'DoctrineMigrations\\Version20170611184415',
  'DoctrineMigrations\\Version20170430000428',
  'DoctrineMigrations\\Version20170122224753',
  'DoctrineMigrations\\Version20170101145643',
  'DoctrineMigrations\\Version20170101130118',
  'DoctrineMigrations\\Version20161218200856',
  'DoctrineMigrations\\Version20161120224705',
  'DoctrineMigrations\\Version20161106145044',
  'DoctrineMigrations\\Version20161007193233',
  'DoctrineMigrations\\Version20160917202912',
  'DoctrineMigrations\\Version20160916193613',
  'DoctrineMigrations\\Version20160916193612',
  'DoctrineMigrations\\Version20160901033143',
  'DoctrineMigrations\\Version20160901033142',
]

const CLAIM_IT_APP_VERSION = {
  version: 'Head',
  build: '2025053123',
  type: 'head',
  sha1: 'bebe76e96864d0f25d3514e5916816aadc34cff4',
  client: '1.0.0.3',
  mode: 'standalone',
}

const getClaimItExpiryDate = (effectiveDate, generatedAt) => {
  const base = new Date(`${toClaimItDate(effectiveDate || generatedAt)}T00:00:00Z`)
  if (Number.isNaN(base.getTime())) return '2099-12-31'
  base.setUTCFullYear(base.getUTCFullYear() + 1)
  base.setUTCDate(base.getUTCDate() - 1)
  return base.toISOString().slice(0, 10)
}

const getClaimItProviderLevelId = (claimRow = {}) =>
  [
    claimRow.ownershipTypeCode,
    claimRow.facilityTypeCode,
    claimRow.cateringStatusCode,
  ].filter(Boolean).join('-')

const getClaimItDbStruct = () => ({
  accreditations: {
    uid: 'varchar(50)',
    prescriptionLevelID: 'varchar(255)',
    facilityName: 'varchar(255)',
    dateGenerated: 'date',
    expiryDate: 'date',
    isTemporary: 'tinyint(1)',
    meta: 'mediumtext',
    effectiveDate: 'date',
    providerID: 'varchar(255)',
    ccd_agencyCode: 'varchar(255)',
    ccd_regionCode: 'varchar(255)',
    ccd_districtCode: 'varchar(255)',
    ccd_ownershipCode: 'varchar(255)',
    ccd_sequenceNumber: 'varchar(255)',
    ccd_facilityTypeCode: 'varchar(255)',
    ccd_prescriptionLevelCode: 'varchar(255)',
    ccd_cateringStatusCode: 'varchar(255)',
    ccd_effectiveDate: 'date',
    accred_effectiveDate: 'date',
    accred_providerID: 'varchar(255)',
    facilityTypeCode: 'varchar(255)',
    ownershipTypeCode: 'varchar(255)',
    cateringStatusCode: 'varchar(255)',
  },
  attachmentdata: {
    _data_id: 'int(11)',
    _attach_id: 'varchar(40)',
    data: 'longblob',
  },
  attachments: {
    attach_id: 'varchar(40)',
    _claim_id: 'varchar(60)',
    type: 'varchar(255)',
    fileType: 'varchar(255)',
    comments: 'varchar(255)',
  },
  attendanceentries: {
    _entry_id: 'int(11)',
    _claim_id: 'varchar(60)',
    claimType: 'varchar(255)',
    attdate: 'date',
    ccc: 'varchar(255)',
  },
  attendances: {
    attdate: 'date',
    ccc: 'varchar(255)',
    expiryDate: 'datetime',
    data: 'longtext',
    claimType: 'varchar(255)',
    memberNo: 'varchar(255)',
    cardSerialNo: 'varchar(255)',
    surname: 'varchar(255)',
    otherNames: 'varchar(255)',
    dateOfBirth: 'date',
    gender: 'varchar(255)',
    hospitalRecNo: 'varchar(255)',
    isDependant: 'tinyint(1)',
    generatedOn: 'datetime',
    generatedByname: 'varchar(255)',
    generatedByuserID: 'varchar(255)',
    generatedByrole: 'varchar(255)',
    addedOn: 'datetime',
    addedByname: 'varchar(255)',
    addedByuserID: 'varchar(255)',
    addedByrole: 'varchar(255)',
    modifiedOn: 'datetime',
    modifiedByname: 'varchar(255)',
    modifiedByuserID: 'varchar(255)',
    modifiedByrole: 'varchar(255)',
  },
  cateringstatuses: {
    description: 'varchar(255)',
    accredCode: 'varchar(4)',
    statusCode: 'varchar(32)',
  },
  claims: {
    guid: 'varchar(60)',
    isException: 'tinyint(1)',
    claimCheckCode: 'varchar(255)',
    preAuthorizationCodes: 'varchar(255)',
    physicianID: 'varchar(255)',
    specialtyAttended: 'varchar(6)',
    totalCost: 'decimal(10,2)',
    procCost: 'decimal(10,2)',
    diagCost: 'decimal(10,2)',
    inveCost: 'decimal(10,2)',
    medCost: 'decimal(10,2)',
    principalGDRG: 'varchar(255)',
    alternativeGDRG: 'varchar(255)',
    autoSummaryGDRG: 'varchar(255)',
    autoSummaryCost: 'decimal(10,2)',
    memberAge: 'decimal(10,2)',
    memberAgeGroup: 'varchar(1)',
    isImported: 'tinyint(1)',
    refID: 'varchar(255)',
    medVersion: 'varchar(255)',
    servVersion: 'varchar(255)',
    policyVersion: 'varchar(255)',
    isDirty: 'tinyint(1)',
    status: 'varchar(255)',
    submissionTime: 'datetime',
    extraData: 'longtext',
    addedOn: 'datetime',
    addedByname: 'varchar(255)',
    addedByuserID: 'varchar(255)',
    addedByrole: 'varchar(255)',
    modifiedOn: 'datetime',
    modifiedByname: 'varchar(255)',
    modifiedByuserID: 'varchar(255)',
    modifiedByrole: 'varchar(255)',
    signedOn: 'datetime',
    signedByname: 'varchar(255)',
    signedByuserID: 'varchar(255)',
    signedByrole: 'varchar(255)',
    memberNo: 'varchar(255)',
    cardSerialNo: 'varchar(255)',
    surname: 'varchar(255)',
    otherNames: 'varchar(255)',
    dateOfBirth: 'date',
    gender: 'varchar(255)',
    hospitalRecNo: 'varchar(255)',
    isDependant: 'tinyint(1)',
    prescriptionLevelID: 'varchar(255)',
    credentialCode: 'varchar(255)',
    accred_effectiveDate: 'date',
    accred_providerID: 'varchar(255)',
    accred_ccd_agencyCode: 'varchar(255)',
    accred_ccd_regionCode: 'varchar(255)',
    accred_ccd_districtCode: 'varchar(255)',
    accred_ccd_ownershipCode: 'varchar(255)',
    accred_ccd_sequenceNumber: 'varchar(255)',
    accred_ccd_facilityTypeCode: 'varchar(255)',
    accred_ccd_prescriptionLevelCode: 'varchar(255)',
    accred_ccd_cateringStatusCode: 'varchar(255)',
    accred_ccd_effectiveDate: 'date',
    facilityTypeCode: 'varchar(255)',
    ownershipTypeCode: 'varchar(255)',
    cateringStatusCode: 'varchar(255)',
    refclaimCheckCode: 'varchar(255)',
    reffacilityID: 'varchar(255)',
    reffacilityName: 'varchar(255)',
    minDOSP: 'date',
    maxDOSP: 'date',
    serviceProvisionDates: 'varchar(750)',
    specialtiesAttended: 'varchar(750)',
    durationOfSpell: 'int(11)',
    typeOfService: 'varchar(255)',
    isUnbundled: 'varchar(255)',
    includesPharmacy: 'varchar(255)',
    typeOfAttendance: 'varchar(255)',
    serviceOutcome: 'varchar(255)',
    claimType: 'varchar(255)',
  },
  comments: {
    _entry_id: 'int(11)',
    _claim_id: 'varchar(60)',
    comment: 'mediumtext',
    createdOn: 'datetime',
    createdByname: 'varchar(255)',
    createdByuserID: 'varchar(255)',
    createdByrole: 'varchar(255)',
  },
  contracts: {
    scheme: 'varchar(255)',
    facilityName: 'varchar(255)',
    dateGenerated: 'date',
    expiryDate: 'date',
    isTemporary: 'tinyint(1)',
    data: 'longtext',
    meta: 'mediumtext',
    effectiveDate: 'date',
    providerID: 'varchar(255)',
    contractCode: 'varchar(255)',
  },
  diseases: {
    _id: 'int(11)',
    icd10: 'varchar(255)',
    gender: 'varchar(255)',
    ageGroup: 'varchar(255)',
    sanitizedDescription: 'varchar(255)',
    description: 'varchar(255)',
  },
  doctrine_migration_versions: {
    version: 'varchar(1024)',
    executed_at: 'datetime',
    execution_time: 'int(11)',
  },
  facilitytypes: {
    description: 'varchar(255)',
    accredCode: 'varchar(4)',
    typeCode: 'varchar(32)',
  },
  gdrgs: {
    code: 'varchar(255)',
    description: 'varchar(255)',
    MDCCode: 'varchar(255)',
    GDRGNo: 'varchar(255)',
    split: 'varchar(255)',
    prefix: 'varchar(255)',
    suffix: 'varchar(255)',
  },
  gdrgs_icd10s: {
    code: 'varchar(255)',
    icd10: 'varchar(255)',
  },
  icd10s: {
    icd10: 'varchar(255)',
    description: 'varchar(255)',
  },
  mdcs: {
    code: 'varchar(255)',
    description: 'varchar(255)',
  },
  medicineclasses: {
    _entry_id: 'int(11)',
    _med_code: 'varchar(255)',
    major: 'varchar(255)',
    minor: 'varchar(255)',
  },
  medicineentries: {
    _entry_id: 'int(11)',
    _claim_id: 'varchar(60)',
    medicineCode: 'varchar(255)',
    serviceDate: 'date',
    cost: 'decimal(10,4)',
    qty: 'varchar(255)',
    dispensedQty: 'varchar(255)',
    dispensaryUnit: 'varchar(150)',
    extraDirections: 'varchar(255)',
    unparsed: 'varchar(255)',
    dose_value: 'decimal(10,2)',
    dose_unit: 'varchar(255)',
    frequency_value: 'decimal(10,2)',
    frequency_unit: 'varchar(255)',
    frequency_desc: 'varchar(255)',
    duration_value: 'decimal(10,2)',
    duration_unit: 'varchar(255)',
    duration_desc: 'varchar(255)',
  },
  medicineprices: {
    uid: 'varchar(255)',
    price: 'decimal(10,2)',
    pricingUnit: 'varchar(255)',
    maxDosage: 'decimal(10,0)',
    flags: 'varchar(750)',
    prescriptionUnits: 'varchar(750)',
    dispensaryUnits: 'varchar(750)',
    buildVersion: 'varchar(255)',
    effectiveDate: 'date',
    prescriptionLevelCode: 'varchar(255)',
    medicineCode: 'varchar(255)',
  },
  medicines: {
    code: 'varchar(255)',
    description: 'varchar(255)',
  },
  ownerships: {
    description: 'varchar(255)',
    accredCode: 'varchar(4)',
    ownershipCode: 'varchar(32)',
  },
  policies: {
    uid: 'varchar(40)',
    description: 'varchar(255)',
    buildVersion: 'varchar(255)',
    effectiveDate: 'date',
    type: 'varchar(32)',
  },
  policyrules: {
    _id: 'int(11)',
    _policy_id: 'varchar(40)',
    position: 'int(11)',
    name: 'varchar(255)',
    outcome: 'varchar(255)',
    version: 'varchar(255)',
    runAt: 'varchar(255)',
  },
  prescribersfordays: {
    _id: 'int(11)',
    day: 'date',
    name: 'varchar(250)',
    role: 'varchar(32)',
  },
  prescriptionlevels: {
    rank: 'decimal(6,1)',
    description: 'varchar(255)',
    levelCode: 'varchar(4)',
  },
  providerlevels: {
    uid: 'varchar(32)',
    description: 'varchar(255)',
    facilityTypeCode: 'varchar(255)',
    ownershipTypeCode: 'varchar(255)',
    cateringStatusCode: 'varchar(255)',
  },
  rules: {
    uid: 'varchar(120)',
    codeScript: 'longtext',
    scope: 'varchar(255)',
    description: 'longtext',
    category: 'varchar(255)',
    name: 'varchar(255)',
    outcome: 'varchar(255)',
    version: 'varchar(255)',
    runAt: 'varchar(255)',
  },
  serviceentries: {
    _entry_id: 'int(11)',
    _claim_id: 'varchar(60)',
    gdrgCode: 'varchar(255)',
    cost: 'decimal(10,4)',
    entryType: 'varchar(255)',
    serviceDate: 'date',
    icd10: 'varchar(255)',
    description: 'varchar(255)',
    suggestedICD10: 'varchar(255)',
  },
  servicetariffs: {
    uid: 'varchar(255)',
    cost: 'decimal(10,2)',
    flags: 'varchar(750)',
    buildVersion: 'varchar(255)',
    effectiveDate: 'date',
    facilityTypeCode: 'varchar(255)',
    ownershipTypeCode: 'varchar(255)',
    cateringStatusCode: 'varchar(255)',
    MDCCode: 'varchar(255)',
    GDRGNo: 'varchar(255)',
    split: 'varchar(255)',
    prefix: 'varchar(255)',
    suffix: 'varchar(255)',
  },
  summaryitems: {
    _entry_id: 'int(11)',
    _claim_id: 'varchar(60)',
    type: 'varchar(255)',
    ordinal: 'int(11)',
    description: 'varchar(255)',
    amount: 'decimal(10,4)',
  },
  systemupdates: {
    uid: 'varchar(32)',
    installDate: 'date',
    hash: 'varchar(32)',
    buildVersion: 'varchar(255)',
    updateType: 'varchar(255)',
    updateVersion: 'varchar(255)',
  },
  users: {
    username: 'varchar(32)',
    name: 'varchar(250)',
    role: 'varchar(32)',
    password: 'varchar(255)',
    status: 'varchar(1)',
    officesanitizedName: 'varchar(255)',
    officename: 'varchar(255)',
  },
  validation_results: {
    _id: 'int(11)',
    _validation_id: 'varchar(60)',
    ruleID: 'varchar(255)',
    info: 'varchar(255)',
    entryID: 'varchar(255)',
  },
  validation_zclaims: {
    _id: 'int(11)',
    _validation_id: 'varchar(60)',
    serializedClaim: 'longblob',
    isCompressed: 'tinyint(1)',
  },
  validations: {
    _id: 'varchar(60)',
    s_id: 'int(11)',
    claimID: 'varchar(255)',
    policyID: 'varchar(255)',
    runTime: 'datetime',
    outcome: 'varchar(255)',
    isSavedClaim: 'tinyint(1)',
    memberNo: 'varchar(255)',
    firstDOSP: 'date',
    lastDOSP: 'date',
    runOn: 'datetime',
    runByname: 'varchar(255)',
    runByuserID: 'varchar(255)',
    runByrole: 'varchar(255)',
  },
})

const getClaimItAccreditationRows = (payload, rows) => {
  const credentialCode = getClaimItCredentialCode(payload)
  if (!credentialCode) return []

  const claimRow = rows.claims[0] || {}
  const effectiveDate = getClaimItEffectiveDate(credentialCode)
  return [{
    accred_effectiveDate: effectiveDate,
    accred_providerID: getClaimItProviderCode(payload),
    facilityTypeCode: claimRow.facilityTypeCode || getClaimItFacilityType(payload),
    ownershipTypeCode: claimRow.ownershipTypeCode || 'PVT',
    cateringStatusCode: claimRow.cateringStatusCode || 'CE',
    prescriptionLevelID: claimRow.prescriptionLevelID || getClaimItPrescriptionLevel(payload),
    facilityName: normalizeText(payload.facilityName) || 'HealthFlow Facility',
    dateGenerated: toClaimItDate(payload.createdAt),
    expiryDate: getNhiaAccreditationExpiryDate(payload) || getClaimItExpiryDate(effectiveDate, payload.createdAt),
    credentialCode,
  }]
}

const CLAIM_IT_PARTIAL_EXPORT_TABLES = [
  'claims',
  'serviceentries',
  'medicineentries',
  'summaryitems',
  'attachmentdata',
  'attachments',
  'comments',
  'validations',
  'validation_results',
  'validation_zclaims',
  'prescribersfordays',
]

const CLAIM_IT_REQUIRED_ROW_TABLES = new Set(['claims', 'validations', 'validation_zclaims'])

const uniqueClaimItRows = (rows, getKey) => {
  const seen = new Set()
  return rows.filter((row) => {
    const key = getKey(row)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const sumClaimItRows = (rows, claimId) =>
  rows
    .filter((row) => row._claim_id === claimId)
    .reduce((sum, row) => sum + Number(row.cost || row.amount || 0), 0)

const getClaimItPrescriberRows = (rows) =>
  uniqueClaimItRows(
    rows.claims
      .filter((claim) => normalizeText(claim.physicianID))
      .map((claim, index) => ({
        _id: String((index + 1) * 70000 + 1),
        day: claim.minDOSP,
        name: claim.physicianID,
        role: 'Prescriber',
      })),
    (row) => `${row.day}:${row.name}`
  )

const createClaimItDiagnostic = (level, code, message, details = {}) => ({
  level,
  code,
  message,
  details,
})

const validateClaimItRelationalBundleData = (data, { strict = true } = {}) => {
  const diagnostics = []
  const dbStruct = data._dbstruct || {}
  const claimIds = new Set((data.claims || []).map((claim) => claim.guid))
  const attachmentIds = new Set((data.attachments || []).map((attachment) => attachment.attach_id))
  const validationIds = new Set((data.validations || []).map((validation) => validation._id))
  const tableCounts = Object.fromEntries(Object.entries(data).map(([table, value]) => [table, Array.isArray(value) ? value.length : null]))

  CLAIM_IT_PARTIAL_EXPORT_TABLES.forEach((table) => {
    if (!Array.isArray(data[table])) {
      diagnostics.push(createClaimItDiagnostic('error', 'missing_table', `Missing CLAIM-it table: ${table}`, { table }))
    } else if (CLAIM_IT_REQUIRED_ROW_TABLES.has(table) && !data[table].length) {
      diagnostics.push(createClaimItDiagnostic('warning', 'empty_table', `CLAIM-it table has no rows: ${table}`, { table }))
    }
    if (!dbStruct[table]) {
      diagnostics.push(createClaimItDiagnostic('error', 'schema_mismatch', `Missing _dbstruct entry for ${table}`, { table }))
    }
  })

  if (!normalizeText(data._meta?.providerLevel)) {
    diagnostics.push(createClaimItDiagnostic('error', 'empty_provider_level', 'CLAIM-it providerLevel cannot be empty.'))
  }
  if (!normalizeText(data._meta?.providerID) || !normalizeText(data._meta?.credentialCode)) {
    diagnostics.push(createClaimItDiagnostic('error', 'invalid_facility_mapping', 'CLAIM-it providerID and credentialCode are required.'))
  }
  if (!Array.isArray(data._meta?.accreditations) || !data._meta.accreditations.length) {
    diagnostics.push(createClaimItDiagnostic('error', 'missing_accreditation', 'CLAIM-it accreditation metadata is required.'))
  }

  ;(data.claims || []).forEach((claim) => {
    const lineTotal = sumClaimItRows(data.medicineentries || [], claim.guid) + sumClaimItRows(data.serviceentries || [], claim.guid)
    const summaryTotal = sumClaimItRows(data.summaryitems || [], claim.guid)
    const claimTotal = Number(claim.totalCost || 0)
    if (Math.abs(claimTotal - lineTotal) > 0.01 || Math.abs(claimTotal - summaryTotal) > 0.01) {
      diagnostics.push(createClaimItDiagnostic('error', 'invalid_totals', 'Claim totals do not match line and summary totals.', {
        claimID: claim.guid,
        claimTotal,
        lineTotal,
        summaryTotal,
      }))
    }
  })

  ;['medicineentries', 'serviceentries', 'summaryitems', 'attachments'].forEach((table) => {
    ;(data[table] || []).forEach((row) => {
      if (!claimIds.has(row._claim_id)) {
        diagnostics.push(createClaimItDiagnostic('error', 'orphaned_claim_reference', `${table} references a missing claim.`, {
          table,
          id: row._entry_id || row.attach_id,
          claimID: row._claim_id,
        }))
      }
    })
  })

  ;(data.attachmentdata || []).forEach((row) => {
    const attachment = (data.attachments || []).find((item) => item.attach_id === row._attach_id)
    if (!attachmentIds.has(row._attach_id)) {
      diagnostics.push(createClaimItDiagnostic('error', 'orphaned_attachment_reference', 'attachmentdata references a missing attachment.', {
        dataID: row._data_id,
        attachmentID: row._attach_id,
      }))
    }
    if (!(row.data instanceof Uint8Array) || row.data.length === 0) {
      diagnostics.push(createClaimItDiagnostic('error', 'missing_attachment_data', 'attachmentdata.data is missing or empty.', {
        dataID: row._data_id,
        attachmentID: row._attach_id,
      }))
    }
    if (attachment && normalizeText(attachment.fileType).toLowerCase() !== CLAIMIT_ATTACHMENT_FILE_TYPE) {
      diagnostics.push(createClaimItDiagnostic('error', 'invalid_attachment_file_type', 'CLAIM-it attachment fileType must be pdf.', {
        dataID: row._data_id,
        attachmentID: row._attach_id,
        fileType: attachment.fileType,
        claimitAttachmentOutputType: CLAIMIT_ATTACHMENT_FILE_TYPE,
      }))
    }
    if (row.data instanceof Uint8Array && row.data.length) {
      const embeddedPdfDetected = bytesStartWithPdfHeader(row.data)
      const embeddedJpegDetected = bytesStartWithJpegHeader(row.data)
      const embeddedDeflateDetected = row.data[0] === 0x78
      if ((!embeddedPdfDetected && !embeddedDeflateDetected) || embeddedJpegDetected) {
        diagnostics.push(createClaimItDiagnostic('error', 'invalid_attachment_binary', 'CLAIM-it attachment content must be PDF binary, not the original image file.', {
          dataID: row._data_id,
          attachmentID: row._attach_id,
          claimitAttachmentOutputType: CLAIMIT_ATTACHMENT_FILE_TYPE,
          embeddedPdfDetected,
          embeddedJpegDetected,
          embeddedDeflateDetected,
        }))
      }
    }
  })

  ;(data.validations || []).forEach((row) => {
    if (!claimIds.has(row.claimID)) {
      diagnostics.push(createClaimItDiagnostic('error', 'orphaned_validation_claim', 'validation references a missing claim.', {
        validationID: row._id,
        claimID: row.claimID,
      }))
    }
  })

  ;['validation_results', 'validation_zclaims'].forEach((table) => {
    ;(data[table] || []).forEach((row) => {
      if (!validationIds.has(row._validation_id)) {
        diagnostics.push(createClaimItDiagnostic('error', 'orphaned_validation_reference', `${table} references a missing validation.`, {
          table,
          validationID: row._validation_id,
        }))
      }
      if (table === 'validation_zclaims' && !(row.serializedClaim instanceof Uint8Array) && !row.serializedClaim) {
        diagnostics.push(createClaimItDiagnostic('error', 'missing_serialized_claim', 'validation_zclaims.serializedClaim is missing.', {
          validationID: row._validation_id,
        }))
      }
    })
  })

  const errors = diagnostics.filter((diagnostic) => diagnostic.level === 'error')
  if (strict && errors.length) {
    const message = errors.slice(0, 5).map((diagnostic) => diagnostic.message).join('; ')
    throw new Error(`Strict CLAIM-it export validation failed: ${message}`)
  }
  return { diagnostics, tableCounts, ...getClaimItAttachmentExportDiagnostic(data, data._attachmentDiagnostics || []) }
}

const getClaimItAttachmentExportDiagnostic = (data = {}, attachmentDiagnostics = []) => {
  const attachmentDataRows = data.attachmentdata || []
  const attachmentRows = data.attachments || []
  const hasAttachments = attachmentDataRows.length > 0
  const allFileTypesPdf = attachmentRows.every((attachment) =>
    normalizeText(attachment.fileType).toLowerCase() === CLAIMIT_ATTACHMENT_FILE_TYPE
  )
  const embeddedPdfDetected = attachmentDiagnostics.length
    ? attachmentDiagnostics.every((diagnostic) => diagnostic.attachmentDecodedStartsWithPdf)
    : hasAttachments && attachmentDataRows.every((row) => row.data instanceof Uint8Array && bytesStartWithPdfHeader(row.data))
  const embeddedJpegDetected = attachmentDataRows.some((row) =>
    row.data instanceof Uint8Array && bytesStartWithJpegHeader(row.data)
  )
  const firstDiagnostic = attachmentDiagnostics[0] || {}

  return {
    claimitAttachmentOutputType: allFileTypesPdf ? CLAIMIT_ATTACHMENT_FILE_TYPE : 'invalid',
    embeddedPdfDetected,
    embeddedPdfHeaderDetected: Boolean(firstDiagnostic.embeddedPdfHeaderDetected || embeddedPdfDetected),
    embeddedJpegDetected,
    attachmentBase64Length: firstDiagnostic.attachmentBase64Length || 0,
    attachmentDecodedStartsWithPdf: Boolean(firstDiagnostic.attachmentDecodedStartsWithPdf || embeddedPdfDetected),
    attachmentMimeType: firstDiagnostic.attachmentMimeType || CLAIMIT_ATTACHMENT_MIME_TYPE,
    attachmentFileType: firstDiagnostic.attachmentFileType || CLAIMIT_ATTACHMENT_FILE_TYPE,
  }
}

const logClaimItExportDiagnostics = ({
  diagnostics,
  tableCounts,
  claimitAttachmentOutputType = CLAIMIT_ATTACHMENT_FILE_TYPE,
  embeddedPdfDetected = false,
  embeddedPdfHeaderDetected = false,
  embeddedJpegDetected = false,
  attachmentBase64Length = 0,
  attachmentDecodedStartsWithPdf = false,
  attachmentMimeType = CLAIMIT_ATTACHMENT_MIME_TYPE,
  attachmentFileType = CLAIMIT_ATTACHMENT_FILE_TYPE,
}) => {
  const errors = diagnostics.filter((diagnostic) => diagnostic.level === 'error')
  const warnings = diagnostics.filter((diagnostic) => diagnostic.level === 'warning')
  const payload = {
    tableCounts,
    claimitAttachmentOutputType,
    embeddedPdfDetected,
    embeddedPdfHeaderDetected,
    embeddedJpegDetected,
    attachmentBase64Length,
    attachmentDecodedStartsWithPdf,
    attachmentMimeType,
    attachmentFileType,
    errors: errors.map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message, details: diagnostic.details })),
    warnings: warnings.map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message, details: diagnostic.details })),
  }
  if (errors.length) {
    console.error('[CLAIM-it export diagnostics]', payload)
  } else if (warnings.length) {
    console.warn('[CLAIM-it export diagnostics]', payload)
  } else {
    console.info('[CLAIM-it export diagnostics]', payload)
  }
}
// ✅ FINAL CLAIMIT RELATIONAL FIX END
// ✅ CLAIMIT SAVE FIX END

const isValidIsoDate = (value) => {
  const text = normalizeText(value)
  if (!ISO_DATE_RE.test(text)) return false
  const date = new Date(`${text}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}

const getMonthEndDate = (yearMonth) => {
  const [year, month] = yearMonth.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

const getClaimExportServiceDate = (claim = {}) =>
  toClaimItDate(claim.service_date_from || claim.serviceDate || claim.service_date)

const claimMatchesExportPeriod = (claim = {}, period) => {
  const serviceDate = getClaimExportServiceDate(claim)
  return Boolean(serviceDate && serviceDate >= period.fromDate && serviceDate <= period.toDate)
}

const normalizeClaimMedicineForExport = (medicine = {}) => ({
  code: normalizeText(medicine.drug_code),
  description: normalizeText(medicine.description),
  unit: normalizeText(medicine.unit) || 'unit',
  unitPrice: Number(medicine.unit_price || 0),
  quantity: Number(medicine.dispensed_qty || 0),
  dispensaryDate: toClaimItDate(medicine.dispensary_date),
  dose: normalizeText(medicine.dose),
  frequency: normalizeText(medicine.frequency),
  duration: normalizeText(medicine.duration),
  totalAmount: Number(medicine.total_amount || 0),
  // ✅ NHIS PHARMACY LEVEL PATCH START
  medicineAccessLevel: normalizeMedicineAccessLevel(medicine.medicine_access_level),
  requiredPharmacyLevel: normalizePharmacyLevel(medicine.required_pharmacy_level),
  // ✅ NHIS PHARMACY LEVEL PATCH END
})

const normalizeClaimServiceForExport = (service = {}) => ({
  code: normalizeText(service.gdrg_code),
  description: normalizeText(service.description),
  tariffVersion: normalizeText(service.tariff_version) || NHIA_TARIFF_VERSION,
  facilityGroup: normalizeText(service.facility_group),
  cateringOption: normalizeText(service.catering_option),
  mdc: normalizeText(service.mdc),
  ageBand: normalizeText(service.age_band),
  unitPrice: Number(service.unit_price || 0),
  quantity: Number(service.quantity || 0),
  serviceDate: toClaimItDate(service.service_date),
  totalAmount: Number(service.total_amount || 0),
  sourceFile: normalizeText(service.source_file),
  sourcePage: service.source_page ?? '',
})

const normalizeClaimDiagnosesForExport = (claim = {}, organizationType = 'pharmacy') => {
  if (normalizeOrganizationType(claim.organization_type || organizationType) !== 'hospital') return []
  const details = normalizeDiagnosisDetails(claim.diagnosis_details)
  if (details.length) {
    return details.map((diagnosis) => ({
      code: diagnosis.code || '',
      label: diagnosis.label,
      source: diagnosis.source || '',
      sourceVersion: diagnosis.sourceVersion || '',
    }))
  }
  return splitDiagnoses(claim.diagnosis).map((label) => ({
    code: '',
    label,
    source: 'Custom',
    sourceVersion: '',
  }))
}

const getClaimItPrescriptionAttachmentForPayload = (claim = {}) => {
  const claimItBase64 = normalizeClaimItAttachmentBase64(claim.claimit_attachment_base64)
  const claimNumber = normalizeText(claim.claim_number)
  if (claimItBase64) {
    return {
      fileName: getSafeClaimItPrescriptionFileName(claimNumber),
      fileType: CLAIMIT_ATTACHMENT_FILE_TYPE,
      mimeType: CLAIMIT_ATTACHMENT_MIME_TYPE,
      sourceMimeType: CLAIMIT_ATTACHMENT_MIME_TYPE,
      fileSize: Math.ceil((claimItBase64.length * 3) / 4),
      base64: claimItBase64,
      storagePath: '',
      url: '',
    }
  }

  const prescriptionFilePath = normalizeText(claim.prescription_file_path)
  const prescriptionFileUrl = normalizeText(claim.prescription_file_url)
  if (!prescriptionFilePath && !prescriptionFileUrl) return null

  const originalFileType = normalizeText(claim.prescription_file_type)
  const originalFileName = normalizeText(claim.prescription_file_name)
  const inferredMimeType = originalFileType ||
    getAttachmentMimeTypeFromPath(originalFileName) ||
    getDataUrlMimeType(prescriptionFileUrl) ||
    getAttachmentMimeTypeFromPath(prescriptionFileUrl) ||
    getAttachmentMimeTypeFromPath(prescriptionFilePath)
  const isOriginalPdf = inferredMimeType.toLowerCase().includes('pdf')
  const sourceMimeType = isOriginalPdf
    ? CLAIMIT_ATTACHMENT_MIME_TYPE
    : inferredMimeType

  return {
    fileName: getSafeClaimItPrescriptionFileName(claimNumber),
    fileType: CLAIMIT_ATTACHMENT_FILE_TYPE,
    mimeType: CLAIMIT_ATTACHMENT_MIME_TYPE,
    sourceMimeType,
    fileSize: normalizePrescriptionFileSize(claim.prescription_file_size) || 0,
    base64: '',
    storagePath: prescriptionFilePath,
    url: prescriptionFileUrl,
  }
}

export const buildNhisClaimItExportPayload = (claims = [], options = {}) => {
  const generatedAt = options.generatedAt || new Date().toISOString()
  const exportPeriod = options.exportPeriod || normalizeNhisExportPeriod({
    ...options,
    generatedAt,
  })
  const organizationType = normalizeOrganizationType(options.organizationType)
  const batchNumber = normalizeText(options.batchNumber) || `HF-NHIS-${exportPeriod.fileTag}-${String(Date.now()).slice(-6)}`
  // ✅ NHIA CONFIG PATCH START
  const facilityType = getNhiaFacilityType({ ...options, organizationType })
  const providerClassLevel = resolveClaimItProviderClassLevel({ ...options, organizationType, facilityType })
  const pharmacyFacilityLevel = resolveClaimItPharmacyFacilityLevel({ ...options, organizationType, facilityType })
  const credentialCode = getClaimItCredentialCode(options)
  // ✅ NHIA CONFIG PATCH END

  const normalizedClaims = claims.map((claim) => {
    const claimOrganizationType = normalizeOrganizationType(claim.organization_type || organizationType)
    const medicines = (claim.nhis_claim_medicines || []).map(normalizeClaimMedicineForExport)
    const tariffServices = (claim.nhis_claim_services || []).map(normalizeClaimServiceForExport)
    const prescriptionAttachment = getClaimItPrescriptionAttachmentForPayload(claim)

    return {
      claimNumber: normalizeText(claim.claim_number),
      status: normalizeText(claim.status),
      organizationType: claimOrganizationType,
      ccCode: normalizeNhisCcCode(claim.ccc_no),
      patient: {
        id: normalizeText(claim.patient_id),
        memberNumber: normalizeText(claim.member_no),
        hin: normalizeText(claim.hin),
        surname: normalizeText(claim.surname),
        otherNames: normalizeText(claim.other_names),
        fullName: `${normalizeText(claim.surname)} ${normalizeText(claim.other_names)}`.trim(),
        folderNumber: normalizeText(claim.folder_no),
        gender: normalizeText(claim.gender),
        dateOfBirth: toClaimItDate(claim.date_of_birth),
        address: claimOrganizationType === 'hospital' ? normalizeText(claim.patient_address) : '',
        childWeightKg: claim.child_weight_kg === null || claim.child_weight_kg === undefined
          ? null
          : Number(claim.child_weight_kg),
      },
      diagnoses: normalizeClaimDiagnosesForExport(claim, claimOrganizationType),
      diagnosis: claimOrganizationType === 'hospital' ? normalizeText(claim.diagnosis) : '',
      service: {
        dateFrom: toClaimItDate(claim.service_date_from),
        dateTo: toClaimItDate(claim.service_date_to || claim.service_date_from),
        prescribingFacility: normalizeText(claim.referring_facility),
        referralCode: normalizeText(claim.referral_code),
        prescriberNameOrId: normalizeText(claim.physician_name),
        preAuthCodes: normalizeText(claim.pre_auth_codes),
      },
      medicines,
      tariffServices,
      prescriptionAttachment,
      notes: normalizeText(claim.notes),
      totalAmount: Number(claim.total_amount || 0),
    }
  })

  return {
    sourceSystem: 'HealthFlow',
    targetSystem: 'CLAIM-it HMS Toolkit',
    batchNumber,
    facilityName: normalizeText(options.facilityName),
    // ✅ NHIA CONFIG PATCH START
    facilityType,
    pharmacyFacilityLevel,
    providerLevelCode: normalizeText(options.providerLevelCode || options.provider_level_code),
    credentialCode,
    licenseNumber: normalizeText(options.licenseNumber || options.license_number),
    accreditationExpiryDate: getNhiaAccreditationExpiryDate(options),
    // ✅ NHIA CONFIG PATCH END
    facilityCode: normalizeText(options.facilityCode),
    providerNumber: normalizeText(options.providerNumber),
    schemeName: normalizeText(options.schemeName) || 'National Health Insurance',
    providerTypeDescription: normalizeText(options.providerTypeDescription || facilityType),
    providerClassLevel,
    claimsOfficerName: normalizeText(options.claimsOfficerName),
    admissionPaymentOption: normalizeText(options.admissionPaymentOption) || 'nhis_pays_admission',
    claimitValidationEnabled: options.claimitValidationEnabled !== false,
    claimsOfficerSignatureUrl: normalizeText(options.claimsOfficerSignatureUrl),
    submitterId: normalizeText(options.submitterId),
    submissionMonth: exportPeriod.yearMonth,
    exportMode: exportPeriod.mode,
    periodLabel: exportPeriod.label,
    periodFrom: exportPeriod.fromDate,
    periodTo: exportPeriod.toDate,
    organizationType,
    createdAt: generatedAt,
    medVersion: normalizeText(options.medVersion || options.nhiaMedicineTariffVersion),
    serviceVersion: normalizeText(options.serviceVersion),
    policyVersion: normalizeText(options.policyVersion),
    // ✅ FINAL CLAIMIT RELATIONAL FIX START
    strictClaimItExportMode: options.strictClaimItExportMode !== false,
    // ✅ FINAL CLAIMIT RELATIONAL FIX END
    claimCount: normalizedClaims.length,
    totalAmount: normalizedClaims.reduce((sum, claim) => sum + Number(claim.totalAmount || 0), 0),
    claims: normalizedClaims,
  }
}

const xmlEscape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export const buildNhisClaimItXml = (payload) => `<?xml version="1.0" encoding="UTF-8"?>
<NhiaClaimBatch>
  <SourceSystem>${xmlEscape(payload.sourceSystem)}</SourceSystem>
  <TargetSystem>${xmlEscape(payload.targetSystem)}</TargetSystem>
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
  <SubmitterId>${xmlEscape(payload.submitterId)}</SubmitterId>
  <SubmissionMonth>${xmlEscape(payload.submissionMonth)}</SubmissionMonth>
  <ExportMode>${xmlEscape(payload.exportMode)}</ExportMode>
  <PeriodLabel>${xmlEscape(payload.periodLabel)}</PeriodLabel>
  <PeriodFrom>${xmlEscape(payload.periodFrom)}</PeriodFrom>
  <PeriodTo>${xmlEscape(payload.periodTo)}</PeriodTo>
  <OrganizationType>${xmlEscape(payload.organizationType)}</OrganizationType>
  <CreatedAt>${xmlEscape(payload.createdAt)}</CreatedAt>
  <ClaimCount>${xmlEscape(payload.claimCount)}</ClaimCount>
  <TotalAmount>${xmlEscape(payload.totalAmount.toFixed(2))}</TotalAmount>
  <Claims>
${payload.claims.map((claim) => `    <Claim>
      <ClaimNumber>${xmlEscape(claim.claimNumber)}</ClaimNumber>
      <Status>${xmlEscape(claim.status)}</Status>
      <OrganizationType>${xmlEscape(claim.organizationType)}</OrganizationType>
      <CcCode>${xmlEscape(claim.ccCode)}</CcCode>
      <Patient>
        <Id>${xmlEscape(claim.patient.id)}</Id>
        <MemberNumber>${xmlEscape(claim.patient.memberNumber)}</MemberNumber>
        <HIN>${xmlEscape(claim.patient.hin)}</HIN>
        <Surname>${xmlEscape(claim.patient.surname)}</Surname>
        <OtherNames>${xmlEscape(claim.patient.otherNames)}</OtherNames>
        <FullName>${xmlEscape(claim.patient.fullName)}</FullName>
        <FolderNumber>${xmlEscape(claim.patient.folderNumber)}</FolderNumber>
        <Gender>${xmlEscape(claim.patient.gender)}</Gender>
        <DateOfBirth>${xmlEscape(claim.patient.dateOfBirth)}</DateOfBirth>
        <Address>${xmlEscape(claim.patient.address)}</Address>
        <ChildWeightKg>${xmlEscape(claim.patient.childWeightKg ?? '')}</ChildWeightKg>
      </Patient>
      <Diagnosis>${xmlEscape(claim.diagnosis)}</Diagnosis>
      <Diagnoses>
${claim.diagnoses.map((diagnosis) => `        <DiagnosisItem>
          <Code>${xmlEscape(diagnosis.code)}</Code>
          <Label>${xmlEscape(diagnosis.label)}</Label>
          <Source>${xmlEscape(diagnosis.source)}</Source>
          <SourceVersion>${xmlEscape(diagnosis.sourceVersion)}</SourceVersion>
        </DiagnosisItem>`).join('\n')}
      </Diagnoses>
      <Service>
        <DateFrom>${xmlEscape(claim.service.dateFrom)}</DateFrom>
        <DateTo>${xmlEscape(claim.service.dateTo)}</DateTo>
        <PrescribingFacility>${xmlEscape(claim.service.prescribingFacility)}</PrescribingFacility>
        <ReferralCode>${xmlEscape(claim.service.referralCode)}</ReferralCode>
        <PrescriberNameOrId>${xmlEscape(claim.service.prescriberNameOrId)}</PrescriberNameOrId>
        <PreAuthCodes>${xmlEscape(claim.service.preAuthCodes)}</PreAuthCodes>
      </Service>
      <Medicines>
${claim.medicines.map((medicine) => `        <Medicine>
          <Code>${xmlEscape(medicine.code)}</Code>
          <Description>${xmlEscape(medicine.description)}</Description>
          <Unit>${xmlEscape(medicine.unit)}</Unit>
          <UnitPrice>${xmlEscape(medicine.unitPrice.toFixed(2))}</UnitPrice>
          <Quantity>${xmlEscape(medicine.quantity)}</Quantity>
          <DispensaryDate>${xmlEscape(medicine.dispensaryDate)}</DispensaryDate>
          <Dose>${xmlEscape(medicine.dose)}</Dose>
          <Frequency>${xmlEscape(medicine.frequency)}</Frequency>
          <Duration>${xmlEscape(medicine.duration)}</Duration>
          <TotalAmount>${xmlEscape(medicine.totalAmount.toFixed(2))}</TotalAmount>
        </Medicine>`).join('\n')}
      </Medicines>
      <TariffServices>
${claim.tariffServices.map((service) => `        <TariffService>
          <Code>${xmlEscape(service.code)}</Code>
          <Description>${xmlEscape(service.description)}</Description>
          <TariffVersion>${xmlEscape(service.tariffVersion)}</TariffVersion>
          <FacilityGroup>${xmlEscape(service.facilityGroup)}</FacilityGroup>
          <CateringOption>${xmlEscape(service.cateringOption)}</CateringOption>
          <Mdc>${xmlEscape(service.mdc)}</Mdc>
          <AgeBand>${xmlEscape(service.ageBand)}</AgeBand>
          <UnitPrice>${xmlEscape(service.unitPrice.toFixed(2))}</UnitPrice>
          <Quantity>${xmlEscape(service.quantity)}</Quantity>
          <ServiceDate>${xmlEscape(service.serviceDate)}</ServiceDate>
          <TotalAmount>${xmlEscape(service.totalAmount.toFixed(2))}</TotalAmount>
          <SourceFile>${xmlEscape(service.sourceFile)}</SourceFile>
          <SourcePage>${xmlEscape(service.sourcePage)}</SourcePage>
        </TariffService>`).join('\n')}
      </TariffServices>
      <PrescriptionAttachment>
        <FileName>${xmlEscape(claim.prescriptionAttachment?.fileName || '')}</FileName>
        <FileType>${xmlEscape(claim.prescriptionAttachment?.fileType || '')}</FileType>
        <FileSize>${xmlEscape(claim.prescriptionAttachment?.fileSize || '')}</FileSize>
        <StoragePath>${xmlEscape(claim.prescriptionAttachment?.storagePath || '')}</StoragePath>
        <Url>${xmlEscape(claim.prescriptionAttachment?.url || '')}</Url>
      </PrescriptionAttachment>
      <Notes>${xmlEscape(claim.notes)}</Notes>
      <TotalAmount>${xmlEscape(claim.totalAmount.toFixed(2))}</TotalAmount>
    </Claim>`).join('\n')}
  </Claims>
</NhiaClaimBatch>
`

const PHP_TEXT_ENCODER = new TextEncoder()

const encodePhpAscii = (value) => PHP_TEXT_ENCODER.encode(value)

const concatPhpBytes = (parts) => {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(totalLength)
  let offset = 0
  parts.forEach((part) => {
    output.set(part, offset)
    offset += part.length
  })
  return output
}

const phpSerializeRawStringBytes = (bytes) =>
  concatPhpBytes([
    encodePhpAscii(`s:${bytes.length}:"`),
    bytes,
    encodePhpAscii('";'),
  ])

const phpSerializeKeyBytes = (key) =>
  Number.isInteger(key) ? encodePhpAscii(`i:${key};`) : phpSerializeBytes(String(key))

const phpSerializeBytes = (value) => {
  if (value === null || value === undefined) return encodePhpAscii('N;')
  if (value instanceof Uint8Array) return phpSerializeRawStringBytes(value)
  if (typeof value === 'boolean') return encodePhpAscii(`b:${value ? 1 : 0};`)
  if (typeof value === 'number') {
    return encodePhpAscii(Number.isInteger(value) ? `i:${value};` : `d:${Number.isFinite(value) ? value : 0};`)
  }
  if (typeof value === 'string') {
    return phpSerializeRawStringBytes(PHP_TEXT_ENCODER.encode(value))
  }
  if (Array.isArray(value)) {
    return concatPhpBytes([
      encodePhpAscii(`a:${value.length}:{`),
      ...value.flatMap((item, index) => [phpSerializeKeyBytes(index), phpSerializeBytes(item)]),
      encodePhpAscii('}'),
    ])
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    return concatPhpBytes([
      encodePhpAscii(`a:${entries.length}:{`),
      ...entries.flatMap(([key, item]) => [phpSerializeKeyBytes(key), phpSerializeBytes(item)]),
      encodePhpAscii('}'),
    ])
  }
  return phpSerializeBytes(String(value))
}

const deflateClaimItPayload = async (serializedPayload) => {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('This browser cannot create CLAIM-it CXF files. Use a current Chrome or Edge browser, or export XML instead.')
  }

  const stream = new Response(serializedPayload).body.pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const toClaimItNumericValue = (value) => {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

const toClaimItIntegerValue = (value) => {
  const number = Number(value || 0)
  return Number.isFinite(number) ? Math.round(number) : 0
}

const toClaimItCompactNumberText = (value) => {
  const text = normalizeText(value)
  const number = Number(text)
  return Number.isFinite(number) ? String(number) : text
}

const parseClaimItJson = (value, fallback) => {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const toClaimItAttachmentFileType = (attachment = {}) => {
  const fileType = normalizeText(attachment.fileType).toLowerCase()
  const fileName = normalizeText(attachment.fileName).toLowerCase()
  if (fileType.includes('pdf') || fileName.endsWith('.pdf')) return 'pdf'
  return 'pdf'
}

const fetchClaimItAttachmentBytes = async (attachment = {}) => {
  const sourceUrl = normalizeText(attachment.url)
  if (!sourceUrl) {
    throw new Error('CLAIM-it CXF export cannot include a prescription attachment without a readable file URL.')
  }

  try {
    const response = await fetch(sourceUrl)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!bytes.length) {
      throw new Error('downloaded file is empty')
    }
    return bytes
  } catch (error) {
    const fileName = normalizeText(attachment.fileName) || 'prescription attachment'
    throw new Error(`Unable to include ${fileName} in CLAIM-it CXF export: ${error.message}`)
  }
}

const bytesToDataUrl = (bytes, mimeType) => `data:${mimeType};base64,${bytesToBase64(bytes)}`

const getDataUrlMimeType = (value = '') => {
  const match = String(value || '').match(/^data:([^;,]+)/i)
  return normalizeText(match?.[1]).toLowerCase()
}

const getAttachmentMimeTypeFromPath = (value = '') => {
  const path = normalizeText(value).toLowerCase().split(/[?#]/)[0]
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.pdf')) return CLAIMIT_ATTACHMENT_MIME_TYPE
  return ''
}

const getClaimItAttachmentMimeType = (attachment = {}) => {
  const sourceMimeType = normalizeText(attachment.sourceMimeType).toLowerCase() ||
    getDataUrlMimeType(attachment.url) ||
    getAttachmentMimeTypeFromPath(attachment.url) ||
    getAttachmentMimeTypeFromPath(attachment.storagePath)
  if (sourceMimeType.includes('png')) return 'image/png'
  if (sourceMimeType.includes('jpeg') || sourceMimeType.includes('jpg')) return 'image/jpeg'
  if (sourceMimeType.includes('pdf')) return CLAIMIT_ATTACHMENT_MIME_TYPE

  const fileType = normalizeText(attachment.fileType).toLowerCase()
  const mimeType = normalizeText(attachment.mimeType).toLowerCase()
  const fileName = normalizeText(attachment.fileName).toLowerCase()
  if (mimeType.includes('png') || fileType.includes('png') || fileName.endsWith('.png')) return 'image/png'
  if (mimeType.includes('jpeg') || mimeType.includes('jpg') || fileType.includes('jpeg') || fileType.includes('jpg') ||
      fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
    return 'image/jpeg'
  }
  return CLAIMIT_ATTACHMENT_MIME_TYPE
}

const prepareClaimItAttachmentPdfPayload = async (attachment = {}) => {
  const fileName = normalizeText(attachment.fileName) || 'prescription attachment'
  const base64 = normalizeClaimItAttachmentBase64(attachment.base64)
  if (base64) {
    const pdfBytes = validateClaimItAttachmentBase64(base64, fileName)
    return {
      pdfBytes,
      payloadBase64: bytesToBase64(pdfBytes),
      diagnostic: getClaimItAttachmentBinaryDiagnostic({
        base64,
        bytes: pdfBytes,
        mimeType: CLAIMIT_ATTACHMENT_MIME_TYPE,
        fileType: CLAIMIT_ATTACHMENT_FILE_TYPE,
      }),
    }
  }

  const sourceBytes = await fetchClaimItAttachmentBytes(attachment)
  let mimeType = getClaimItAttachmentMimeType(attachment)
  if (mimeType === CLAIMIT_ATTACHMENT_MIME_TYPE && !bytesStartWithPdfHeader(sourceBytes)) {
    if (bytesStartWithJpegHeader(sourceBytes)) mimeType = 'image/jpeg'
    if (bytesStartWithPngHeader(sourceBytes)) mimeType = 'image/png'
  }
  let pdfBytes
  if (mimeType === CLAIMIT_ATTACHMENT_MIME_TYPE) {
    if (sourceBytes.length > MAX_CLAIMIT_ATTACHMENT_BYTES) {
      throw new Error(`Unable to include ${fileName} in CLAIM-it CXF export: attachment is larger than 8 MB.`)
    }
    if (!bytesStartWithPdfHeader(sourceBytes)) {
      throw new Error(`Unable to include ${fileName} in CLAIM-it CXF export: attachment must be a valid PDF.`)
    }
    pdfBytes = sourceBytes
  } else {
    const pdfBase64 = await imageDataUrlToPdfBase64(bytesToDataUrl(sourceBytes, mimeType), mimeType)
    pdfBytes = validateClaimItAttachmentBase64(pdfBase64, fileName)
  }

  const payloadBase64 = bytesToBase64(pdfBytes)
  return {
    pdfBytes,
    payloadBase64,
    diagnostic: getClaimItAttachmentBinaryDiagnostic({
      base64: payloadBase64,
      bytes: pdfBytes,
      mimeType: CLAIMIT_ATTACHMENT_MIME_TYPE,
      fileType: CLAIMIT_ATTACHMENT_FILE_TYPE,
    }),
  }
}

const assertClaimItPrescriptionAttachmentForExport = (claim = {}) => {
  const claimNumber = normalizeText(claim.claimNumber) || 'Claim'
  const attachment = claim.prescriptionAttachment
  if (!attachment) {
    throw new Error(`${claimNumber}: CLAIM-it CXF export requires a prescription PDF attachment.`)
  }

  const fileType = normalizeText(attachment.fileType).toLowerCase()
  const mimeType = normalizeText(attachment.mimeType).toLowerCase()
  const base64 = normalizeClaimItAttachmentBase64(attachment.base64)
  const hasReadableSource = Boolean(base64 || normalizeText(attachment.url))
  if (!hasReadableSource) {
    throw new Error(`${claimNumber}: CLAIM-it CXF export requires a readable prescription attachment.`)
  }

  const isPdf = fileType === CLAIMIT_ATTACHMENT_FILE_TYPE ||
    mimeType === CLAIMIT_ATTACHMENT_MIME_TYPE ||
    normalizeText(attachment.fileName).toLowerCase().endsWith('.pdf')
  const isConvertibleImage = ['image/jpeg', 'image/png', 'jpg', 'jpeg', 'png'].includes(fileType) ||
    ['image/jpeg', 'image/png'].includes(mimeType)
  if (!isPdf && !isConvertibleImage) {
    throw new Error(`${claimNumber}: CLAIM-it CXF export prescription attachment must be PDF, JPEG, or PNG.`)
  }

  if (base64) {
    validateClaimItAttachmentBase64(base64, normalizeText(attachment.fileName) || 'prescription attachment')
  }
}

const getClaimItLineServiceDate = (lineDate, fallbackDate, minDate, maxDate) => {
  const normalizedLineDate = toClaimItDate(lineDate)
  if (
    isValidIsoDate(normalizedLineDate) &&
    (!isValidIsoDate(minDate) || normalizedLineDate >= minDate) &&
    (!isValidIsoDate(maxDate) || normalizedLineDate <= maxDate)
  ) {
    return normalizedLineDate
  }
  return fallbackDate
}

const buildClaimItSerializedClaim = ({
  claimRow,
  credentialParts,
  medicineEntries,
  serviceEntries,
  summaryItems,
  attachmentRows,
}) => ({
  claimID: { guid: claimRow.guid },
  isException: claimRow.isException === '1',
  claimCheckCode: claimRow.claimCheckCode,
  preAuthorizationCodes: claimRow.preAuthorizationCodes,
  physicianID: claimRow.physicianID,
  providerInfo: {
    accreditationID: {
      effectiveDate: claimRow.accred_effectiveDate,
      providerID: claimRow.accred_providerID,
      credentialCode: {
        agencyCode: credentialParts.agencyCode,
        regionCode: credentialParts.regionCode,
        districtCode: credentialParts.districtCode,
        ownershipCode: credentialParts.ownershipCode,
        sequenceNumber: credentialParts.sequenceNumber,
        facilityTypeCode: credentialParts.facilityTypeCode,
        prescriptionLevelCode: credentialParts.prescriptionLevelCode,
        cateringStatusCode: credentialParts.cateringStatusCode,
        effectiveDate: claimRow.accred_effectiveDate,
      },
    },
    providerLevelID: {
      facilityTypeCode: claimRow.facilityTypeCode,
      ownershipTypeCode: claimRow.ownershipTypeCode,
      cateringStatusCode: claimRow.cateringStatusCode,
    },
    prescriptionLevelID: claimRow.prescriptionLevelID,
    credentialCode: claimRow.credentialCode,
  },
  memberInfo: {
    memberNo: claimRow.memberNo,
    cardSerialNo: claimRow.cardSerialNo,
    surname: claimRow.surname,
    otherNames: claimRow.otherNames,
    dateOfBirth: claimRow.dateOfBirth,
    gender: claimRow.gender,
    hospitalRecNo: claimRow.hospitalRecNo,
    isDependant: claimRow.isDependant,
  },
  memberAgeGroup: claimRow.memberAgeGroup || null,
  serviceInfo: {
    typeOfService: {
      type: claimRow.typeOfService,
      isUnbundled: claimRow.isUnbundled,
      includesPharmacy: toClaimItIntegerValue(claimRow.includesPharmacy),
    },
    typeOfAttendance: { code: claimRow.typeOfAttendance },
    serviceOutcome: { code: claimRow.serviceOutcome },
    serviceProvisionDates: normalizeText(claimRow.serviceProvisionDates)
      ? claimRow.serviceProvisionDates.split(',').filter(Boolean)
      : [],
    specialtiesAttended: [],
    minDOSP: claimRow.minDOSP,
    maxDOSP: claimRow.maxDOSP,
    durationOfSpell: toClaimItIntegerValue(claimRow.durationOfSpell),
  },
  investigationEntries: [],
  procedureEntries: serviceEntries.map((entry) => ({
    gdrgCode: entry.gdrgCode,
    cost: toClaimItNumericValue(entry.cost),
    entryType: entry.entryType,
    serviceDate: entry.serviceDate,
    icd10: entry.icd10,
    description: entry.description,
    _entry_id: null,
    _claim_id: null,
  })),
  diagnosisEntries: [],
  xDiagnosisEntries: [],
  medicineEntries: medicineEntries.map((entry) => ({
    medicineCode: entry.medicineCode,
    dispensedQty: {
      qty: toClaimItNumericValue(entry.qty),
      dispensedQty: entry.dispensedQty,
      dispensaryUnit: parseClaimItJson(entry.dispensaryUnit, { unit: 'PRICE_UNIT', unitsInPrice: 1, ratio: 1 }),
    },
    serviceDate: entry.serviceDate,
    prescription: {
      dose: {
        value: toClaimItCompactNumberText(entry.dose_value),
        unit: entry.dose_unit,
      },
      frequency: {
        value: toClaimItCompactNumberText(entry.frequency_value),
        unit: entry.frequency_unit,
        desc: entry.frequency_desc,
      },
      duration: {
        value: toClaimItCompactNumberText(entry.duration_value),
        unit: entry.duration_unit,
        desc: entry.duration_desc,
      },
      extraDirections: entry.extraDirections,
      unparsed: entry.unparsed,
    },
    cost: toClaimItNumericValue(entry.cost),
    _entry_id: null,
    _claim_id: null,
  })),
  referralInfo: {
    claimCheckCode: claimRow.refclaimCheckCode,
    facilityID: claimRow.reffacilityID,
    facilityName: claimRow.reffacilityName,
  },
  summaryItems: summaryItems.map((item) => ({
    description: item.description,
    ordinal: toClaimItIntegerValue(item.ordinal),
    type: item.type,
    amount: toClaimItNumericValue(item.amount),
    _entry_id: null,
    _claim_id: null,
  })),
  specialtyAttended: claimRow.specialtyAttended,
  totalCost: toClaimItNumericValue(claimRow.totalCost),
  procCost: toClaimItNumericValue(claimRow.procCost),
  diagCost: toClaimItNumericValue(claimRow.diagCost),
  inveCost: toClaimItNumericValue(claimRow.inveCost),
  medCost: toClaimItNumericValue(claimRow.medCost),
  principalGDRG: claimRow.principalGDRG,
  alternativeGDRG: claimRow.alternativeGDRG,
  autoSummaryGDRG: claimRow.autoSummaryGDRG,
  autoSummaryCost: toClaimItNumericValue(claimRow.autoSummaryCost),
  memberAge: claimRow.memberAge,
  isImported: claimRow.isImported,
  refID: claimRow.refID,
  medVersion: null,
  servVersion: null,
  policyVersion: null,
  additionBlame: null,
  modifyBlame: null,
  signedBlame: null,
  isDirty: claimRow.isDirty === '1',
  status: claimRow.status,
  submissionTime: claimRow.submissionTime,
  attachments: attachmentRows.map((attachment) => ({
    type: attachment.type,
    fileType: attachment.fileType,
    data: [''],
    comments: attachment.comments,
    attach_id: null,
    _claim_id: null,
  })),
  newAttachments: attachmentRows.length ? [[]] : [],
  comments: [],
  extraData: claimRow.extraData,
  claimType: claimRow.claimType,
  attendanceEntries: [],
  _claim_id: null,
})

const compressClaimItSerializedClaim = async (serializedClaim) =>
  await deflateClaimItPayload(JSON.stringify(serializedClaim))

const buildClaimItRows = async (payload) => {
  const generatedAt = toClaimItDateTime(payload.createdAt)
  const signedByName = normalizeText(payload.claimsOfficerName) || 'HealthFlow'
  const signedByUsername = normalizeText(payload.submitterId) || signedByName
  const signedByRole = 'admin'
  const credentialCode = getClaimItCredentialCode(payload)
  const credentialParts = splitClaimItCredentialCode(credentialCode)
  const effectiveDate = getClaimItEffectiveDate(credentialCode)
  const providerId = getClaimItProviderCode(payload)
  const prescriptionLevelId = getClaimItPrescriptionLevel(payload)
  const facilityTypeCode = getClaimItFacilityType(payload)
  // ✅ NHIA CONFIG PATCH START
  const ownershipTypeCode = credentialParts.ownershipCode === '02' ? 'PVT' : 'PVT'
  const cateringStatusCode = credentialParts.cateringStatusCode === '2' ? 'CE' : 'CE'
  // ✅ NHIA CONFIG PATCH END
  const typeOfService = getClaimItServiceType(payload)
  const claimType = getClaimItClaimType(payload)
  const medVersion = normalizeText(payload.medVersion || payload.nhiaMedicineTariffVersion) || CLAIM_IT_MEDICINE_PRICE_VERSION
  const policyVersion = normalizeText(payload.policyVersion) || CLAIM_IT_POLICY_VERSION
  const serviceVersion = normalizeText(payload.serviceVersion) ||
    (payload.claims.some((claim) => claim.tariffServices.length) ? CLAIM_IT_SERVICE_TARIFF_VERSION : null)
  const claims = []
  const medicineentries = []
  const serviceentries = []
  const summaryitems = []
  const attachmentdata = []
  const attachments = []
  const validations = []
  const validationZclaims = []
  const validationClaimContexts = []
  const attachmentDiagnostics = []

  for (const [claimIndex, claim] of payload.claims.entries()) {
    assertClaimItPrescriptionAttachmentForExport(claim)
    const claimGuid = getClaimItGuid(claim.claimNumber || claim.patient.memberNumber, claimIndex)
    const medicineTotal = claim.medicines.reduce((sum, medicine) => sum + Number(medicine.totalAmount || 0), 0)
    const serviceTotal = claim.tariffServices.reduce((sum, service) => sum + Number(service.totalAmount || 0), 0)
    const serviceDate = claim.service.dateFrom || claim.medicines[0]?.dispensaryDate || claim.tariffServices[0]?.serviceDate || payload.periodFrom
    const dateTo = claim.service.dateTo || serviceDate
    const claimMedicineEntries = []
    const claimServiceEntries = []
    const claimSummaryItems = []
    const claimAttachmentRows = []
    const claimRow = {
      guid: claimGuid,
      isException: '0',
      claimCheckCode: claimItDigitsOnly(claim.ccCode),
      preAuthorizationCodes: normalizeText(claim.service.preAuthCodes),
      physicianID: normalizeText(claim.service.prescriberNameOrId),
      specialtyAttended: null,
      totalCost: toClaimItAmount(claim.totalAmount),
      procCost: toClaimItAmount(serviceTotal),
      diagCost: '0.00',
      inveCost: '0.00',
      medCost: toClaimItAmount(medicineTotal),
      principalGDRG: claim.tariffServices[0]?.code || '',
      alternativeGDRG: '',
      autoSummaryGDRG: '',
      autoSummaryCost: '0.00',
      memberAge: getClaimItAge(claim.patient.dateOfBirth, serviceDate),
      memberAgeGroup: getClaimItAgeGroup(claim.patient.dateOfBirth, serviceDate),
      isImported: null,
      refID: null,
      medVersion,
      servVersion: serviceVersion,
      policyVersion,
      isDirty: '0',
      status: 'VALID',
      submissionTime: null,
      extraData: '""',
      addedOn: generatedAt,
      addedByname: signedByName,
      addedByuserID: signedByUsername,
      addedByrole: signedByRole,
      modifiedOn: generatedAt,
      modifiedByname: signedByName,
      modifiedByuserID: signedByUsername,
      modifiedByrole: signedByRole,
      signedOn: null,
      signedByname: null,
      signedByuserID: null,
      signedByrole: null,
      memberNo: normalizeText(claim.patient.memberNumber),
      cardSerialNo: normalizeText(claim.patient.hin),
      surname: normalizeText(claim.patient.surname).toLowerCase(),
      otherNames: normalizeText(claim.patient.otherNames).toLowerCase(),
      dateOfBirth: claim.patient.dateOfBirth,
      gender: toClaimItGender(claim.patient.gender),
      hospitalRecNo: normalizeText(claim.patient.folderNumber),
      isDependant: null,
      prescriptionLevelID: prescriptionLevelId,
      credentialCode,
      accred_effectiveDate: effectiveDate,
      accred_providerID: providerId,
      accred_ccd_agencyCode: credentialParts.agencyCode,
      accred_ccd_regionCode: credentialParts.regionCode,
      accred_ccd_districtCode: credentialParts.districtCode,
      accred_ccd_ownershipCode: credentialParts.ownershipCode,
      accred_ccd_sequenceNumber: credentialParts.sequenceNumber,
      accred_ccd_facilityTypeCode: credentialParts.facilityTypeCode,
      accred_ccd_prescriptionLevelCode: credentialParts.prescriptionLevelCode,
      accred_ccd_cateringStatusCode: credentialParts.cateringStatusCode,
      accred_ccd_effectiveDate: effectiveDate,
      facilityTypeCode,
      ownershipTypeCode,
      cateringStatusCode,
      refclaimCheckCode: '',
      reffacilityID: normalizeText(claim.service.referralCode),
      reffacilityName: normalizeText(claim.service.prescribingFacility).toLowerCase(),
      minDOSP: serviceDate,
      maxDOSP: dateTo,
      serviceProvisionDates: serviceDate === dateTo ? serviceDate : `${serviceDate},${dateTo}`,
      specialtiesAttended: '',
      durationOfSpell: '1',
      typeOfService,
      isUnbundled: '',
      includesPharmacy: claim.medicines.length ? '1' : '0',
      typeOfAttendance: '',
      serviceOutcome: '',
      claimType,
    }
    claims.push(claimRow)

    claim.medicines.forEach((medicine, medicineIndex) => {
      const medicineServiceDate = getClaimItLineServiceDate(medicine.dispensaryDate, serviceDate, serviceDate, dateTo)
      const medicineEntry = {
        _entry_id: String((claimIndex + 1) * 10000 + medicineIndex + 1),
        _claim_id: claimGuid,
        medicineCode: normalizeText(medicine.code),
        serviceDate: medicineServiceDate,
        cost: toClaimItAmount(medicine.totalAmount, 4),
        qty: String(medicine.quantity || ''),
        dispensedQty: String(medicine.quantity || ''),
        dispensaryUnit: JSON.stringify({ unit: 'PRICE_UNIT', unitsInPrice: 1, ratio: 1 }),
        extraDirections: null,
        unparsed: null,
        dose_value: parseDirectionsNumber(medicine.dose),
        dose_unit: normalizeText(medicine.unit).toLowerCase() || 'unit',
        frequency_value: parseFrequencyValue(medicine.frequency),
        frequency_unit: 'DAILY',
        frequency_desc: normalizeText(medicine.frequency).toLowerCase(),
        duration_value: parseDirectionsNumber(medicine.duration),
        duration_unit: 'DAYS',
        duration_desc: normalizeText(medicine.duration).toLowerCase(),
      }
      claimMedicineEntries.push(medicineEntry)
      medicineentries.push(medicineEntry)
    })

    claim.tariffServices.forEach((service, serviceIndex) => {
      const tariffServiceDate = getClaimItLineServiceDate(service.serviceDate, serviceDate, serviceDate, dateTo)
      const serviceEntry = {
        _entry_id: String((claimIndex + 1) * 20000 + serviceIndex + 1),
        _claim_id: claimGuid,
        gdrgCode: normalizeText(service.code),
        cost: toClaimItAmount(service.totalAmount, 4),
        entryType: 'service',
        serviceDate: tariffServiceDate,
        icd10: claim.diagnoses[0]?.code || '',
        description: normalizeText(service.description),
      }
      claimServiceEntries.push(serviceEntry)
      serviceentries.push(serviceEntry)
    })

    if (medicineTotal > 0) {
      const medicineSummary = {
        _entry_id: String((claimIndex + 1) * 30000 + 1),
        _claim_id: claimGuid,
        type: 'Medicines',
        ordinal: '1',
        description: '',
        amount: toClaimItAmount(medicineTotal, 4),
      }
      claimSummaryItems.push(medicineSummary)
      summaryitems.push(medicineSummary)
    }
    if (serviceTotal > 0) {
      const serviceSummary = {
        _entry_id: String((claimIndex + 1) * 30000 + 2),
        _claim_id: claimGuid,
        type: 'Services',
        ordinal: '2',
        description: '',
        amount: toClaimItAmount(serviceTotal, 4),
      }
      claimSummaryItems.push(serviceSummary)
      summaryitems.push(serviceSummary)
    }

    if (claim.prescriptionAttachment) {
      const attachmentId = getClaimItGuid(claimGuid, 'prescription-attachment')
      const attachmentPayload = await prepareClaimItAttachmentPdfPayload(claim.prescriptionAttachment)
      attachmentDiagnostics.push({
        claimNumber: claim.claimNumber,
        attachmentID: attachmentId,
        ...attachmentPayload.diagnostic,
      })
      const attachmentRow = {
        attach_id: attachmentId,
        _claim_id: claimGuid,
        type: 'Prescription',
        fileType: toClaimItAttachmentFileType({
          ...claim.prescriptionAttachment,
          fileType: CLAIMIT_ATTACHMENT_FILE_TYPE,
        }),
        comments: null,
      }
      const attachmentDataRow = {
        _data_id: String((claimIndex + 1) * 50000 + 1),
        _attach_id: attachmentId,
        data: await deflateClaimItPayload(attachmentPayload.pdfBytes),
      }
      claimAttachmentRows.push(attachmentRow)
      attachments.push(attachmentRow)
      attachmentdata.push(attachmentDataRow)
    }

    const validationId = getClaimItGuid(claimGuid, 'validation')
    validations.push({
      _id: validationId,
      s_id: String((claimIndex + 1) * 40000 + 1),
      claimID: claimGuid,
      policyID: policyVersion.replace(/\.\d{6}$/, ''),
      runTime: generatedAt,
      outcome: null,
      isSavedClaim: '0',
      memberNo: normalizeText(claim.patient.memberNumber),
      firstDOSP: serviceDate,
      lastDOSP: dateTo,
      runOn: generatedAt,
      runByname: signedByName,
      runByuserID: signedByUsername,
      runByrole: signedByRole,
    })
    validationClaimContexts.push({
      zclaimId: String((claimIndex + 1) * 40000 + 1),
      validationId,
      claimRow,
      credentialParts,
      medicineEntries: claimMedicineEntries,
      serviceEntries: claimServiceEntries,
      summaryItems: claimSummaryItems,
      attachmentRows: claimAttachmentRows,
    })
  }

  for (const context of validationClaimContexts) {
    validationZclaims.push({
      _id: context.zclaimId,
      _validation_id: context.validationId,
      serializedClaim: await compressClaimItSerializedClaim(buildClaimItSerializedClaim({
        claimRow: context.claimRow,
        credentialParts: context.credentialParts,
        medicineEntries: context.medicineEntries,
        serviceEntries: context.serviceEntries,
        summaryItems: context.summaryItems,
        attachmentRows: context.attachmentRows,
      })),
      isCompressed: '1',
    })
  }

  return {
    claims,
    medicineentries,
    serviceentries,
    summaryitems,
    attachmentdata,
    attachments,
    validations,
    validationZclaims,
    attachmentDiagnostics,
  }
}

const buildClaimItMeta = (payload, rows) => {
  const credentialCode = getClaimItCredentialCode(payload)
  const providerId = getClaimItProviderCode(payload)
  const totalCost = Number(payload.totalAmount || 0)
  const typeOfService = getClaimItServiceType(payload)
  const facilityName = normalizeText(payload.facilityName) || 'HealthFlow Facility'
  const providerLevel = getClaimItProviderLevelId(rows.claims[0]) || 'PVT-PHC-CE'
  const accreditations = getClaimItAccreditationRows(payload, rows)
  const policies = [...new Set(rows.claims.map((claim) => claim.policyVersion).filter(Boolean))]
  const medVersions = [...new Set(rows.claims.map((claim) => claim.medVersion).filter(Boolean))]
  const servVersions = [...new Set(rows.claims.map((claim) => claim.servVersion).filter(Boolean))]

  return {
    dbVersions: CLAIM_IT_DOCTRINE_MIGRATIONS,
    claimYear: (payload.periodFrom || payload.createdAt || '').slice(0, 4),
    claimMonth: (payload.periodFrom || payload.createdAt || '').slice(5, 7),
    claimType: '',
    facilityName,
    providerLevel,
    providerID: providerId,
    credentialCode,
    policies: policies.length ? policies : [CLAIM_IT_POLICY_VERSION],
    medVersions: medVersions.length ? medVersions : [CLAIM_IT_MEDICINE_PRICE_VERSION],
    servVersions: servVersions.length ? servVersions : [null],
    appVersion: CLAIM_IT_APP_VERSION,
    accreditations,
    credUsage: credentialCode ? rows.claims.map((claim) => ({
      credentialCode,
      minDOSP: claim.minDOSP,
      maxDOSP: claim.maxDOSP,
    })) : [],
    [typeOfService]: [{
      typeOfService,
      vol: String(rows.claims.length),
      cost: toClaimItAmount(totalCost),
    }],
    totalVol: rows.claims.length,
    totalCost,
    totalExceptions: '0',
  }
}

const buildNhisClaimItCxfBundle = async (payload) => {
  const rows = await buildClaimItRows(payload)
  const generatedAt = toClaimItDateTime(payload.createdAt)
  const meta = buildClaimItMeta(payload, rows)
  const data = {
    claims: rows.claims,
    serviceentries: rows.serviceentries,
    medicineentries: rows.medicineentries,
    summaryitems: rows.summaryitems,
    attachmentdata: rows.attachmentdata,
    attachments: rows.attachments,
    comments: [],
    validations: rows.validations,
    validation_results: [],
    validation_zclaims: rows.validationZclaims,
    prescribersfordays: getClaimItPrescriberRows(rows),
    _meta: meta,
    _dbstruct: getClaimItDbStruct(),
  }
  Object.defineProperty(data, '_attachmentDiagnostics', {
    value: rows.attachmentDiagnostics,
    enumerable: false,
  })
  const diagnostics = validateClaimItRelationalBundleData(data, { strict: payload.strictClaimItExportMode !== false })
  logClaimItExportDiagnostics(diagnostics)

  return {
    lockID: `partial-export-${generatedAt}`,
    dateGenerated: generatedAt,
    signedByName: normalizeText(payload.claimsOfficerName) || 'HealthFlow',
    signedByUsername: normalizeText(payload.submitterId) || 'HealthFlow',
    signedByRole: 'admin',
    data,
    isBackup: true,
    isExport: true,
    isPartial: true,
    periodStart: payload.periodFrom,
    periodEnd: payload.periodTo,
  }
}

export const buildNhisClaimItCxf = async (payload) => {
  const serialized = phpSerializeBytes(await buildNhisClaimItCxfBundle(payload))
  const compressed = await deflateClaimItPayload(serialized)
  const output = new Uint8Array(compressed.length + 3)
  output.set([0x01, 0x02, 0x19], 0)
  output.set(compressed, 3)
  return output
}

const buildNhisMonthlyCsv = (claims, options = {}) => {
  const escapeCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const exportOrganizationType = normalizeOrganizationType(options.organizationType)

  const headerRow = [
    'Claim Number', 'Status', 'Surname', 'Other Names', 'Member No', 'HIN',
    'Folder No', 'Gender', 'Date of Birth', 'Address', 'Child Weight Kg', 'CCC No',
    'Diagnosis', 'Prescription File',
    'Date of Service',
    'Referring Facility', 'Referral Code',
    'Prescriber Name/ID', 'Pre-Auth Codes',
    'Drug Code', 'Description', 'Unit', 'Unit Price',
    'Dispensed Qty', 'Dispensary Date', 'Dose', 'Frequency', 'Duration', 'Line Total',
    'Service Code', 'Service Description', 'Tariff Version', 'Service Facility Group',
    'Service Catering', 'Service MDC', 'Service Qty', 'Service Date', 'Service Total',
    'Claim Total',
  ].map(escapeCell).join(',')

  const dataRows = []
  for (const claim of claims) {
    const meds = claim.nhis_claim_medicines || []
    const services = claim.nhis_claim_services || []
    const prescriptionFile = claim.prescription_file_name || claim.prescription_file_path || ''
    const claimOrganizationType = normalizeOrganizationType(claim.organization_type || exportOrganizationType)
    const patientAddress = claimOrganizationType === 'hospital' ? claim.patient_address || '' : ''
    if (!meds.length && !services.length) {
      dataRows.push([
        claim.claim_number, claim.status,
        claim.surname, claim.other_names || '',
        claim.member_no || '', claim.hin || '',
        claim.folder_no || '', claim.gender || '',
        claim.date_of_birth || '', patientAddress, claim.child_weight_kg || '', normalizeNhisCcCode(claim.ccc_no),
        claim.diagnosis || '', prescriptionFile,
        claim.service_date_from || '',
        claim.referring_facility || '', claim.referral_code || '',
        claim.physician_name || '', claim.pre_auth_codes || '',
        '', '', '', '', '', '', '', '', '', '',
        '', '', '', '', '', '', '', '', '',
        claim.total_amount,
      ].map(escapeCell).join(','))
    } else {
      for (const med of meds) {
        dataRows.push([
          claim.claim_number, claim.status,
          claim.surname, claim.other_names || '',
          claim.member_no || '', claim.hin || '',
          claim.folder_no || '', claim.gender || '',
          claim.date_of_birth || '', patientAddress, claim.child_weight_kg || '', normalizeNhisCcCode(claim.ccc_no),
          claim.diagnosis || '', prescriptionFile,
          claim.service_date_from || '',
          claim.referring_facility || '', claim.referral_code || '',
          claim.physician_name || '', claim.pre_auth_codes || '',
          med.drug_code || '', med.description,
          med.unit, med.unit_price,
          med.dispensed_qty, med.dispensary_date || '',
          med.dose || '', med.frequency || '', med.duration || '',
          med.total_amount,
          '', '', '', '', '', '', '', '', '',
          claim.total_amount,
        ].map(escapeCell).join(','))
      }
      for (const service of services) {
        dataRows.push([
          claim.claim_number, claim.status,
          claim.surname, claim.other_names || '',
          claim.member_no || '', claim.hin || '',
          claim.folder_no || '', claim.gender || '',
          claim.date_of_birth || '', patientAddress, claim.child_weight_kg || '', normalizeNhisCcCode(claim.ccc_no),
          claim.diagnosis || '', prescriptionFile,
          claim.service_date_from || '',
          claim.referring_facility || '', claim.referral_code || '',
          claim.physician_name || '', claim.pre_auth_codes || '',
          '', '', '', '', '', '', '', '', '', '',
          service.gdrg_code || '', service.description || '', service.tariff_version || '',
          service.facility_group || '', service.catering_option || '', service.mdc || '',
          service.quantity || '', service.service_date || '', service.total_amount || '',
          claim.total_amount,
        ].map(escapeCell).join(','))
      }
    }
  }

  return [headerRow, ...dataRows].join('\n')
}

export const assertClaimItCxfExportConfigured = (options = {}) => {
  // ✅ NHIA CONFIG PATCH START
  const missing = []
  const organizationType = normalizeOrganizationType(options.organizationType)
  const facilityType = getNhiaFacilityType({ ...options, organizationType })
  const isPharmacy = ['Pharmacy', 'Chemical Seller'].includes(facilityType) || organizationType === 'pharmacy'
  const isHospitalFacility = !isPharmacy
  const providerClassLevel = normalizeClaimItProviderClassLevel(options.providerClassLevel || options.provider_class_level)
  const pharmacyFacilityLevel = isPharmacy
    ? normalizeClaimItPharmacyFacilityLevel(
        options.pharmacyFacilityLevel || options.pharmacy_facility_level || options.pharmacyLevel || options.pharmacy_level
      )
    : ''

  if (!normalizeText(options.facilityName || options.facility_name)) missing.push('facilityName')
  if (!normalizeText(options.providerNumber || options.provider_number)) missing.push('providerNumber')
  if (!normalizeText(options.facilityCode || options.facility_code)) missing.push('facilityCode')
  if (!getClaimItCredentialCode(options)) missing.push('credentialCode')
  if (isHospitalFacility && !providerClassLevel) missing.push('providerClassLevel')
  if (isPharmacy && !pharmacyFacilityLevel) missing.push('pharmacyFacilityLevel')
  if (!resolveClaimItProviderLevelCode(options)) missing.push('providerLevelCode')
  const accreditationExpiryDate = getNhiaAccreditationExpiryDate(options)
  logNhiaAccreditationExpiryDate('export validation config', accreditationExpiryDate)
  if (!accreditationExpiryDate) missing.push('accreditationExpiryDate')
  if (!normalizeText(options.claimsOfficerName || options.claims_officer_name)) missing.push('claimsOfficerName')
  if (isHospitalFacility && options._inferredProviderClassLevel) missing.push('providerClassLevel (confirm in Settings)')
  if (isPharmacy && options._inferredPharmacyFacilityLevel) missing.push('pharmacyFacilityLevel (confirm inferred P1 in Settings)')

  if (!missing.length) return
  throw new Error(`CLAIM-it CXF export needs complete NHIA configuration. Missing: ${missing.join(', ')}.`)
  // ✅ NHIA CONFIG PATCH END
}

const createNhisExportFile = async (claims, period, options = {}) => {
  const format = normalizeClaimItExportFormat(options.format)
  if (format === 'csv') {
    return {
      content: buildNhisMonthlyCsv(claims, options),
      contentType: 'text/csv;charset=utf-8;',
      fileName: `NHIS-Claims-${period.fileTag}.csv`,
    }
  }

  const payload = buildNhisClaimItExportPayload(claims, { ...options, exportPeriod: period })
  if (format === 'cxf') assertClaimItCxfExportConfigured({ ...options, ...payload })
  if (format === 'cxf') {
    const claimsForPayload = await hydrateNhisPrescriptionUrlsForTransfer(claims)
    const cxfPayload = buildNhisClaimItExportPayload(claimsForPayload, { ...options, exportPeriod: period })
    return {
      content: await buildNhisClaimItCxf(cxfPayload),
      contentType: 'application/octet-stream',
      fileName: buildClaimItCxfFileName(cxfPayload),
    }
  }

  const isClaimItXml = format === 'xml'
  return {
    content: isClaimItXml ? buildNhisClaimItXml(payload) : JSON.stringify(payload, null, 2),
    contentType: isClaimItXml ? 'application/xml;charset=utf-8;' : 'application/json;charset=utf-8;',
    fileName: `CLAIM-it-HMS-${period.fileTag}.${format}`,
  }
}

const downloadTextFile = ({ content, contentType, fileName }) => {
  const blob = new Blob([content], { type: contentType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

const assertNhisClaimsReadyForFinalSubmission = async (claims, organizationType, options = {}) => {
  const clinicalRules = organizationType === 'hospital' ? await getAllNhisClinicalRules() : DIAGNOSIS_TREATMENT_RULES
  const { providerClassLevel, nhisDrugCatalog } = await getNhisReadinessContext({ organizationType }, options)
  const allTariffServices = claims.flatMap((claim) => claim.nhis_claim_services || [])
  const currentNhiaTariffItems = await getMergedCurrentNhiaTariffItemsForServices(
    allTariffServices,
    options.currentNhiaTariffItems ?? options.nhiaTariffCatalog
  )
  const incompleteClaims = claims
    .map((claim) => ({
      claim,
      issues: assessNhisClaimReadiness(
        {
          ...claim,
          organizationType: claim.organization_type || organizationType,
          providerClassLevel,
        },
        claim.nhis_claim_medicines || [],
        {
          finalSubmission: true,
          clinicalRules,
          enforcePrescribingLevel: true,
          providerClassLevel,
          // ✅ NHIA CONFIG PATCH START
          claimitValidationEnabled: options.claimitValidationEnabled,
          providerClassValidationMode: options.claimitValidationEnabled === false ? 'warn' : 'block',
          // ✅ NHIA CONFIG PATCH END
          // ✅ NHIS PHARMACY LEVEL PATCH START
          pharmacyLevel: options.pharmacyLevel,
          // ✅ NHIS PHARMACY LEVEL PATCH END
          // ✅ NHIS CLAIM LOGIC SEPARATION PATCH START
          tariffFacilityGroup: options.tariffFacilityGroup || options.tariff_facility_group,
          tariffCateringOption: options.tariffCateringOption || options.tariff_catering_option,
          // ✅ NHIS CLAIM LOGIC SEPARATION PATCH END
          nhisDrugCatalog,
          nhiaTariffServices: claim.nhis_claim_services || [],
          currentNhiaTariffItems,
        }
      ).blockers,
    }))
    .filter((item) => item.issues.length)

  if (incompleteClaims.length) {
    const first = incompleteClaims[0]
    throw new Error(
      `NHIA readiness checklist failed for ${incompleteClaims.length} claim(s). ` +
      `${first.claim.claim_number || 'First claim'}: ${first.issues.slice(0, 3).join(' ')}`
    )
  }
}

const markNhisServedClaimsSubmitted = async (claims) => {
  await markNhisClaimsSubmittedByRoute(claims)
}

const getDirectSubmissionPeriodForClaim = (claim = {}) => {
  const serviceDate = getClaimExportServiceDate(claim) || new Date().toISOString().slice(0, 10)
  return normalizeNhisExportPeriod({ mode: 'custom', fromDate: serviceDate, toDate: serviceDate })
}

const hydrateNhisPrescriptionUrlsForTransfer = async (claims = []) => {
  if (shouldUseBranchServer()) return claims

  return await Promise.all(
    claims.map(async (claim) => {
      if (!normalizeText(claim.prescription_file_path) || normalizeText(claim.prescription_file_url)) {
        return claim
      }

      const signedUrl = await getNhisPrescriptionSignedUrl(claim.prescription_file_path, 60 * 60)
      return {
        ...claim,
        prescription_file_url: signedUrl,
      }
    })
  )
}

const buildHostedDirectSubmissionPayload = (payload, options = {}) => {
  const format = normalizeClaimItExportFormat(options.directPayloadFormat || options.exportFormat || 'json')
  if (format === 'xml') {
    return {
      payload,
      payloadContent: buildNhisClaimItXml(payload),
      contentType: 'application/xml;charset=utf-8',
    }
  }

  return {
    payload,
    contentType: 'application/json',
  }
}

const submitNhisClaimsDirect = async (claims, period, options = {}) => {
  const directApiSource = options.directApiSource === 'branch' ? 'branch' : 'hosted'
  const integrationMode = normalizeText(options.integrationMode || options.integration_mode)
  const connectionProfile = normalizeText(options.connectionProfile || options.connection_profile) || 'local_server'
  const bridgeBaseUrl = normalizeText(
    options.apiBaseUrl ||
      options.api_base_url ||
      options.productionBaseUrl ||
      options.production_base_url ||
      options.sandboxBaseUrl ||
      options.sandbox_base_url
  )
  const useBrowserBridge = directApiSource === 'hosted' &&
    isClaimItBridgeMode(integrationMode) &&
    isLocalClaimItBridgeProfile(connectionProfile) &&
    isLocalClaimItBridgeUrl(bridgeBaseUrl)
  const claimsForSubmission = directApiSource === 'hosted'
    ? await hydrateNhisPrescriptionUrlsForTransfer(claims)
    : claims
  const payload = buildNhisClaimItExportPayload(claimsForSubmission, {
    ...options,
    exportPeriod: period,
  })
  const submitDirectPayload = useBrowserBridge
    ? submitBrowserClaimItBridgePayload
    : directApiSource === 'branch'
    ? submitNhiaDirectPayload
    : submitHostedNhiaDirectPayload
  const directPayload = directApiSource === 'hosted'
    ? buildHostedDirectSubmissionPayload(payload, options)
    : { payload }

  const request = {
    ...directPayload,
    ...(useBrowserBridge
      ? {
          localBridge: true,
          settings: {
            apiBaseUrl: bridgeBaseUrl,
            claimEndpointPath: options.claimEndpointPath || options.claim_endpoint_path,
            claimValidationEndpointPath: options.claimValidationEndpointPath || options.claim_validation_endpoint_path,
            validationMode: options.validationMode || options.validation_mode,
          },
        }
      : {}),
    claimIds: claims.map((claim) => claim.id).filter(Boolean),
    ...(directApiSource === 'hosted'
      ? { submissionAction: options.action || 'nhis.direct_submit' }
      : { action: options.action || 'nhis.direct_submit' }),
  }

  try {
    return await submitDirectPayload(request)
  } catch (error) {
    if (directApiSource === 'hosted' && isClaimItBridgeMode(integrationMode) && isClaimItBridgeUnavailableError(error)) {
      const queued = enqueueClaimItBridgeSubmission({ claims, directPayload, request, error })
      return { queued: true, queuedId: queued.id, queuedCount: claims.length }
    }
    throw error
  }
}

/**
 * Generates an XML/JSON CLAIM-it HMS Toolkit batch, or a review CSV, and triggers download.
 */
export const exportNhisClaimsFile = async (options = {}) => {
  const period = normalizeNhisExportPeriod(options)
  const periodClaims = await getNhisClaimsForPeriod(period)
  const exportableStatuses = options.directSubmit ? ['served'] : ['served', 'submitted']
  const claims = periodClaims.filter((claim) =>
    exportableStatuses.includes(normalizeText(claim.status).toLowerCase())
  )
  if (!claims.length) {
    const statusLabel = options.directSubmit ? 'served' : 'served or submitted'
    throw new Error(`No ${statusLabel} claims found for ${period.label}.`)
  }
  const organizationType = normalizeOrganizationType(options.organizationType)
  await assertNhisClaimsReadyForFinalSubmission(claims, organizationType, options)

  if (options.directSubmit) {
    const result = await submitNhisClaimsDirect(claims, period, {
      ...options,
      organizationType,
      action: 'nhis.direct_batch_submit',
    })
    if (result?.queued) return { queued: true, count: claims.length }
    await markNhisServedClaimsSubmitted(claims)
    return claims.length
  }

  downloadTextFile(await createNhisExportFile(claims, period, { ...options, organizationType }))

  return claims.length
}

export const submitNhisClaimDirect = async (id, options = {}) => {
  const claim = options.claim || await getNhisClaimForSubmission(id)
  const organizationType = normalizeOrganizationType(options.organizationType || claim.organization_type)
  await assertNhisClaimsReadyForFinalSubmission([claim], organizationType, options)
  const period = getDirectSubmissionPeriodForClaim(claim)
  const result = await submitNhisClaimsDirect([claim], period, {
    ...options,
    organizationType,
    action: 'nhis.direct_claim_submit',
  })
  if (result?.queued) return result
  await markNhisServedClaimsSubmitted([claim])
  return result
}

export const exportNhisMonthlyFile = async (yearMonth, options = {}) =>
  await exportNhisClaimsFile({ ...options, mode: 'month', yearMonth })

export const exportNhisMonthlyCSV = async (yearMonth, options = {}) =>
  await exportNhisMonthlyFile(yearMonth, { ...options, format: 'csv' })
