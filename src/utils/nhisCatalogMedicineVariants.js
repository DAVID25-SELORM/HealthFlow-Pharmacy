import { getNhisMedicineStrength } from './nhisMedicineStrength'

const FORM_PATTERNS = [
  ['oral suspension', /\boral suspension\b/i],
  ['oral solution', /\boral solution\b/i],
  ['sublingual tablet', /\bsublingual tablet\b/i],
  ['dispersible tablet', /\bdispersible tablet\b/i],
  ['tablet', /\btablets?\b/i],
  ['capsule', /\bcapsules?\b/i],
  ['suspension', /\bsuspension\b/i],
  ['syrup', /\bsyrup\b/i],
  ['infusion', /\binfusions?\b/i],
  ['injection', /\binjections?\b/i],
  ['cream', /\bcream\b/i],
  ['ointment', /\bointment\b/i],
  ['drops', /\bdrops?\b/i],
  ['inhaler', /\binhaler\b/i],
  ['spray', /\bspray\b/i],
  ['suppository', /\bsuppositor(?:y|ies)\b/i],
  ['pessary', /\bpessar(?:y|ies)\b/i],
  ['sachet', /\bsachets?\b/i],
]

const clean = (value = '') => String(value || '').replace(/\s+/g, ' ').trim()
const key = (value = '') => clean(value).toLowerCase()

const formFromText = (value = '') => {
  const text = clean(value)
  const match = FORM_PATTERNS.find(([, pattern]) => pattern.test(text))
  return match?.[0] || ''
}

const genericFromDescription = (description = '', dosageForm = '') => {
  const text = clean(description)
  const form = dosageForm || formFromText(text)
  if (!form) return text

  const pattern = FORM_PATTERNS.find(([label]) => label === key(form))?.[1]
  const match = pattern?.exec(text)
  return clean(match ? text.slice(0, match.index).replace(/[,:;-]+$/, '') : text)
}

export const getNhisCatalogMedicineVariant = (medicine = {}) => {
  const description = clean(medicine.description)
  const dosageForm = clean(medicine.dosage_form || medicine.dosageForm) || formFromText(description)
  const genericName = clean(medicine.generic_name || medicine.genericName) || genericFromDescription(description, dosageForm)
  const strength = getNhisMedicineStrength(medicine)

  return {
    source: medicine,
    id: medicine.id || medicine.nhisDrugId || medicine.nhis_drug_id || '',
    code: clean(medicine.code || medicine.drugCode || medicine.drug_code).toUpperCase(),
    description,
    genericName,
    genericKey: key(genericName),
    dosageForm,
    dosageFormKey: key(dosageForm),
    strength,
    strengthKey: key(strength),
    unit: clean(medicine.unit) || 'unit',
    unitPrice: Number(medicine.unit_price ?? medicine.unitPrice ?? 0) || 0,
  }
}

export const getNhisCatalogMedicineVariants = (catalogue = [], medicine = {}) => {
  const selected = getNhisCatalogMedicineVariant(medicine)
  if (!selected.genericKey) return []
  return (Array.isArray(catalogue) ? catalogue : [])
    .map(getNhisCatalogMedicineVariant)
    .filter((variant) => variant.genericKey === selected.genericKey)
}

export const getNhisVariantForms = (variants = []) =>
  [...new Map((variants || [])
    .filter((variant) => variant.dosageForm)
    .map((variant) => [variant.dosageFormKey, variant.dosageForm]))
    .values()]

export const getNhisVariantStrengths = (variants = [], dosageForm = '') => {
  const targetForm = key(dosageForm)
  return [...new Map((variants || [])
    .filter((variant) => !targetForm || variant.dosageFormKey === targetForm)
    .filter((variant) => variant.strength)
    .map((variant) => [variant.strengthKey, variant.strength]))
    .values()]
}

// Resolves an existing catalogue variant only. It never manufactures a code,
// tariff, or strength for a medicine that is not in the organisation catalogue.
export const resolveNhisCatalogMedicineVariant = ({
  catalogue = [],
  medicine = {},
  dosageForm = '',
  strength = '',
} = {}) => {
  const variants = getNhisCatalogMedicineVariants(catalogue, medicine)
  const desiredForm = key(dosageForm)
  const desiredStrength = key(strength)
  return variants.find((variant) =>
    (!desiredForm || variant.dosageFormKey === desiredForm) &&
    (!desiredStrength || variant.strengthKey === desiredStrength)
  ) || null
}
