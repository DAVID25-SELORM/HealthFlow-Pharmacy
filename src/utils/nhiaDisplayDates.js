// NHIA's NeHFAMS portal shows dates as dd/mm/yyyy. HealthFlow stores ISO dates
// (yyyy-mm-dd), so show eligibility dates the way the portal does to make the
// two screens easy to compare.
export function formatNhiaDisplayDate(value, fallback = 'Not returned') {
  const text = String(value ?? '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (!match) return text || fallback
  return `${match[3]}/${match[2]}/${match[1]}`
}
