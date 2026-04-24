const padDatePart = (value) => String(value).padStart(2, '0')
const APP_LOCALE = 'en-GB'
export const APP_TIME_ZONE = 'Africa/Accra'

export const formatLocalDate = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)

  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('-')
}

export const getFirstDayOfLocalMonth = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  return formatLocalDate(new Date(date.getFullYear(), date.getMonth(), 1))
}

const normalizeDate = (value) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date
}

export const formatAppDate = (value) => {
  const date = normalizeDate(value)
  if (!date) {
    return '-'
  }

  return new Intl.DateTimeFormat(APP_LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: APP_TIME_ZONE,
  }).format(date)
}

export const formatAppDateTime = (value, options = {}) => {
  const date = normalizeDate(value)
  if (!date) {
    return '-'
  }

  return new Intl.DateTimeFormat(APP_LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: APP_TIME_ZONE,
    ...options,
  }).format(date)
}
