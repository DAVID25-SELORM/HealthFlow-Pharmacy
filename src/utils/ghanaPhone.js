// Telephone helpers for the NHIS serving form. Numbers are optional, and a
// number that does not look like a Ghana number only produces a warning.

export const normalizePhoneInput = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  return raw.startsWith('+') ? `+${digits}` : digits
}

export const isLikelyGhanaPhone = (value) => /^(?:\+?233|0)\d{9}$/.test(normalizePhoneInput(value))
