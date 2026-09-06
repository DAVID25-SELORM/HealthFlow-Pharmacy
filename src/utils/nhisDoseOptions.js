const normalizedMedicineForm = ({ unit = '', dosageForm = '', description = '' } = {}) =>
  `${unit} ${dosageForm} ${description}`.trim().toLowerCase()

const matches = (form, expression) => expression.test(form)

const formatAmount = (amount) => Number.isInteger(amount)
  ? String(amount)
  : String(Math.round(amount * 1000) / 1000)

const getNumericDose = (dose = '') => Number.parseFloat(String(dose))

const getStrengthDisplay = (dose, strength) => {
  const solid = String(strength || '').trim().match(/^(\d+(?:\.\d+)?)\s*(mg|mcg|micrograms?|µg|g|iu|units?)$/i)
  if (solid) {
    const quantity = getNumericDose(dose)
    if (Number.isFinite(quantity)) return `${formatAmount(Number(solid[1]) * quantity)} ${solid[2]}`
  }

  const liquid = String(strength || '').trim().match(/^(\d+(?:\.\d+)?)\s*(mg|mcg|micrograms?|µg|g|iu|units?)\s*\/\s*(\d+(?:\.\d+)?)\s*ml$/i)
  if (liquid) {
    const volume = getNumericDose(dose)
    if (Number.isFinite(volume)) {
      return `${formatAmount((Number(liquid[1]) / Number(liquid[3])) * volume)} ${liquid[2]}`
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
    return ['0.5 ml', '1 ml', '2 ml', '5 ml']
  }

  // The actual form is not known. Keep suggestions neutral and permit typing.
  return ['0.5 dose', '1 dose', '2 doses']
}

// Keep the stored value canonical (for CXF and historical directions), while
// showing the calculated administered strength in the picker.
export const getNhisDoseSuggestionOptions = (medicine = {}) => {
  const strength = medicine.strength || ''
  return getNhisDoseOptions(medicine).map((dose) => {
    const administeredStrength = getStrengthDisplay(dose, strength)
    return administeredStrength
      ? { value: dose, label: `${dose} (${administeredStrength})`, description: `Catalogue strength: ${strength}` }
      : { value: dose, label: dose, description: strength ? `Catalogue strength: ${strength}` : '' }
  })
}
