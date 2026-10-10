export function normalizeAttendanceNewCcc(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (['yes', 'y', 'true', '1'].includes(normalized)) return 'yes'
  if (['no', 'n', 'false', '0'].includes(normalized)) return 'no'
  return ''
}

export function normalizeAttendanceVerification(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'verified') return 'confirmed'
  return ['confirmed', 'pending', 'failed'].includes(normalized) ? normalized : ''
}
