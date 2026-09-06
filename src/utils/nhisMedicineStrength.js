const UNIT_PATTERN = '(?:mcg|micrograms?|µg|mg|g|iu|units?)'
const STRENGTH_PATTERN = new RegExp(
  '\\b\\d+(?:\\.\\d+)?\\s*(?:' + UNIT_PATTERN + '\\b|%)(?:\\s*\\/\\s*(?:\\d+(?:\\.\\d+)?\\s*)?(?:ml|mL|l|L))?',
  'i'
)

// Combination medicines must retain every catalogue-declared component. A
// component expression is not a clinically interchangeable summed strength.
const COMBINATION_STRENGTH_PATTERN = new RegExp(
  '(?:\\(\\s*\\d+(?:\\.\\d+)?\\s*\\+\\s*\\d+(?:\\.\\d+)?\\s*\\)\\s*(?:' + UNIT_PATTERN + '\\b|%)(?:\\s*\\/\\s*(?:\\d+(?:\\.\\d+)?\\s*)?(?:ml|mL|l|L))?|\\d+(?:\\.\\d+)?\\s*(?:' + UNIT_PATTERN + '\\b|%)\\s*\\+\\s*\\d+(?:\\.\\d+)?\\s*(?:' + UNIT_PATTERN + '\\b|%)(?:\\s*\\/\\s*(?:\\d+(?:\\.\\d+)?\\s*)?(?:ml|mL|l|L))?)',
  'i'
)
const MULTI_INGREDIENT_SLASH_PATTERN = new RegExp(
  '\\d+(?:\\.\\d+)?\\s*' + UNIT_PATTERN + '\\b\\s*\\/\\s*\\d+(?:\\.\\d+)?\\s*' + UNIT_PATTERN + '\\b',
  'i'
)

// Imported NHIS catalogues sometimes keep the strength inside the description
// rather than the separate strength column. Use the explicit field first and
// only derive it from the description when necessary.
export const getNhisMedicineStrength = ({ strength = '', description = '' } = {}) => {
  const explicitStrength = String(strength || '').trim()
  const descriptionText = String(description || '')
  const combinationStrength = descriptionText.match(COMBINATION_STRENGTH_PATTERN)?.[0] ||
    descriptionText.match(MULTI_INGREDIENT_SLASH_PATTERN)?.[0] || ''
  const descriptionStrength = descriptionText.match(STRENGTH_PATTERN)?.[0] || ''

  // A few imported rows put "150 mg" in strength while the description has
  // the clinically necessary concentration, e.g. "150 mg/mL in 2 mL".
  // Prefer that concentration for dose calculation and display.
  if (combinationStrength) return combinationStrength
  if (descriptionStrength.includes('/') && explicitStrength) return descriptionStrength
  if (explicitStrength) return explicitStrength

  return descriptionStrength
}
