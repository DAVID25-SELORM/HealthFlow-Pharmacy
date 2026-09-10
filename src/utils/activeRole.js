import { logAuthDiagnostic } from './authDiagnostics'

export const ACTIVE_ROLE_STORAGE_KEY = 'healthflow.active-role.current'

export const readRolePreference = (key) => {
  try { return window.localStorage.getItem(key) || '' } catch {
    logAuthDiagnostic('auth.role.storage', { reason: 'STORAGE_UNAVAILABLE' })
    return ''
  }
}

export const writeRolePreference = (key, value) => {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    logAuthDiagnostic('auth.role.storage', { reason: 'STORAGE_UNAVAILABLE' })
  }
}

export const getStoredActiveRole = () => {
  if (typeof window === 'undefined') return ''
  return String(readRolePreference(ACTIVE_ROLE_STORAGE_KEY)).trim().toLowerCase()
}

export const storeActiveRole = (role) => {
  if (typeof window === 'undefined') return ''
  const normalizedRole = String(role || '').trim().toLowerCase()
  writeRolePreference(ACTIVE_ROLE_STORAGE_KEY, normalizedRole)
  return normalizedRole
}
