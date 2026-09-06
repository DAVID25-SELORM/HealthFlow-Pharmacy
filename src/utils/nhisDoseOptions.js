const normalizedMedicineForm = ({ unit = '', dosageForm = '', description = '' } = {}) =>
  `${unit} ${dosageForm} ${description}`.trim().toLowerCase()

const matches = (form, expression) => expression.test(form)

const formatAmount = (amount) => Number.isInteger(amount)
  ? String(amount)
  : String(Math.round(amount * 1000) / 1000)

const getNumericDose = (dose = '') => Number.parseFloat(String(dose))

const DOSE_VALUE_AND_UNIT_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*([a-zµ]+)\s*$/i

const normalizeDoseUnit = (unit = '') => {
  const normalized = String(unit).trim().toLowerCase()
  if (normalized === 'ml') return 'ml'
  if (normalized === 'l') return 'l'
  if (normalized === 'µg' || normalized === 'mcg' || normalized === 'microgram' || normalized === 'micrograms') return 'mcg'
  return normalized
}

export const getNhisDoseValueAndUnit = (dose = '') => {
  const match = String(dose).match(DOSE_VALUE_AND_UNIT_PATTERN)
  if (!match) return null

  const value = Number(match[1])
  if (!(value > 0)) return null
  return { value, unit: normalizeDoseUnit(match[2]) }
}

const formatVolume = (millilitres) => `${formatAmount(millilitres)} ml`

const STANDARD_INFUSION_VOLUMES_ML = [250, 500, 1000]

const getInfusionVolumeOptions = (medicine = {}) => {
  const source = [
    medicine.containerVolume,
    medicine.container_volume,
    medicine.packageVolume,
    medicine.package_volume,
    medicine.description,
    medicine.unit,
  ].filter(Boolean).join(' ')
  const volumes = []
  const pattern = /(\d+(?:\.\d+)?)\s*(ml|l)\b/gi
  let match
  while ((match = pattern.exec(source))) {
    // Do not mistake a concentration denominator (for example mg/5 mL) for
    // the product container's infusion volume.
    if (source.slice(Math.max(0, match.index - 1), match.index) === '/') continue
    const value = Number(match[1]) * (match[2].toLowerCase() === 'l' ? 1000 : 1)
    if (value > 0) volumes.push(value)
  }
  const documentedVolumes = [...new Set(volumes)]
  const supportedStandardVolumes = STANDARD_INFUSION_VOLUMES_ML.filter((candidate) =>
    documentedVolumes.some((containerVolume) => candidate >= containerVolume && candidate % containerVolume === 0)
  )
  // These are prescription-volume suggestions only. They do not imply an
  // inventory/container conversion; dispensing quantity remains authoritative
  // elsewhere in the claim workflow.
  return [...new Set([...documentedVolumes, ...supportedStandardVolumes])]
    .sort((left, right) => left - right)
    .map(formatVolume)
}

const formatInfusionVolumeLabel = (dose) => {
  const parsedDose = getNhisDoseValueAndUnit(dose)
  const millilitres = parsedDose?.unit === 'l'
    ? parsedDose.value * 1000
    : parsedDose?.unit === 'ml' ? parsedDose.value : 0
  return millilitres === 1000 ? '1,000 mL (1 L)' : dose
}

const isPerMillilitreStrength = (strength = '') =>
  /^\d+(?:\.\d+)?\s*(?:mg|mcg|micrograms?|µg|g|iu|units?)\s*\/\s*(?:\d+(?:\.\d+)?\s*)?ml$/i
    .test(String(strength).trim())

const getStrengthDisplay = (dose, strength) => {
  const solid = String(strength || '').trim().match(/^(\d+(?:\.\d+)?)\s*(mg|mcg|micrograms?|µg|g|iu|units?)$/i)
  if (solid) {
    const quantity = getNumericDose(dose)
    if (Number.isFinite(quantity)) return `${formatAmount(Number(solid[1]) * quantity)} ${solid[2]}`
  }

  const liquid = String(strength || '').trim().match(/^(\d+(?:\.\d+)?)\s*(mg|mcg|micrograms?|µg|g|iu|units?)\s*\/\s*(?:(\d+(?:\.\d+)?)\s*)?ml$/i)
  if (liquid) {
    const volume = getNumericDose(dose)
    if (Number.isFinite(volume)) {
      return `${formatAmount((Number(liquid[1]) / Number(liquid[3] || 1)) * volume)} ${liquid[2]}`
    }
  }

  return ''
}

export const getNhisDoseOptions = (medicine = {}) => {
  const form = normalizedMedicineForm(medicine)

  if (matches(form, /\b(tablet|tab)\b/)) {
    return ['0.5 tablet', '1 tablet', '2 tablets', '3 tablets']
  }
  if (matches(form, /\b(capsule|cap)\b/)) {
    return ['1 capsule', '2 capsules', '3 capsules']
  }
  if (matches(form, /\b(infusion|intravenous infusion|iv infusion|drip)\b/)) {
    // Keep an infusion concentration (such as 0.9%) separate from its
    // administration volume. Suggestions are taken only from documented
    // catalogue/container text; custom mL/L entry remains available.
    return getInfusionVolumeOptions(medicine)
  }
  if (matches(form, /\b(syrup|suspension|elixir|mixture|oral solution|oral liquid)\b/)) {
    return ['2.5 ml', '5 ml', '10 ml', '15 ml']
  }
  if (matches(form, /\b(drop|eye drop|ear drop|nasal drop)\b/)) {
    return ['1 drop', '2 drops', '3 drops']
  }
  if (matches(form, /\b(inhaler|puff|nebuliser|nebulizer)\b/)) {
    return ['1 puff', '2 puffs', '3 puffs']
  }
  if (matches(form, /\b(spray)\b/)) {
    return ['1 spray', '2 sprays', '3 sprays']
  }
  if (matches(form, /\b(cream|ointment|gel|lotion|topical)\b/)) {
    return ['1 application', '2 applications', 'Thin layer']
  }
  if (matches(form, /\b(sachet)\b/)) {
    return ['1 sachet', '2 sachets']
  }
  if (matches(form, /\b(suppository)\b/)) {
    return ['1 suppository', '2 suppositories']
  }
  if (matches(form, /\b(injection|injectable|ampoule|ampule|vial)\b/)) {
    // Volumes are only meaningful when the catalogue supplies a concentration
    // such as 150 mg/mL. A fixed-strength vial (for example Omeprazole 40 mg)
    // must be prescribed by vial, never by an invented mL amount.
    return isPerMillilitreStrength(medicine.strength)
      ? ['0.5 ml', '1 ml', '2 ml', '3 ml', '4 ml', '5 ml']
      : ['0.5 vial', '1 vial', '2 vials']
  }

  // The actual form is not known. Keep suggestions neutral and permit typing.
  return ['0.5 dose', '1 dose', '2 doses']
}

export const resolveNhisDoseEntryModel = (medicine = {}) => {
  const form = normalizedMedicineForm(medicine)
  if (matches(form, /\b(infusion|intravenous infusion|iv infusion|drip)\b/)) {
    return { kind: 'INFUSION', doseUnit: 'ml', options: getInfusionVolumeOptions(medicine) }
  }
  if (matches(form, /\b(injection|injectable|ampoule|ampule|vial)\b/)) {
    return {
      kind: 'INJECTION',
      doseUnit: isPerMillilitreStrength(medicine.strength) ? 'ml' : 'vial',
      options: getNhisDoseOptions(medicine),
    }
  }
  if (matches(form, /\b(tablet|tab|capsule|cap)\b/)) {
    return { kind: 'TABLET_CAPSULE', doseUnit: '', options: getNhisDoseOptions(medicine) }
  }
  if (matches(form, /\b(syrup|suspension|elixir|mixture|oral solution|oral liquid)\b/)) {
    return { kind: 'LIQUID_ORAL', doseUnit: 'ml', options: getNhisDoseOptions(medicine) }
  }
  if (matches(form, /\b(cream|ointment|gel|lotion|topical)\b/)) {
    return { kind: 'TOPICAL', doseUnit: 'application', options: getNhisDoseOptions(medicine) }
  }
  return { kind: 'OTHER', doseUnit: '', options: getNhisDoseOptions(medicine) }
}

export const validateNhisDoseEntry = (medicine = {}, dose = '') => {
  if (resolveNhisDoseEntryModel(medicine).kind !== 'INFUSION') return ''
  const parsedDose = getNhisDoseValueAndUnit(dose)
  if (!parsedDose || !['ml', 'l'].includes(parsedDose.unit)) {
    return 'Infusion dose must be a positive volume, for example 500 mL.'
  }
  return ''
}

// Store the prescribed active-ingredient dose (for example 600 mg), while
// showing the administration quantity required by the selected formulation.
// This keeps strength, dose and frequency clinically distinct in CXF/history.
export const getNhisDoseSuggestionOptions = (medicine = {}) => {
  const strength = medicine.strength || ''
  const model = resolveNhisDoseEntryModel(medicine)
  return getNhisDoseOptions(medicine).map((dose) => {
    if (model.kind === 'INFUSION') {
      return {
        value: dose,
        label: formatInfusionVolumeLabel(dose),
        description: strength ? `Catalogue concentration: ${strength}` : '',
      }
    }
    const administeredStrength = getStrengthDisplay(dose, strength)
    return administeredStrength
      ? { value: administeredStrength, label: `${administeredStrength} (${dose})`, description: `Catalogue strength: ${strength}` }
      : { value: dose, label: dose, description: strength ? `Catalogue strength: ${strength}` : '' }
  })
}
