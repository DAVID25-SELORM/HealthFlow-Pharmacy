export const CLAIM_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// Calendar-only boundaries avoid shifting a month in the browser's timezone.
export function getClaimMonthRange(year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from: `${prefix}-01`, to: `${prefix}-${lastDay}` }
}
