export const FAILURE_CATEGORIES = Object.freeze({
  TRANSIENT: 'TRANSIENT',
  AUTH: 'AUTH',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  PERMANENT: 'PERMANENT',
  MANUAL_INTERVENTION: 'MANUAL_INTERVENTION',
})

const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000]
export const MAX_TRANSIENT_ATTEMPTS = 6

export const classifySyncFailure = (error) => {
  const message = String(error?.message || error || 'Sync failed.').toLowerCase()
  const code = String(error?.code || error?.status || '').toUpperCase()
  if (code === '401' || code === '403' || /unauthori[sz]ed|forbidden|token|jwt|session|authentication/.test(message)) {
    return { category: FAILURE_CATEGORIES.AUTH, code: code || 'AUTH_REQUIRED', manual: false }
  }
  if (code === '409' || /conflict|duplicate key|already exists|unique constraint/.test(message)) {
    return { category: FAILURE_CATEGORIES.CONFLICT, code: code || 'CONFLICT', manual: true }
  }
  if (code === '400' || code === '422' || /invalid |missing |must |cannot |not found|violat/.test(message)) {
    return { category: FAILURE_CATEGORIES.VALIDATION, code: code || 'VALIDATION', manual: true }
  }
  if (/unsupported sync event|not implemented|permission denied|does not exist/.test(message)) {
    return { category: FAILURE_CATEGORIES.PERMANENT, code: code || 'PERMANENT', manual: true }
  }
  return { category: FAILURE_CATEGORIES.TRANSIENT, code: code || 'TRANSIENT', manual: false }
}

export const nextRetryAt = (attemptCount, now = Date.now()) => {
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(Number(attemptCount || 1) - 1, 0), RETRY_DELAYS_MS.length - 1)]
  return new Date(now + delay).toISOString()
}
