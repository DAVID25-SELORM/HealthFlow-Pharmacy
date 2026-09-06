const normalizedMedicineForm = ({ unit = '', dosageForm = '', description = '' } = {}) =>
  `${unit} ${dosageForm} ${description}`.trim().toLowerCase()

const matches = (form, expression) => expression.test(form)

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
