export const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '')

export const toNumber = (value, fallback = 0) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const assertRequiredText = (value, label) => {
  const normalized = normalizeText(value)
  if (!normalized) {
    throw new Error(`${label} is required.`)
  }
  return normalized
}

export const assertNonNegativeNumber = (value, label) => {
  const parsed = toNumber(value, Number.NaN)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`)
  }
  return parsed
}

export const sanitizeSearchTerm = (value) => normalizeText(value).replace(/[%_,]/g, '')
