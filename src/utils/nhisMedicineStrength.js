const STRENGTH_PATTERN = /\b\d+(?:\.\d+)?\s*(?:mcg|micrograms?|µg|mg|g|iu|units?|%)\b(?:\s*\/\s*\d+(?:\.\d+)?\s*(?:ml|mL|l|L))?/i

// Imported NHIS catalogues sometimes keep the strength inside the description
// rather than the separate strength column. Use the explicit field first and
// only derive it from the description when necessary.
export const getNhisMedicineStrength = ({ strength = '', description = '' } = {}) => {
  const explicitStrength = String(strength || '').trim()
  if (explicitStrength) return explicitStrength

  return String(description || '').match(STRENGTH_PATTERN)?.[0] || ''
}
