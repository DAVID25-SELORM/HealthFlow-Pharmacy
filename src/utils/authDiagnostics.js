import { classifyAuthFailure } from './authFailure'

const REDACTED = '[REDACTED]'
const SAFE_FIELDS = new Set([
  'event', 'reason', 'sessionPresent', 'expiresAt', 'localTime', 'secondsUntilExpiry',
  'online', 'localStorageAvailable', 'sessionStorageAvailable',
  'localStorageSessionPresent', 'sessionStorageSessionPresent', 'cookiesAvailable',
  'serverTimeAvailable', 'serverTime', 'clockSkewMs', 'significantClockSkew',
  'failureCategory', 'durationMs', 'errorStatus', 'attempt', 'attempts', 'retryDelayMs',
  'hasUrl', 'usesHealthFlowGateway', 'hasPublishableKey', 'hasAnonKey', 'hasValidCredentials',
  'lastActivity', 'timeoutMs',
])

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
      !SAFE_FIELDS.has(key) || (shouldRedactField(key) && typeof entry !== 'boolean') || /message|details|body|email|patient|user|organization|branch/i.test(key)
        ? REDACTED
        : sanitizeForAuthLog(entry),
    ])
  )
}

export const isAuthDiagnosticsEnabled = () => {
  const envValue = String(import.meta.env.VITE_HEALTHFLOW_AUTH_DIAGNOSTICS || '').toLowerCase()
  if (envValue === 'false') return false
  if (envValue === 'true') return true

  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem('healthflow_auth_diagnostics') === 'true'
  } catch {
    return false
  }
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
      failureCategory: classifyAuthFailure(result?.error, { authEndpoint: !label.includes('function') }),
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
      failureCategory: classifyAuthFailure(error, { authEndpoint: !label.includes('function') }),
      ...details,
    })
    throw error
  }
}

// Read only presence, never the stored session contents. A failed probe must
// never throw into authentication or substitute a new credential store.
export const inspectAuthStorage = (storageKey, windowObject = globalThis.window) => {
  const result = {}
  for (const name of ['localStorage', 'sessionStorage']) {
    const key = `healthflow.auth.probe.${Math.random().toString(36).slice(2)}`
    try {
      const storage = windowObject?.[name]
      if (!storage) throw new Error('Storage unavailable')
      storage.setItem(key, '1')
      result[`${name}Available`] = storage.getItem(key) === '1'
      storage.removeItem(key)
      result[`${name}SessionPresent`] = Boolean(storageKey && storage.getItem(storageKey))
    } catch {
      result[`${name}Available`] = false
    }
  }
  // Cookies are diagnostic only; Supabase continues using its existing store.
  const cookieKey = `healthflow_auth_probe_${Math.random().toString(36).slice(2)}`
  try {
    const documentObject = windowObject?.document
    if (!documentObject) throw new Error('Document unavailable')
    documentObject.cookie = `${cookieKey}=1; Path=/; SameSite=Strict`
    result.cookiesAvailable = documentObject.cookie.split(';').some(value => value.trim() === `${cookieKey}=1`)
    documentObject.cookie = `${cookieKey}=; Max-Age=0; Path=/; SameSite=Strict`
  } catch {
    result.cookiesAvailable = false
  }
  return result
}

export const logAuthSession = (event, session, storageKey) => {
  if (!isAuthDiagnosticsEnabled()) return
  const expiresAt = Number(session?.expires_at) || null
  logAuthDiagnostic('auth.session', {
    event, sessionPresent: Boolean(session),
    expiresAt, localTime: Date.now(),
    secondsUntilExpiry: expiresAt === null ? null : expiresAt - Math.floor(Date.now() / 1000),
    online: globalThis.navigator?.onLine !== false,
    ...inspectAuthStorage(storageKey),
  })
}

export const observeAuthEnvironment = (storageKey) => {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (event) => {
    if (event.key !== storageKey && event.key !== null) return
    logAuthDiagnostic('auth.storage.changed', {
      event: event.newValue === null ? 'STORAGE_REMOVED' : 'STORAGE_UPDATED',
      sessionPresent: event.newValue !== null,
    })
  }
  const onConnectivity = () => logAuthDiagnostic('auth.connectivity', { online: navigator.onLine })
  window.addEventListener('storage', onStorage)
  window.addEventListener('online', onConnectivity)
  window.addEventListener('offline', onConnectivity)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('online', onConnectivity)
    window.removeEventListener('offline', onConnectivity)
  }
}

export const logAuthServerClock = (response, startedAt, receivedAt = Date.now()) => {
  if (!isAuthDiagnosticsEnabled()) return
  const serverTime = Date.parse(response.headers.get('Date') || '')
  const serverTimeAvailable = Number.isFinite(serverTime)
  const clockSkewMs = serverTimeAvailable ? (startedAt + receivedAt) / 2 - serverTime : null
  logAuthDiagnostic('auth.clock', {
    localTime: receivedAt, serverTimeAvailable,
    serverTime: serverTimeAvailable ? serverTime : null, clockSkewMs,
    significantClockSkew: clockSkewMs !== null && Math.abs(clockSkewMs) > 120000,
  })
}
