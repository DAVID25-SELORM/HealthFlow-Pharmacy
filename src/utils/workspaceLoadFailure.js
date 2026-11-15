// Why the workspace could not be loaded, in a form that is safe to keep and to show: a category
// only, never a message, user, organization or patient detail. The last few are kept on this
// device so staff and support can tell a slow connection from a busy server or a sign-in lock.
const STORAGE_KEY = 'healthflow_workspace_load_failures'
const MAX_KEPT = 10

const LABELS = Object.freeze({
  NETWORK_TIMEOUT: 'The server took too long to answer.',
  NETWORK_UNAVAILABLE: 'The connection to the server dropped.',
  SERVER_ERROR: 'The server is busy right now.',
  RATE_LIMITED: 'The server is receiving too many requests.',
  SIGN_IN_LOCK: 'Another HealthFlow tab or window on this computer is signing in.',
  PROFILE_MISSING: 'The staff profile was not returned.',
  ORGANIZATION_UNAVAILABLE: 'The pharmacy workspace was not returned.',
  UNKNOWN_ERROR: 'A temporary problem.',
})

export const categorizeWorkspaceLoadFailure = (error) => {
  if (typeof error === 'string') return LABELS[error] ? error : 'UNKNOWN_ERROR'
  const name = String(error?.name || '').toLowerCase()
  const message = String(error?.message || '').toLowerCase()
  const status = Number(error?.status ?? error?.statusCode ?? 0)

  if (name === 'navigatorlockacquiretimeouterror' || message.includes('lockmanager lock')) return 'SIGN_IN_LOCK'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'SERVER_ERROR'
  if (name === 'aborterror' || /timed? out|timeout/.test(message)) return 'NETWORK_TIMEOUT'
  if (/failed to fetch|networkerror|network request|load failed|unable to reach|internet connection/.test(message)) {
    return 'NETWORK_UNAVAILABLE'
  }
  return 'UNKNOWN_ERROR'
}

export const describeWorkspaceLoadFailure = (category) => LABELS[category] || LABELS.UNKNOWN_ERROR

const readStore = (storage) => {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.category === 'string') : []
  } catch {
    return []
  }
}

const defaultStorage = () => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export const recordWorkspaceLoadFailure = (errorOrCategory, { storage = defaultStorage(), now = Date.now() } = {}) => {
  const category = categorizeWorkspaceLoadFailure(errorOrCategory)
  try {
    const kept = [...readStore(storage), { at: new Date(now).toISOString(), category }].slice(-MAX_KEPT)
    storage?.setItem(STORAGE_KEY, JSON.stringify(kept))
  } catch {
    // Storage can be unavailable (private window, blocked site data); the screen still works.
  }
  return category
}

export const getRecentWorkspaceLoadFailures = ({ storage = defaultStorage() } = {}) => readStore(storage)

export const getLastWorkspaceLoadFailure = ({ storage = defaultStorage() } = {}) => {
  const all = readStore(storage)
  return all.length ? all[all.length - 1] : null
}
