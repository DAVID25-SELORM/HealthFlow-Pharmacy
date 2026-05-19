import { supabase } from '../lib/supabase'
import { assertRequiredText, assertNonNegativeNumber, assertPositiveNumber, normalizeText, sanitizeSearchTerm } from '../utils/validation'
import {
  normalizeNhiaMemberNumber,
  validateNhiaMemberNumberFormat,
} from '../utils/nhiaMemberNumber'
import { tryLogAuditEvent } from './auditService'
import {
  createBranchRecord,
  listBranchRecords,
  shouldUseBranchServer,
  submitNhiaDirectPayload,
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
const NHIS_PRESCRIBING_LEVELS = ['A', 'M', 'B1', 'B2', 'C', 'D', 'SM']
const NHIS_PRESCRIBING_LEVEL_RANKS = NHIS_PRESCRIBING_LEVELS.reduce((levels, level, index) => ({
  ...levels,
  [level]: index + 1,
}), {})
const NHIS_PRESCRIPTION_BUCKET = 'nhis-prescriptions'
const MAX_PRESCRIPTION_ATTACHMENT_BYTES = 3 * 1024 * 1024
const PRESCRIPTION_ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg']
const PRESCRIPTION_ATTACHMENT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg']
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
const CLAIMIT_EXPORT_FORMATS = ['cxf', 'xml', 'json', 'csv']
const NHIA_TARIFF_VERSION = 'FEB 2023'

const NHIS_CLAIM_MEDICINES_SELECT = `
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

const isMissingClaimServicesTable = (error) => {
  const message = String(error?.message || '').toLowerCase()
  return (
    ['42P01', 'PGRST200', 'PGRST205'].includes(error?.code) ||
    message.includes('nhis_claim_services') ||
    message.includes('relationship') ||
    message.includes('schema cache')
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

const getDiagnosisTreatmentMismatchBlockers = (claimData, medicines = [], rules = DIAGNOSIS_TREATMENT_RULES) => {
  const diagnosis = getDiagnosisMatchText(claimData)
  if (!diagnosis) return []

  const normalizedRules = getEffectiveClinicalRules(rules)
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
    .map((rule) => `${rule.label}: treatment does not appear to match the diagnosis. Correct the diagnosis or add a matching medicine before saving corrections/submission.`)
}

const getProviderPrescribingLevel = (claimData = {}, options = {}) =>
  normalizeNhisPrescribingLevel(
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
  return (NHIS_PRESCRIBING_LEVEL_RANKS[providerLevel] || 0) >= (NHIS_PRESCRIBING_LEVEL_RANKS[requiredLevel] || 0)
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
  const shouldRunClinicalScrub =
    isHospital &&
    (options.finalSubmission || options.enforceClinicalScrub === true || requireMedicineDirections)
  const providerPrescribingLevel = getProviderPrescribingLevel(claimData, options)
  const medicineLevelLookup = getMedicineLevelLookup(options.nhisDrugCatalog ?? options.drugCatalog ?? [])
  const memberNumberIssue = validateMemberNumberFormat(
    getClaimField(claimData, 'memberNo', 'member_no'),
    options
  )

  if (memberNumberIssue) blockers.push(memberNumberIssue)
  if (shouldCheckPrescribingLevel && !providerPrescribingLevel) {
    blockers.push('Set the NHIA provider class/level in Settings before saving/submitting NHIS claims.')
  }
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

      if (!asText(medicine?.nhisDrugId ?? medicine?.nhis_drug_id) || !asText(medicine?.drugCode ?? medicine?.drug_code)) {
        blockers.push(`${label}: select a medicine from the NHIS catalog.`)
      }
      if (!asText(medicine?.description)) blockers.push(`${label}: generic medicine name/description is required.`)
      if (!asText(medicine?.unit)) blockers.push(`${label}: unit of pricing is required.`)
      if (!(quantity > 0)) blockers.push(`${label}: exact dispensed quantity must be greater than zero.`)
      if (!(unitPrice >= 0)) blockers.push(`${label}: NHIS unit price is required.`)
      if (shouldCheckPrescribingLevel && providerPrescribingLevel) {
        const requiredLevel = getMedicinePrescribingLevel(medicine, medicineLevelLookup)
        if (!requiredLevel) {
          blockers.push(`${label}: NHIS level of prescribing is missing from the medicine catalog. Update the medicine category before billing this claim.`)
        } else if (!canProviderPrescribeLevel(providerPrescribingLevel, requiredLevel)) {
          blockers.push(`${label}: requires NHIS prescribing level ${requiredLevel}, but this facility is configured as ${providerPrescribingLevel}. Use an authorized prescriber/facility or remove the medicine.`)
        }
      }

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
      if (!service.nhiaTariffItemId) blockers.push(`${label}: select an item from the FEB 2023 NHIA tariff catalog.`)
      if (!service.gdrgCode) blockers.push(`${label}: G-DRG/tariff code is required.`)
      if (!service.description) blockers.push(`${label}: service description is required.`)
      if (!(service.quantity > 0)) blockers.push(`${label}: quantity must be greater than zero.`)
      if (!(service.unitPrice >= 0)) blockers.push(`${label}: official tariff amount is required.`)
      if (!(service.totalAmount >= 0)) blockers.push(`${label}: service line total is required.`)
      if (!service.serviceDate) warnings.push(`${label}: service date is missing; claim service date will be used for export.`)
    })
  }

  if (shouldCheckDiagnosisTreatmentMatch) {
    blockers.push(...getDiagnosisTreatmentMismatchBlockers(claimData, medicines, options.clinicalRules || DIAGNOSIS_TREATMENT_RULES))
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

export const getNhiaApiSettings = async () => {
  if (shouldUseBranchServer()) {
    return null
  }

  const response = await invokeTierAccess({ action: 'get_nhia_api_settings' })
  return response?.settings || null
}

export const saveNhiaApiSettings = async (settings) => {
  if (shouldUseBranchServer()) {
    throw new Error('Hosted NHIA API settings require Supabase access.')
  }

  const response = await invokeTierAccess({
    action: 'save_nhia_api_settings',
    settings,
  })
  return response?.settings || null
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

const getNhisReadinessContext = async (claimData = {}, options = {}) => {
  let providerClassLevel = getProviderPrescribingLevel(claimData, options)
  if (!providerClassLevel) {
    const settings = options.nhiaSettings || options.settings || await getNhiaApiSettings().catch(() => null)
    providerClassLevel = normalizeNhisPrescribingLevel(settings?.providerClassLevel ?? settings?.provider_class_level)
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

  return assessNhisClaimReadiness(
    { ...claimData, organizationType, providerClassLevel },
    medicines,
    {
      finalSubmission: true,
      clinicalRules,
      providerClassLevel,
      nhisDrugCatalog,
      enforcePrescribingLevel: true,
      nhiaTariffServices: options.nhiaTariffServices ?? claimData?.nhis_claim_services ?? [],
    }
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
  if (!file) return 'Select a scanned prescription PDF or JPEG.'
  const fileName = String(file.name || '').toLowerCase()
  const isAllowedType =
    PRESCRIPTION_ATTACHMENT_TYPES.includes(file.type) ||
    PRESCRIPTION_ATTACHMENT_EXTENSIONS.some((extension) => fileName.endsWith(extension))
  if (!isAllowedType) return 'Only scanned prescription files in PDF or JPEG format can be attached.'
  if (Number(file.size || 0) > MAX_PRESCRIPTION_ATTACHMENT_BYTES) {
    return 'Prescription attachment must be 3 MB or smaller.'
  }
  return ''
}

export const uploadNhisPrescriptionPdf = async (file, options = {}) => {
  const validationError = validateNhisPrescriptionPdfFile(file)
  if (validationError) throw new Error(validationError)
  if (shouldUseBranchServer()) {
    throw new Error('Prescription attachment upload requires Supabase storage access.')
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
  const contentType = file.type === 'image/jpeg' ? 'image/jpeg' : 'application/pdf'
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

export const getAllNhisClaims = async (filters = {}) => {
  if (shouldUseBranchServer()) {
    return await listBranchRecords('nhis/claims', filters)
  }

  let query = supabase
    .from('nhis_claims')
    .select(NHIS_CLAIM_MEDICINES_SELECT)
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
  return await hydrateClaimsWithServiceLines(data || [])
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
  const allowIncompleteReview = Boolean(claimData?.allowIncompleteReview || claimData?.reviewOnly)
  const readiness = assessNhisClaimReadiness(
    { ...claimData, organizationType, providerClassLevel },
    medicines,
    {
      enforcePrescribingLevel: true,
      requirePrescriptionAttachment: !allowIncompleteReview,
      providerClassLevel,
      nhisDrugCatalog,
      nhiaTariffServices: tariffServices,
    }
  )
  if (readiness.blockers.length && !allowIncompleteReview) {
    throw new Error(`NHIS pharmacy dispensing check failed: ${readiness.blockers.slice(0, 5).join(' ')}`)
  }

  const isHospital = organizationType === 'hospital'
  assertRequiredText(claimData.surname, 'Surname')
  const memberNo = normalizeNhiaMemberNumber(
    assertRequiredText(claimData.memberNo, 'NHIS member number or Ghana Card number')
  )
  const serviceDate = normalizeText(claimData.serviceDate || claimData.serviceDateFrom)

  const medicineTotal = medicines.reduce((s, m) => s + Number(m.totalAmount || 0), 0)
  const serviceTotal = tariffServices.reduce((s, line) => s + Number(line.totalAmount || 0), 0)
  const totalAmount = medicineTotal + serviceTotal
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

  if (medicineRows.length) {
    const { error: medsError } = await supabase
      .from('nhis_claim_medicines')
      .insert(medicineRows)

    if (medsError) throw medsError
  }

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
      nhisDrugCatalog,
      clinicalRules,
      nhiaTariffServices: tariffServices,
    }
  )
  if (readiness.blockers.length) {
    throw new Error(`NHIS correction check failed: ${readiness.blockers.slice(0, 5).join(' ')}`)
  }

  const isHospital = organizationType === 'hospital'
  assertRequiredText(claimData.surname, 'Surname')
  const memberNo = normalizeNhiaMemberNumber(
    assertRequiredText(claimData.memberNo, 'NHIS member number or Ghana Card number')
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

  const { data: claim, error: claimError } = await updateNhisClaimWithSchemaFallback(id, claimPayload)

  if (claimError) throw claimError

  const { error: deleteError } = await supabase
    .from('nhis_claim_medicines')
    .delete()
    .eq('claim_id', id)

  if (deleteError) throw deleteError

  if (medicineRows.length) {
    const { error: medsError } = await supabase
      .from('nhis_claim_medicines')
      .insert(medicineRows.map((row) => ({ ...row, claim_id: id })))

    if (medsError) throw medsError
  }

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
    .select(NHIS_CLAIM_MEDICINES_SELECT)
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
  return await hydrateClaimsWithServiceLines(data || [])
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

  const { data, error } = await supabase
    .from('nhis_claims')
    .select(NHIS_CLAIM_MEDICINES_SELECT)
    .eq('id', id)
    .single()

  if (error) throw error
  return (await hydrateClaimsWithServiceLines([data]))[0]
}

const normalizeClaimItExportFormat = (format = 'cxf') => {
  const normalized = normalizeText(format).toLowerCase()
  return CLAIMIT_EXPORT_FORMATS.includes(normalized) ? normalized : 'cxf'
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
    const tariffServices = (claim.nhis_claim_services || []).map(normalizeClaimServiceForExport)
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
    facilityCode: normalizeText(options.facilityCode),
    providerNumber: normalizeText(options.providerNumber),
    schemeName: normalizeText(options.schemeName) || 'National Health Insurance',
    providerTypeDescription: normalizeText(options.providerTypeDescription),
    providerClassLevel: normalizeText(options.providerClassLevel),
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

const buildNhisMonthlyCsv = (claims) => {
  const escapeCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`

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
    if (!meds.length && !services.length) {
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
          claim.date_of_birth || '', claim.patient_address || '', claim.child_weight_kg || '', claim.ccc_no || '',
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
          claim.date_of_birth || '', claim.patient_address || '', claim.child_weight_kg || '', claim.ccc_no || '',
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
  const isClaimItXml = format === 'cxf' || format === 'xml'
  return {
    content: isClaimItXml ? buildNhisClaimItXml(payload) : JSON.stringify(payload, null, 2),
    contentType: isClaimItXml ? 'application/xml;charset=utf-8;' : 'application/json;charset=utf-8;',
    fileName: `CLAIM-it-HMS-${period.fileTag}.${format === 'cxf' ? 'cxf' : format}`,
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
          nhisDrugCatalog,
          nhiaTariffServices: claim.nhis_claim_services || [],
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
  const servedClaims = claims.filter((claim) => claim.status === 'served')
  if (shouldUseBranchServer()) {
    await Promise.all(
      servedClaims.map((claim) => updateBranchRecord('nhis/claims', claim.id, {
        status: 'submitted',
        updated_at: new Date().toISOString(),
      }))
    )
    return
  }

  const servedClaimIds = servedClaims.map((claim) => claim.id).filter(Boolean)
  if (servedClaimIds.length) {
    await supabase
      .from('nhis_claims')
      .update({ status: 'submitted', updated_at: new Date().toISOString() })
      .in('id', servedClaimIds)
  }
}

const getDirectSubmissionPeriodForClaim = (claim = {}) => {
  const serviceDate = getClaimExportServiceDate(claim) || new Date().toISOString().slice(0, 10)
  return normalizeNhisExportPeriod({ mode: 'custom', fromDate: serviceDate, toDate: serviceDate })
}

const hydrateNhisPrescriptionUrlsForDirectSubmit = async (claims = []) => {
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
  const claimsForSubmission = directApiSource === 'hosted'
    ? await hydrateNhisPrescriptionUrlsForDirectSubmit(claims)
    : claims
  const payload = buildNhisClaimItExportPayload(claimsForSubmission, {
    ...options,
    exportPeriod: period,
  })
  const submitDirectPayload = directApiSource === 'branch'
    ? submitNhiaDirectPayload
    : submitHostedNhiaDirectPayload
  const directPayload = directApiSource === 'hosted'
    ? buildHostedDirectSubmissionPayload(payload, options)
    : { payload }

  return await submitDirectPayload({
    ...directPayload,
    claimIds: claims.map((claim) => claim.id).filter(Boolean),
    ...(directApiSource === 'hosted'
      ? { submissionAction: options.action || 'nhis.direct_submit' }
      : { action: options.action || 'nhis.direct_submit' }),
  })
}

/**
 * Generates an XML/JSON CLAIM-it HMS Toolkit batch, or a review CSV, and triggers download.
 */
export const exportNhisClaimsFile = async (options = {}) => {
  const period = normalizeNhisExportPeriod(options)
  const periodClaims = await getNhisClaimsForPeriod(period)
  const claims = periodClaims.filter((claim) => normalizeText(claim.status).toLowerCase() === 'served')
  if (!claims.length) throw new Error(`No served claims found for ${period.label}.`)
  const organizationType = normalizeOrganizationType(options.organizationType)
  await assertNhisClaimsReadyForFinalSubmission(claims, organizationType, options)

  if (options.directSubmit) {
    await submitNhisClaimsDirect(claims, period, {
      ...options,
      organizationType,
      action: 'nhis.direct_batch_submit',
    })
    await markNhisServedClaimsSubmitted(claims)
    return claims.length
  }

  downloadTextFile(createNhisExportFile(claims, period, { ...options, organizationType }))

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
  await markNhisServedClaimsSubmitted([claim])
  return result
}

export const exportNhisMonthlyFile = async (yearMonth, options = {}) =>
  await exportNhisClaimsFile({ ...options, mode: 'month', yearMonth })

export const exportNhisMonthlyCSV = async (yearMonth, options = {}) =>
  await exportNhisMonthlyFile(yearMonth, { ...options, format: 'csv' })
