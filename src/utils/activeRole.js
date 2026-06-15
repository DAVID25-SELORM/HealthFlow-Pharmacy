export const ACTIVE_ROLE_STORAGE_KEY = 'healthflow.active-role.current'

export const getStoredActiveRole = () => {
  if (typeof window === 'undefined') return ''
  return String(window.localStorage.getItem(ACTIVE_ROLE_STORAGE_KEY) || '').trim().toLowerCase()
}

export const storeActiveRole = (role) => {
  if (typeof window === 'undefined') return ''
  const normalizedRole = String(role || '').trim().toLowerCase()
  if (normalizedRole) {
    window.localStorage.setItem(ACTIVE_ROLE_STORAGE_KEY, normalizedRole)
  } else {
    window.localStorage.removeItem(ACTIVE_ROLE_STORAGE_KEY)
  }
  return normalizedRole
}
