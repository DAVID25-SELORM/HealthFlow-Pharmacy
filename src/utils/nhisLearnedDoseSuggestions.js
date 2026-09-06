import { getNhisDoseSuggestionOptions, getNhisDoseValueAndUnit, validateNhisDoseEntry } from './nhisDoseOptions'

const normalizeIdentityText = (value = '') => String(value).trim().toLowerCase().replace(/\s+/g, ' ')

const formatDoseValue = (value) => Number.isInteger(value)
  ? String(value)
  : String(Math.round(value * 1000) / 1000)

const getMedicineIdentity = (medicine = {}) => ({
  nhisDrugId: String(medicine.nhisDrugId ?? medicine.nhis_drug_id ?? '').trim(),
  dosageForm: normalizeIdentityText(medicine.dosageForm ?? medicine.dosage_form),
  strength: normalizeIdentityText(medicine.strength),
})

const cacheKey = ({ organizationId = '', medicine = {} } = {}) => {
  const identity = getMedicineIdentity(medicine)
  return `healthflow.nhis.learned-doses:${organizationId}:${identity.nhisDrugId}:${identity.dosageForm}:${identity.strength}`
}

export const loadCachedNhisLearnedDoseSuggestions = ({ organizationId, medicine } = {}) => {
  if (!organizationId || typeof window === 'undefined') return []
  try {
    const cached = JSON.parse(window.localStorage.getItem(cacheKey({ organizationId, medicine })) || '[]')
    return Array.isArray(cached) ? cached : []
  } catch {
    return []
  }
}

export const cacheNhisLearnedDoseSuggestions = ({ organizationId, medicine, suggestions } = {}) => {
  if (!organizationId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(cacheKey({ organizationId, medicine }), JSON.stringify(Array.isArray(suggestions) ? suggestions : []))
  } catch {
    // Suggestion caching is optional and must never block clinical entry.
  }
}

export const rememberCachedNhisLearnedDoseSuggestion = ({ organizationId, medicine, observation } = {}) => {
  if (!observation) return
  const cached = loadCachedNhisLearnedDoseSuggestions({ organizationId, medicine })
  const sameSuggestion = (entry) => Number(entry.doseValue ?? entry.dose_value) === observation.doseValue &&
    String(entry.doseUnit ?? entry.dose_unit).toLowerCase() === observation.doseUnit
  const existing = cached.find(sameSuggestion)
  const suggestions = existing
    ? cached.map((entry) => sameSuggestion(entry)
      ? { ...entry, source: 'facility', usageCount: Number(entry.usageCount ?? entry.usage_count ?? 0) + 1 }
      : entry)
    : [...cached, { doseValue: observation.doseValue, doseUnit: observation.doseUnit, source: 'facility', usageCount: 1 }]
  cacheNhisLearnedDoseSuggestions({ organizationId, medicine, suggestions })
}

export const normalizeNhisLearnedDose = (medicine = {}, dose = '') => {
  if (validateNhisDoseEntry(medicine, dose)) return null
  const parsed = getNhisDoseValueAndUnit(dose)
  const { nhisDrugId, dosageForm, strength } = getMedicineIdentity(medicine)
  if (!parsed || !nhisDrugId || !dosageForm || !strength) return null
  return {
    nhisDrugId,
    dosageForm,
    strength,
    doseValue: parsed.value,
    doseUnit: parsed.unit,
    value: `${formatDoseValue(parsed.value)} ${parsed.unit}`,
  }
}

export const getNhisLearnedDoseObservation = (medicine = {}, dose = '', idempotencyKey = '', source = 'custom') => {
  const normalized = normalizeNhisLearnedDose(medicine, dose)
  if (!normalized || !String(idempotencyKey).trim()) return null
  const officialValues = new Set(
    getNhisDoseSuggestionOptions(medicine)
      .map((option) => normalizeNhisLearnedDose(medicine, typeof option === 'string' ? option : option.value)?.value)
      .filter(Boolean)
  )
  // Catalogue/default choices are already authoritative suggestions and do not
  // need to be learned when selected from the list. A user who deliberately
  // types an equivalent value is still a manual observation.
  if (source === 'official' && officialValues.has(normalized.value)) return null
  return {
    idempotencyKey: String(idempotencyKey).trim(),
    nhisDrugId: normalized.nhisDrugId,
    dosageForm: normalized.dosageForm,
    strength: normalized.strength,
    doseValue: normalized.doseValue,
    doseUnit: normalized.doseUnit,
  }
}

export const mergeNhisDoseSuggestions = (medicine = {}, learned = [], officialOptions = getNhisDoseSuggestionOptions(medicine)) => {
  const identity = getMedicineIdentity(medicine)
  const seen = new Set()
  const official = officialOptions.map((option) => ({
    ...(typeof option === 'string' ? { value: option, label: option } : option),
    source: 'official',
  }))
  const learnedOptions = [...learned]
    .filter((entry) => entry && Number(entry.doseValue ?? entry.dose_value) > 0)
    .filter((entry) => {
      const entryDrugId = String(entry.nhisDrugId ?? entry.nhis_drug_id ?? '').trim()
      const entryForm = normalizeIdentityText(entry.dosageForm ?? entry.dosage_form)
      const entryStrength = normalizeIdentityText(entry.strength)
      return (!entryDrugId || entryDrugId === identity?.nhisDrugId) &&
        (!entryForm || entryForm === identity?.dosageForm) &&
        (!entryStrength || entryStrength === identity?.strength)
    })
    .sort((left, right) => {
      const sourceRank = (entry) => (entry.source === 'facility' ? 0 : 1)
      return sourceRank(left) - sourceRank(right) ||
        Number(right.usageCount ?? right.usage_count ?? 0) - Number(left.usageCount ?? left.usage_count ?? 0)
    })
    .map((entry) => {
      const value = `${formatDoseValue(Number(entry.doseValue ?? entry.dose_value))} ${String(entry.doseUnit ?? entry.dose_unit).toLowerCase()}`
      return {
        value,
        label: value,
        description: entry.source === 'facility' ? 'Previously used' : 'Shared suggestion',
        source: entry.source === 'facility' ? 'facility' : 'shared',
      }
    })

  return [...official, ...learnedOptions].filter((option) => {
    const normalized = normalizeNhisLearnedDose(medicine, option.value)?.value || String(option.value).trim().toLowerCase()
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}
