import { supabase } from '../lib/supabase'
import { assertRequiredText, assertNonNegativeNumber, normalizeText, sanitizeSearchTerm } from '../utils/validation'
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
const DEFAULT_NHIS_MEMBER_DIGITS = 8
const DEFAULT_GHANA_CARD_DIGITS = 10
const MAX_DIAGNOSES_PER_CLAIM = 10

export const normalizeOrganizationType = (value) => {
  const normalized = asText(value).toLowerCase()
  return VALID_ORGANIZATION_TYPES.includes(normalized) ? normalized : 'pharmacy'
}

const normalizeRuleOrganizationType = (value) => {
  const normalized = asText(value).toLowerCase()
  return ['hospital', 'pharmacy', 'all'].includes(normalized) ? normalized : 'hospital'
}

const normalizeMatchText = (value) => asText(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')

const digitsOnly = (value) => asText(value).replace(/\D/g, '')

const validateMemberNumberFormat = (value, options = {}) => {
  const memberNumber = asText(value)
  if (!memberNumber) return 'NHIS member number is required.'

  const isGhanaCard = memberNumber.toUpperCase().startsWith('GHA')
  const requiredDigits = isGhanaCard
    ? Number(options.ghanaCardDigits) || DEFAULT_GHANA_CARD_DIGITS
    : Number(options.nhisMemberDigits) || DEFAULT_NHIS_MEMBER_DIGITS
  const label = isGhanaCard ? 'Ghana Card number' : 'NHIS member number'

  if (digitsOnly(memberNumber).length !== requiredDigits) {
    return `${label} must contain exactly ${requiredDigits} digits.`
  }

  return ''
}

const splitDiagnoses = (value) =>
  asText(value)
    .split(/[;\n|]/)
    .map(asText)
    .filter(Boolean)

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
  const patientAge = calculateAge(dateOfBirth)
  const memberNumberIssue = validateMemberNumberFormat(
    getClaimField(claimData, 'memberNo', 'member_no'),
    options
  )

  if (memberNumberIssue) blockers.push(memberNumberIssue)
  if (!getClaimField(claimData, 'surname')) blockers.push('Patient surname is required.')
  if (!getClaimField(claimData, 'otherNames', 'other_names')) warnings.push('Patient other names are missing on the claim.')
  if (!getClaimField(claimData, 'patientAddress', 'patient_address')) warnings.push('Patient address is missing on the claim.')
  if (!dateOfBirth) warnings.push('Patient date of birth is missing on the claim.')
  if (patientAge !== null && patientAge < 12 && !(asNumber(childWeight) > 0)) {
    warnings.push('Child weight is missing for a child patient.')
  }
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
      if (!asText(medicine?.dose)) blockers.push(`${label}: dose is required.`)
      if (!asText(medicine?.frequency)) blockers.push(`${label}: dosage schedule/frequency is required.`)
      if (!asText(medicine?.duration)) blockers.push(`${label}: duration is required.`)
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

  assertRequiredText(claimData.surname, 'Surname')
  const memberNo = assertRequiredText(claimData.memberNo, 'NHIS member number')
  const serviceDate = normalizeText(claimData.serviceDate || claimData.serviceDateFrom)

  const totalAmount = medicines.reduce((s, m) => s + Number(m.totalAmount || 0), 0)

  if (shouldUseBranchServer()) {
    return await createBranchRecord('nhis/claims', {
      patient_id: claimData.patientId || null,
      member_no: memberNo,
      hin: normalizeText(claimData.hin) || null,
      surname: normalizeText(claimData.surname),
      other_names: normalizeText(claimData.otherNames) || null,
      folder_no: normalizeText(claimData.folderNo) || null,
      gender: normalizeText(claimData.gender) || null,
      date_of_birth: claimData.dateOfBirth || null,
      patient_address: normalizeText(claimData.patientAddress) || null,
      child_weight_kg: claimData.childWeightKg
        ? assertNonNegativeNumber(claimData.childWeightKg, 'Child weight')
        : null,
      ccc_no: normalizeText(claimData.cccNo) || null,
      diagnosis: normalizeText(claimData.diagnosis) || null,
      service_date_from: serviceDate || null,
      service_date_to: serviceDate || null,
      branch_id: claimData.branchId || null,
      referring_facility: normalizeText(claimData.referringFacility) || null,
      referral_code: normalizeText(claimData.referralCode) || null,
      physician_name: normalizeText(claimData.physicianName) || null,
      pre_auth_codes: normalizeText(claimData.preAuthCodes) || null,
      total_amount: totalAmount,
      status: 'served',
      notes: normalizeText(claimData.notes) || null,
      created_by: claimData.createdBy || null,
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

  const { data: claim, error: claimError } = await supabase
    .from('nhis_claims')
    .insert([{
      patient_id:         claimData.patientId         || null,
      member_no:          memberNo,
      hin:                normalizeText(claimData.hin)               || null,
      surname:            normalizeText(claimData.surname),
      other_names:        normalizeText(claimData.otherNames)        || null,
      folder_no:          normalizeText(claimData.folderNo)          || null,
      gender:             normalizeText(claimData.gender)            || null,
      date_of_birth:      claimData.dateOfBirth                      || null,
      patient_address:    normalizeText(claimData.patientAddress)    || null,
      child_weight_kg:    claimData.childWeightKg
        ? assertNonNegativeNumber(claimData.childWeightKg, 'Child weight')
        : null,
      ccc_no:             normalizeText(claimData.cccNo)             || null,
      diagnosis:          normalizeText(claimData.diagnosis)         || null,
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
      created_by:         claimData.createdBy                        || null,
    }])
    .select()
    .single()

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
        nhis_member_no:    normalizeText(claimData.memberNo) || null,
        nhis_hin:          normalizeText(claimData.hin)      || null,
        insurance_provider: 'NHIS',
        insurance_id:      normalizeText(claimData.memberNo || claimData.hin) || null,
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
  const readiness = assessNhisClaimReadiness(claimData, medicines)
  if (readiness.blockers.length) {
    throw new Error(`NHIS pharmacy dispensing check failed: ${readiness.blockers.slice(0, 5).join(' ')}`)
  }

  assertRequiredText(claimData.surname, 'Surname')
  const memberNo = assertRequiredText(claimData.memberNo, 'NHIS member number')
  const serviceDate = normalizeText(claimData.serviceDate || claimData.serviceDateFrom)
  const totalAmount = medicines.reduce((s, m) => s + Number(m.totalAmount || 0), 0)
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
    child_weight_kg: claimData.childWeightKg
      ? assertNonNegativeNumber(claimData.childWeightKg, 'Child weight')
      : null,
    ccc_no: normalizeText(claimData.cccNo) || null,
    diagnosis: normalizeText(claimData.diagnosis) || null,
    service_date_from: serviceDate || null,
    service_date_to: serviceDate || null,
    branch_id: claimData.branchId || null,
    referring_facility: normalizeText(claimData.referringFacility) || null,
    referral_code: normalizeText(claimData.referralCode) || null,
    physician_name: normalizeText(claimData.physicianName) || null,
    pre_auth_codes: normalizeText(claimData.preAuthCodes) || null,
    total_amount: totalAmount,
    notes: normalizeText(claimData.notes) || null,
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

  const { data: claim, error: claimError } = await supabase
    .from('nhis_claims')
    .update(claimPayload)
    .eq('id', id)
    .eq('status', 'served')
    .select()
    .single()

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
        nhis_member_no: normalizeText(claimData.memberNo) || null,
        nhis_hin: normalizeText(claimData.hin) || null,
        insurance_provider: 'NHIS',
        insurance_id: normalizeText(claimData.memberNo || claimData.hin) || null,
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

// ─── Monthly Batch Export ─────────────────────────────────────────────────────

/**
 * Returns all claims for a given month (YYYY-MM) ready for NHIA submission.
 */
export const getNhisClaimsForMonth = async (yearMonth) => {
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) throw new Error('Month must be in YYYY-MM format.')

  if (shouldUseBranchServer()) {
    return await listBranchRecords('nhis/claims', { month: yearMonth })
  }

  const { data, error } = await supabase
    .from('nhis_claims')
    .select(`
      *,
        nhis_claim_medicines (
          nhis_drug_id, drug_code, description, unit, unit_price,
          dispensed_qty, dispensary_date, dose, frequency, duration, total_amount
        )
    `)
    .eq('submission_month', yearMonth)
    .order('created_at')

  if (error) throw error
  return data || []
}

/**
 * Generates a CSV string for all claims in a given month and triggers download.
 */
export const exportNhisMonthlyCSV = async (yearMonth, options = {}) => {
  const claims = await getNhisClaimsForMonth(yearMonth)
  if (!claims.length) throw new Error(`No claims found for ${yearMonth}.`)
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

  const escapeCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`

  const headerRow = [
    'Claim Number', 'Status', 'Surname', 'Other Names', 'Member No', 'HIN',
    'Folder No', 'Gender', 'Date of Birth', 'Address', 'Child Weight Kg', 'CCC No',
    'Diagnosis',
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
    if (!meds.length) {
      dataRows.push([
        claim.claim_number, claim.status,
        claim.surname, claim.other_names || '',
        claim.member_no || '', claim.hin || '',
        claim.folder_no || '', claim.gender || '',
        claim.date_of_birth || '', claim.patient_address || '', claim.child_weight_kg || '', claim.ccc_no || '',
        claim.diagnosis || '',
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
          claim.diagnosis || '',
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

  const csv = [headerRow, ...dataRows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `NHIS-Claims-${yearMonth}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)

  if (shouldUseBranchServer()) {
    await Promise.all(
      claims
        .filter((claim) => claim.status === 'served')
        .map((claim) => updateBranchRecord('nhis/claims', claim.id, {
          status: 'submitted',
          updated_at: new Date().toISOString(),
        }))
    )
    return claims.length
  }

  // Mark all served claims for this month as submitted
  await supabase
    .from('nhis_claims')
    .update({ status: 'submitted', updated_at: new Date().toISOString() })
    .eq('submission_month', yearMonth)
    .eq('status', 'served')

  return claims.length
}
