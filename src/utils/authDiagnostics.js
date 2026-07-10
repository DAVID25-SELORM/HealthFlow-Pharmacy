const REDACTED = '[REDACTED]'

const shouldRedactField = (key = '') => {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
  return (
    normalized.includes('password') ||
    normalized.includes('token') ||
    normalized.includes('authorization') ||
    normalized.includes('apikey') ||
    normalized.includes('secret') ||
    normalized.includes('credential')
  )
}

const sanitizeForAuthLog = (value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForAuthLog(entry))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      shouldRedactField(key) && typeof entry !== 'boolean'
        ? REDACTED
        : sanitizeForAuthLog(entry),
    ])
  )
}

const isAuthDiagnosticsEnabled = () => {
  const envValue = String(import.meta.env.VITE_HEALTHFLOW_AUTH_DIAGNOSTICS || '').toLowerCase()
  if (envValue === 'false') return false
  if (envValue === 'true') return true

  if (typeof window === 'undefined') return false
  return window.localStorage.getItem('healthflow_auth_diagnostics') === 'true'
}

export const logAuthDiagnostic = (label, details = {}) => {
  if (!isAuthDiagnosticsEnabled()) {
    return
  }

  console.info('[HealthFlow auth]', {
    label,
    ...sanitizeForAuthLog(details),
  })
}

export const timeAuthOperation = async (label, details, operation) => {
  const startedAt = performance.now()
  logAuthDiagnostic(label, {
    event: 'start',
    ...details,
  })

  try {
    const result = await operation()
    logAuthDiagnostic(label, {
      event: result?.error ? 'response-error' : 'success',
      durationMs: Math.round(performance.now() - startedAt),
      errorName: result?.error?.name || '',
      errorStatus: result?.error?.status || result?.error?.statusCode || '',
      errorMessage: result?.error?.message || '',
      ...details,
    })
    return result
  } catch (error) {
    logAuthDiagnostic(label, {
      event: 'failure',
      durationMs: Math.round(performance.now() - startedAt),
      errorName: error?.name || '',
      errorStatus: error?.status || error?.statusCode || '',
      errorMessage: error?.message || '',
      ...details,
    })
    throw error
  }
}
