import { supabase } from '../lib/supabase'
import { assertRequiredText, assertNonNegativeNumber, normalizeText, sanitizeSearchTerm } from '../utils/validation'
import {
  normalizeNhiaMemberNumber,
  validateNhiaMemberNumberFormat,
} from '../utils/nhiaMemberNumber'
import { tryLogAuditEvent } from './auditService'
import {
  createBranchRecord,
  listBranchRecords,
  shouldUseBranchServer,
  updateBranchRecord,
} from './branchServerApi'
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
const VALID_ORGANIZATION_TYPES = ['pharmacy', 'hospital']
const MAX_DIAGNOSES_PER_CLAIM = 10
const NHIS_PRESCRIPTION_BUCKET = 'nhis-prescriptions'
const MAX_PRESCRIPTION_PDF_BYTES = 10 * 1024 * 1024
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const OPTIONAL_CLAIM_SCHEMA_COLUMNS = [
  'diagnosis_details',
  'prescription_file_url',
  'prescription_file_path',
  'prescription_file_name',
  'prescription_file_type',
  'prescription_file_size',
]
const CLAIMIT_EXPORT_FORMATS = ['xml', 'json', 'csv']

export const normalizeOrganizationType = (value) => {
  const normalized = asText(value).toLowerCase()
  return VALID_ORGANIZATION_TYPES.includes(normalized) ? normalized : 'pharmacy'
}

const normalizeRuleOrganizationType = (value) => {
  const normalized = asText(value).toLowerCase()
  return ['hospital', 'pharmacy', 'all'].includes(normalized) ? normalized : 'hospital'
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

const stripOptionalClaimSchemaColumns = (payload) => {
  const stripped = { ...payload }
  OPTIONAL_CLAIM_SCHEMA_COLUMNS.forEach((column) => {
    delete stripped[column]
  })
  return stripped
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
    .insert([stripOptionalClaimSchemaColumns(insertPayload)])
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
    .update(stripOptionalClaimSchemaColumns(updatePayload))
    .eq('id', id)
    .eq('status', 'served')
    .select()
    .single()
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

const getDiagnosisTreatmentMismatchBlockers = (claimData, medicines = [], rules = DIAGNOSIS_TREATMENT_RULES) => {
  const diagnosis = normalizeMatchText(getClaimField(claimData, 'diagnosis'))
  if (!diagnosis) return []

  const normalizedRules = normalizeClinicalRules(rules)
  const matchedRules = normalizedRules.filter((rule) =>
    rule.diagnosis.some((keyword) => diagnosis.includes(keyword))
  )

  if (!matchedRules.length) return []

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

  return matchedRules
    .filter((rule) => {
      if (rule.severity !== 'block') return false
      const codeMatches = rule.drugCodes.length && rule.drugCodes.some((code) => treatmentCodes.has(code))
      const keywordMatches = rule.treatments.length && rule.treatments.some((keyword) => treatmentText.includes(normalizeMatchText(keyword)))
      return !codeMatches && !keywordMatches
    })
    .map((rule) => `${rule.label}: treatment does not appear to match the diagnosis. Correct the diagnosis or add a matching medicine before final submission/export.`)
}

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

export const assessNhisClaimReadiness = (claimData, medicines = [], options = {}) => {
  const blockers = []
  const warnings = []
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
  const memberNumberIssue = validateMemberNumberFormat(
    getClaimField(claimData, 'memberNo', 'member_no'),
    options
  )

  if (memberNumberIssue) blockers.push(memberNumberIssue)
  if (!getClaimField(claimData, 'surname')) blockers.push('Patient surname is required.')
  if (!getClaimField(claimData, 'otherNames', 'other_names')) warnings.push('Patient other names are missing on the claim.')
  if (!getClaimField(claimData, 'patientAddress', 'patient_address')) warnings.push('Patient address is missing on the claim.')
  if (!dateOfBirth) warnings.push('Patient date of birth is missing on the claim.')
  if (isHospital && patientAge !== null && patientAge < 12 && !(asNumber(childWeight) > 0)) {
    warnings.push('Child weight is missing for a child patient.')
  }
  if (!cccNo) blockers.push('CCC/CC code is required before serving this NHIS claim.')
  if (!diagnosis && isHospital) {
    blockers.push('Diagnosis is required for hospital NHIS claims.')
  } else if (isHospital && diagnoses.length > MAX_DIAGNOSES_PER_CLAIM) {
    blockers.push(`Enter no more than ${MAX_DIAGNOSES_PER_CLAIM} diagnoses on one NHIS claim.`)
  }
  if (!getClaimField(claimData, 'serviceDate', 'service_date_from')) blockers.push('Date of dispensing/service is required.')
  if (!getClaimField(claimData, 'physicianName', 'physician_name')) {
    warnings.push('Prescriber name or ID is missing from the prescription.')
  }

  if (!medicines?.length) {
    blockers.push('Add at least one medicine to the claim.')
  } else {
    medicines.forEach((medicine, index) => {
      const label = `Medicine ${index + 1}`
      const quantity = asNumber(medicine?.dispensedQty ?? medicine?.dispensed_qty)
      const unitPrice = asNumber(medicine?.unitPrice ?? medicine?.unit_price)

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

  if (options.finalSubmission && isHospital) {
    blockers.push(...getDiagnosisTreatmentMismatchBlockers(claimData, medicines, options.clinicalRules || DIAGNOSIS_TREATMENT_RULES))
  }

  return {
    blockers,
    warnings,
    issues: [...blockers, ...warnings],
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

export const validateNhisClaimFinalReadiness = async (claimData, medicines = [], options = {}) => {
  const organizationType = normalizeOrganizationType(
    claimData?.organizationType ?? claimData?.organization_type ?? options.organizationType
  )
  const clinicalRules = organizationType === 'hospital'
    ? await getAllNhisClinicalRules()
    : DIAGNOSIS_TREATMENT_RULES

  return assessNhisClaimReadiness(
    { ...claimData, organizationType },
    medicines,
    { finalSubmission: true, clinicalRules }
  ).blockers
}

// ─── NHIS Drug Catalog ────────────────────────────────────────────────────────

const normalizePrescriptionFileSize = (value) => {
  const size = Number(value)
  return Number.isFinite(size) && size >= 0 ? Math.round(size) : null
}

const getPrescriptionAttachmentPayload = (claimData = {}) => ({
  prescription_file_url: normalizeText(claimData.prescriptionFileUrl ?? claimData.prescription_file_url) || null,
  prescription_file_path: normalizeText(claimData.prescriptionFilePath ?? claimData.prescription_file_path) || null,
  prescription_file_name: normalizeText(claimData.prescriptionFileName ?? claimData.prescription_file_name) || null,
  prescription_file_type: normalizeText(claimData.prescriptionFileType ?? claimData.prescription_file_type) || null,
  prescription_file_size: normalizePrescriptionFileSize(
    claimData.prescriptionFileSize ?? claimData.prescription_file_size
  ),
})

const sanitizeStoragePathSegment = (value, fallback = 'unknown') =>
  String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback

export const validateNhisPrescriptionPdfFile = (file) => {
  if (!file) return 'Select a scanned prescription PDF.'
  const fileName = String(file.name || '').toLowerCase()
  const isPdf = file.type === 'application/pdf' || fileName.endsWith('.pdf')
  if (!isPdf) return 'Only scanned prescription files in PDF format can be attached.'
  if (Number(file.size || 0) > MAX_PRESCRIPTION_PDF_BYTES) {
    return 'Prescription PDF must be 10 MB or smaller.'
  }
  return ''
}

export const uploadNhisPrescriptionPdf = async (file, options = {}) => {
  const validationError = validateNhisPrescriptionPdfFile(file)
  if (validationError) throw new Error(validationError)
  if (shouldUseBranchServer()) {
    throw new Error('PDF prescription attachment upload requires Supabase storage access.')
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
  const fileName = sanitizeStoragePathSegment(file.name || 'prescription.pdf', 'prescription.pdf')
  const path = `${organizationId}/${month}/${claimId}/${Date.now()}-${fileName}`

  const { data, error } = await supabase.storage
    .from(NHIS_PRESCRIPTION_BUCKET)
    .upload(path, file, {
      contentType: 'application/pdf',
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
    prescriptionFileName: file.name || 'prescription.pdf',
    prescriptionFileType: 'application/pdf',
    prescriptionFileSize: file.size || 0,
    prescriptionFileUrl: '',
  }
}

export const getNhisPrescriptionSignedUrl = async (path) => {
  const cleanPath = normalizeText(path)
  if (!cleanPath) throw new Error('Prescription file path is missing.')
  if (!supabase?.storage) throw new Error('Supabase storage is not configured.')

  const { data, error } = await supabase.storage
    .from(NHIS_PRESCRIPTION_BUCKET)
    .createSignedUrl(cleanPath, 5 * 60)

  if (error) throw error
  return data?.signedUrl || ''
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
export const upsertNhisDrugs = async (drugs) => {
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

export const getAllNhisClaims = async (filters = {}) => {
  if (shouldUseBranchServer()) {
    return await listBranchRecords('nhis/claims', filters)
  }

  let query = supabase
    .from('nhis_claims')
    .select(`
      *,
      nhis_claim_medicines (
        id, nhis_drug_id, drug_code, description, unit,
        unit_price, dispensed_qty, dispensary_date,
        dose, frequency, duration, total_amount
      )
    `)
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

  const { data, error } = await query
  if (error) throw error
  return data || []
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
export const createNhisClaim = async (claimData, medicines) => {
  const readiness = assessNhisClaimReadiness(claimData, medicines)
  if (readiness.blockers.length) {
    throw new Error(`NHIS pharmacy dispensing check failed: ${readiness.blockers.slice(0, 5).join(' ')}`)
  }

  const organizationType = normalizeOrganizationType(claimData?.organizationType ?? claimData?.organization_type)
  const isHospital = organizationType === 'hospital'
  assertRequiredText(claimData.surname, 'Surname')
  const memberNo = normalizeNhiaMemberNumber(
    assertRequiredText(claimData.memberNo, 'NHIS member number or Ghana Card number')
  )
  const serviceDate = normalizeText(claimData.serviceDate || claimData.serviceDateFrom)

  const totalAmount = medicines.reduce((s, m) => s + Number(m.totalAmount || 0), 0)
  const diagnosisDetails = getDiagnosisDetailsPayload(claimData)
  const claimPayload = {
    patient_id:         claimData.patientId         || null,
    member_no:          memberNo,
    hin:                normalizeText(claimData.hin)               || null,
    surname:            normalizeText(claimData.surname),
    other_names:        normalizeText(claimData.otherNames)        || null,
    folder_no:          normalizeText(claimData.folderNo)          || null,
    gender:             normalizeText(claimData.gender)            || null,
    date_of_birth:      claimData.dateOfBirth                      || null,
    patient_address:    normalizeText(claimData.patientAddress)    || null,
    child_weight_kg:    isHospital && claimData.childWeightKg
      ? assertNonNegativeNumber(claimData.childWeightKg, 'Child weight')
      : null,
    ccc_no:             normalizeText(claimData.cccNo)             || null,
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
    ...getPrescriptionAttachmentPayload(claimData),
    created_by:         claimData.createdBy                        || null,
  }

  if (shouldUseBranchServer()) {
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
      })),
    })
  }

  const { data: claim, error: claimError } = await insertNhisClaimWithSchemaFallback(claimPayload)

  if (claimError) throw claimError

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
  }))

  const { error: medsError } = await supabase
    .from('nhis_claim_medicines')
    .insert(medicineRows)

  if (medsError) throw medsError

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
      total_amount:   totalAmount,
    },
  })

  return claim
}

export const updateNhisClaim = async (id, claimData, medicines) => {
  const readiness = assessNhisClaimReadiness(claimData, medicines, { requireMedicineDirections: true })
  if (readiness.blockers.length) {
    throw new Error(`NHIS pharmacy dispensing check failed: ${readiness.blockers.slice(0, 5).join(' ')}`)
  }

  const organizationType = normalizeOrganizationType(claimData?.organizationType ?? claimData?.organization_type)
  const isHospital = organizationType === 'hospital'
  assertRequiredText(claimData.surname, 'Surname')
  const memberNo = normalizeNhiaMemberNumber(
    assertRequiredText(claimData.memberNo, 'NHIS member number or Ghana Card number')
  )
  const serviceDate = normalizeText(claimData.serviceDate || claimData.serviceDateFrom)
  const totalAmount = medicines.reduce((s, m) => s + Number(m.totalAmount || 0), 0)
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
  }))

  const claimPayload = {
    patient_id: claimData.patientId || null,
    member_no: memberNo,
    hin: normalizeText(claimData.hin) || null,
    surname: normalizeText(claimData.surname),
    other_names: normalizeText(claimData.otherNames) || null,
    folder_no: normalizeText(claimData.folderNo) || null,
    gender: normalizeText(claimData.gender) || null,
    date_of_birth: claimData.dateOfBirth || null,
    patient_address: normalizeText(claimData.patientAddress) || null,
    child_weight_kg: isHospital && claimData.childWeightKg
      ? assertNonNegativeNumber(claimData.childWeightKg, 'Child weight')
      : null,
    ccc_no: normalizeText(claimData.cccNo) || null,
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
    ...getPrescriptionAttachmentPayload(claimData),
    updated_at: new Date().toISOString(),
  }

  if (shouldUseBranchServer()) {
    return await updateBranchRecord('nhis/claims', id, {
      ...claimPayload,
      nhis_claim_medicines: medicineRows,
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

  const { data: claim, error: claimError } = await updateNhisClaimWithSchemaFallback(id, claimPayload)

  if (claimError) throw claimError

  const { error: deleteError } = await supabase
    .from('nhis_claim_medicines')
    .delete()
    .eq('claim_id', id)

  if (deleteError) throw deleteError

  const { error: medsError } = await supabase
    .from('nhis_claim_medicines')
    .insert(medicineRows.map((row) => ({ ...row, claim_id: id })))

  if (medsError) throw medsError

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

  if (shouldUseBranchServer()) {
    return await updateBranchRecord('nhis/claims', id, {
      status,
      updated_at: new Date().toISOString(),
      ...(status === 'rejected' && rejectionReason
        ? { rejection_reason: rejectionReason }
        : {}),
    })
  }

  if (status === 'paid') {
    await recordNhisPaidLedgerEntry(id, actorId)
  }

  const updates = {
    status,
    updated_at: new Date().toISOString(),
    ...(status === 'rejected' && rejectionReason
      ? { rejection_reason: rejectionReason }
      : {}),
  }

  const { data, error } = await supabase
    .from('nhis_claims')
    .update(updates)
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

// ─── Batch Export ──────────────────────────────────────────────────────────────

/**
 * Normalizes monthly or custom-period export filters for NHIA submission.
 */
export const normalizeNhisExportPeriod = (options = {}) => {
  const mode = normalizeText(options.mode || options.exportMode || '').toLowerCase() === 'custom'
    ? 'custom'
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

  let query = supabase
    .from('nhis_claims')
    .select(`
      *,
        nhis_claim_medicines (
          nhis_drug_id, drug_code, description, unit, unit_price,
          dispensed_qty, dispensary_date, dose, frequency, duration, total_amount
        )
    `)
    .order('created_at')

  if (period.mode === 'month') {
    query = query.eq('submission_month', period.yearMonth)
  } else {
    query = query
      .gte('service_date_from', period.fromDate)
      .lte('service_date_from', period.toDate)
  }

  const { data, error } = await query

  if (error) throw error
  return data || []
}

/**
 * Returns all claims for a given month (YYYY-MM) ready for NHIA submission.
 */
export const getNhisClaimsForMonth = async (yearMonth) =>
  await getNhisClaimsForPeriod({ mode: 'month', yearMonth })

const normalizeClaimItExportFormat = (format = 'xml') => {
  const normalized = normalizeText(format).toLowerCase()
  return CLAIMIT_EXPORT_FORMATS.includes(normalized) ? normalized : 'xml'
}

const toClaimItDate = (value) => normalizeText(value).slice(0, 10)

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

export const buildNhisClaimItExportPayload = (claims = [], options = {}) => {
  const generatedAt = options.generatedAt || new Date().toISOString()
  const exportPeriod = options.exportPeriod || normalizeNhisExportPeriod({
    ...options,
    generatedAt,
  })
  const organizationType = normalizeOrganizationType(options.organizationType)
  const batchNumber = normalizeText(options.batchNumber) || `HF-NHIS-${exportPeriod.fileTag}-${String(Date.now()).slice(-6)}`

  const normalizedClaims = claims.map((claim) => {
    const claimOrganizationType = normalizeOrganizationType(claim.organization_type || organizationType)
    const medicines = (claim.nhis_claim_medicines || []).map(normalizeClaimMedicineForExport)
    const prescriptionAttachment = normalizeText(claim.prescription_file_path)
      ? {
          fileName: normalizeText(claim.prescription_file_name),
          fileType: normalizeText(claim.prescription_file_type) || 'application/pdf',
          fileSize: normalizePrescriptionFileSize(claim.prescription_file_size) || 0,
          storagePath: normalizeText(claim.prescription_file_path),
          url: normalizeText(claim.prescription_file_url),
        }
      : null

    return {
      claimNumber: normalizeText(claim.claim_number),
      status: normalizeText(claim.status),
      organizationType: claimOrganizationType,
      ccCode: normalizeText(claim.ccc_no),
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
        address: normalizeText(claim.patient_address),
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
      prescriptionAttachment,
      notes: normalizeText(claim.notes),
      totalAmount: Number(claim.total_amount || 0),
    }
  })

  return {
    sourceSystem: 'HealthFlow',
    targetSystem: 'CLAIM-it HMS Toolkit',
    batchNumber,
    facilityCode: normalizeText(options.facilityCode),
    providerNumber: normalizeText(options.providerNumber),
    submitterId: normalizeText(options.submitterId),
    submissionMonth: exportPeriod.yearMonth,
    exportMode: exportPeriod.mode,
    periodLabel: exportPeriod.label,
    periodFrom: exportPeriod.fromDate,
    periodTo: exportPeriod.toDate,
    organizationType,
    createdAt: generatedAt,
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

const buildNhisMonthlyCsv = (claims) => {
  const escapeCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`

  const headerRow = [
    'Claim Number', 'Status', 'Surname', 'Other Names', 'Member No', 'HIN',
    'Folder No', 'Gender', 'Date of Birth', 'Address', 'Child Weight Kg', 'CCC No',
    'Diagnosis', 'Prescription PDF',
    'Date of Service',
    'Referring Facility', 'Referral Code',
    'Prescriber Name/ID', 'Pre-Auth Codes',
    'Drug Code', 'Description', 'Unit', 'Unit Price',
    'Dispensed Qty', 'Dispensary Date', 'Dose', 'Frequency', 'Duration', 'Line Total',
    'Claim Total',
  ].map(escapeCell).join(',')

  const dataRows = []
  for (const claim of claims) {
    const meds = claim.nhis_claim_medicines || []
    const prescriptionFile = claim.prescription_file_name || claim.prescription_file_path || ''
    if (!meds.length) {
      dataRows.push([
        claim.claim_number, claim.status,
        claim.surname, claim.other_names || '',
        claim.member_no || '', claim.hin || '',
        claim.folder_no || '', claim.gender || '',
        claim.date_of_birth || '', claim.patient_address || '', claim.child_weight_kg || '', claim.ccc_no || '',
        claim.diagnosis || '', prescriptionFile,
        claim.service_date_from || '',
        claim.referring_facility || '', claim.referral_code || '',
        claim.physician_name || '', claim.pre_auth_codes || '',
        '', '', '', '', '', '', '', '', '', '', claim.total_amount,
      ].map(escapeCell).join(','))
    } else {
      for (const med of meds) {
        dataRows.push([
          claim.claim_number, claim.status,
          claim.surname, claim.other_names || '',
          claim.member_no || '', claim.hin || '',
          claim.folder_no || '', claim.gender || '',
          claim.date_of_birth || '', claim.patient_address || '', claim.child_weight_kg || '', claim.ccc_no || '',
          claim.diagnosis || '', prescriptionFile,
          claim.service_date_from || '',
          claim.referring_facility || '', claim.referral_code || '',
          claim.physician_name || '', claim.pre_auth_codes || '',
          med.drug_code || '', med.description,
          med.unit, med.unit_price,
          med.dispensed_qty, med.dispensary_date || '',
          med.dose || '', med.frequency || '', med.duration || '',
          med.total_amount, claim.total_amount,
        ].map(escapeCell).join(','))
      }
    }
  }

  return [headerRow, ...dataRows].join('\n')
}

const createNhisExportFile = (claims, period, options = {}) => {
  const format = normalizeClaimItExportFormat(options.format)
  if (format === 'csv') {
    return {
      content: buildNhisMonthlyCsv(claims),
      contentType: 'text/csv;charset=utf-8;',
      fileName: `NHIS-Claims-${period.fileTag}.csv`,
    }
  }

  const payload = buildNhisClaimItExportPayload(claims, { ...options, exportPeriod: period })
  return {
    content: format === 'xml' ? buildNhisClaimItXml(payload) : JSON.stringify(payload, null, 2),
    contentType: format === 'xml' ? 'application/xml;charset=utf-8;' : 'application/json;charset=utf-8;',
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

/**
 * Generates an XML/JSON CLAIM-it HMS Toolkit batch, or a review CSV, and triggers download.
 */
export const exportNhisClaimsFile = async (options = {}) => {
  const period = normalizeNhisExportPeriod(options)
  const claims = await getNhisClaimsForPeriod(period)
  if (!claims.length) throw new Error(`No claims found for ${period.label}.`)
  const organizationType = normalizeOrganizationType(options.organizationType)
  const clinicalRules = organizationType === 'hospital' ? await getAllNhisClinicalRules() : DIAGNOSIS_TREATMENT_RULES

  const incompleteClaims = claims
    .map((claim) => ({
      claim,
      issues: assessNhisClaimReadiness(
        {
          ...claim,
          organizationType: claim.organization_type || organizationType,
        },
        claim.nhis_claim_medicines || [],
        { finalSubmission: true, clinicalRules }
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

  downloadTextFile(createNhisExportFile(claims, period, { ...options, organizationType }))

  const servedClaims = claims.filter((claim) => claim.status === 'served')
  if (shouldUseBranchServer()) {
    await Promise.all(
      servedClaims.map((claim) => updateBranchRecord('nhis/claims', claim.id, {
        status: 'submitted',
        updated_at: new Date().toISOString(),
      }))
    )
    return claims.length
  }

  const servedClaimIds = servedClaims.map((claim) => claim.id).filter(Boolean)
  if (servedClaimIds.length) {
    await supabase
      .from('nhis_claims')
      .update({ status: 'submitted', updated_at: new Date().toISOString() })
      .in('id', servedClaimIds)
  }

  return claims.length
}

export const exportNhisMonthlyFile = async (yearMonth, options = {}) =>
  await exportNhisClaimsFile({ ...options, mode: 'month', yearMonth })

export const exportNhisMonthlyCSV = async (yearMonth, options = {}) =>
  await exportNhisMonthlyFile(yearMonth, { ...options, format: 'csv' })
