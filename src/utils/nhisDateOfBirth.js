const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T/
const DMY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

const toValidIsoDate = (year, month, day) => {
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return ''
  }

  return [
    parsed.getUTCFullYear(),
    String(parsed.getUTCMonth() + 1).padStart(2, '0'),
    String(parsed.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

export const normalizeNhisDateOfBirth = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''

  if (ISO_DATE_PATTERN.test(raw)) {
    const [year, month, day] = raw.split('-')
    return toValidIsoDate(year, month, day)
  }

  const isoDateTime = raw.match(ISO_DATE_TIME_PATTERN)
  if (isoDateTime) {
    const [, year, month, day] = isoDateTime
    return toValidIsoDate(year, month, day)
  }

  const dmy = raw.match(DMY_DATE_PATTERN)
  if (dmy) {
    const [, day, month, year] = dmy
    return toValidIsoDate(year, month, day)
  }

  return ''
}

export const formatNhisDateOfBirthInput = (value) => {
  const raw = String(value || '').trim()
  const iso = normalizeNhisDateOfBirth(raw)
  if (!iso) return raw
  const [year, month, day] = iso.split('-')
  return `${day}/${month}/${year}`
}
