// Africa/Accra uses UTC throughout the year. SQL converts the inclusive dates
// below into [start, next-day-start) timestamps before filtering and counting.
export function resolveActivityLogPeriod(payload: Record<string, unknown>, now = new Date()) {
  const mode = String(payload.period || 'custom')
  const today = now.toISOString().slice(0, 10)
  const year = Number(payload.year ?? now.getUTCFullYear())
  const month = Number(payload.month || 0)
  let fromDate = String(payload.fromDate || payload.from_date || '')
  let toDate = String(payload.toDate || payload.to_date || '')
  const date = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10)
  if (mode === 'month') {
    if (!Number.isInteger(year) || year < 1900 || year > 9998 || !Number.isInteger(month) || month < 0 || month > 12) {
      throw new Error('Select a valid activity-log year and month.')
    }
    fromDate = date(year, month ? month - 1 : 0, 1)
    toDate = date(year, month || 12, 0)
  } else if (mode === 'all') {
    fromDate = ''; toDate = ''
  } else if (mode === 'today') {
    fromDate = today; toDate = today
  } else if (mode === 'current_month' || mode === 'previous_month') {
    const offset = mode === 'previous_month' ? -1 : 0
    fromDate = date(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)
    toDate = date(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0)
  } else if (mode !== 'custom') {
    throw new Error('Invalid activity-log date period.')
  }
  for (const value of [fromDate, toDate]) {
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
      throw new Error('Activity-log dates must be valid YYYY-MM-DD dates.')
    }
  }
  if (fromDate && toDate && fromDate > toDate) throw new Error('The activity-log end date cannot be before the start date.')
  return { fromDate, toDate }
}
