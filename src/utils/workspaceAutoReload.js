// When the workspace still cannot be loaded after the quick automatic retries, reload the page once,
// which is what staff do by hand and what fixes it. Bounded by a cooldown so it can never loop, and
// skipped while the device is offline (a reload with no connection would only lose the retained page).
const RELOAD_KEY = 'healthflow_workspace_reload_at'
export const WORKSPACE_RELOAD_COOLDOWN_MS = 5 * 60 * 1000

export const reloadWorkspaceOnce = ({
  now = Date.now(),
  storage = typeof window !== 'undefined' ? window.sessionStorage : null,
  reload = () => window.location.reload(),
  online = typeof navigator === 'undefined' ? true : navigator.onLine !== false,
} = {}) => {
  if (!online) return false
  let lastAt = 0
  try {
    lastAt = Number(storage?.getItem(RELOAD_KEY) || 0)
  } catch {
    return false
  }
  if (Number.isFinite(lastAt) && lastAt > 0 && now - lastAt < WORKSPACE_RELOAD_COOLDOWN_MS) return false
  try {
    storage?.setItem(RELOAD_KEY, String(now))
  } catch {
    // Without storage the cooldown cannot be kept, so never reload automatically.
    return false
  }
  reload()
  return true
}
