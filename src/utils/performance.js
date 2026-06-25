const PERFORMANCE_ROLES = new Set(['admin', 'super_admin'])

export const shouldLogPerformance = (role) =>
  PERFORMANCE_ROLES.has(String(role || '').toLowerCase())

export const logPerformance = (label, startedAt, role, metadata = {}) => {
  if (!shouldLogPerformance(role) || typeof console === 'undefined') return
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const durationMs = Math.round(now - startedAt)
  console.info('[HealthFlow performance]', {
    label,
    durationMs,
    ...metadata,
  })
}
