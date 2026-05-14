export const DEFAULT_NHIS_MEMBER_DIGITS = 8
export const DEFAULT_GHANA_CARD_DIGITS = 10

export const digitsOnly = (value) => String(value || '').replace(/\D/g, '')

const asText = (value) => String(value ?? '').trim()
const compactGhanaCardValue = (value) => asText(value).toUpperCase().replace(/[\s-]/g, '')

export const isGhanaCardNumber = (value) => compactGhanaCardValue(value).startsWith('GHA')

export const normalizeNhiaMemberNumber = (value) => {
  const text = asText(value)
  if (!text) return ''

  if (!isGhanaCardNumber(text)) {
    return /^\d+$/.test(text) ? text : text.toUpperCase()
  }

  const compact = compactGhanaCardValue(text)
  const digits = digitsOnly(compact.slice(3))
  return digits.length === DEFAULT_GHANA_CARD_DIGITS
    ? `GHA-${digits.slice(0, 9)}-${digits.slice(9)}`
    : compact
}

export const validateNhiaMemberNumberFormat = (
  value,
  {
    nhisMemberDigits = DEFAULT_NHIS_MEMBER_DIGITS,
    ghanaCardDigits = DEFAULT_GHANA_CARD_DIGITS,
  } = {}
) => {
  const memberNumber = asText(value)
  if (!memberNumber) {
    return 'Enter the patient NHIS member number or Ghana Card number.'
  }

  if (isGhanaCardNumber(memberNumber)) {
    const compact = compactGhanaCardValue(memberNumber)
    const digits = digitsOnly(compact.slice(3))
    const requiredDigits = Number(ghanaCardDigits) || DEFAULT_GHANA_CARD_DIGITS

    if (!/^GHA\d+$/.test(compact)) {
      return 'Ghana Card number must start with GHA and contain only digits after the prefix.'
    }

    if (digits.length !== requiredDigits) {
      return `Ghana Card number must contain exactly ${requiredDigits} digits after GHA.`
    }

    return ''
  }

  const requiredDigits = Number(nhisMemberDigits) || DEFAULT_NHIS_MEMBER_DIGITS
  if (!/^\d+$/.test(memberNumber)) {
    return 'NHIS member number must contain digits only, or enter a Ghana Card number starting with GHA.'
  }

  if (memberNumber.length !== requiredDigits) {
    return `NHIS member number must contain exactly ${requiredDigits} digits.`
  }

  return ''
}
