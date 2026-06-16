export const isDebugLoggingEnabled = () => {
  const envEnabled = String(import.meta.env.VITE_HEALTHFLOW_DEBUG_LOGS || '').toLowerCase() === 'true'
  if (envEnabled) return true

  if (typeof window === 'undefined') return false
  return window.localStorage.getItem('healthflow_debug_logs') === 'true'
}

export const debugInfo = (...args) => {
  if (isDebugLoggingEnabled()) {
    console.info(...args)
  }
}

export const debugLog = (...args) => {
  if (isDebugLoggingEnabled()) {
    console.log(...args)
  }
}
