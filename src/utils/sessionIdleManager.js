export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'scroll']

export const getSessionActivityStorageKey = (userId) =>
  `healthflow.session.lastActivity.${String(userId || 'unknown')}`

export const recordSessionActivity = (
  userId,
  { windowObject = globalThis.window, timestamp = Date.now() } = {}
) => {
  if (!userId || !windowObject?.localStorage) return
  windowObject.localStorage.setItem(getSessionActivityStorageKey(userId), String(timestamp))
}

export const startSessionIdleMonitor = ({
  userId,
  onIdle,
  timeoutMs = SESSION_IDLE_TIMEOUT_MS,
  windowObject = globalThis.window,
  documentObject = globalThis.document,
  now = () => Date.now(),
}) => {
  if (!userId || typeof onIdle !== 'function' || !windowObject || !documentObject) {
    return () => {}
  }

  const storageKey = getSessionActivityStorageKey(userId)
  let timeoutId = null
  let stopped = false
  let idleTriggered = false

  const readLastActivity = () => {
    const value = Number(windowObject.localStorage?.getItem(storageKey))
    return Number.isFinite(value) && value > 0 ? value : null
  }

  const writeLastActivity = (value) => recordSessionActivity(userId, { windowObject, timestamp: value })

  const triggerIdle = () => {
    if (stopped || idleTriggered) return
    idleTriggered = true
    if (timeoutId !== null) windowObject.clearTimeout(timeoutId)
    void onIdle()
  }

  const scheduleCheck = () => {
    if (stopped || idleTriggered) return
    if (timeoutId !== null) windowObject.clearTimeout(timeoutId)

    const lastActivity = readLastActivity()
    const remainingMs = lastActivity === null ? timeoutMs : timeoutMs - (now() - lastActivity)
    if (remainingMs <= 0) {
      triggerIdle()
      return
    }

    timeoutId = windowObject.setTimeout(scheduleCheck, remainingMs)
  }

  const recordActivity = () => {
    if (stopped || idleTriggered) return
    writeLastActivity(now())
    scheduleCheck()
  }

  const handleVisibilityChange = () => {
    if (documentObject.visibilityState === 'visible') scheduleCheck()
  }

  const handleStorage = (event) => {
    if (event.key === storageKey) scheduleCheck()
  }

  if (readLastActivity() === null) writeLastActivity(now())
  ACTIVITY_EVENTS.forEach((eventName) => {
    windowObject.addEventListener(eventName, recordActivity, { passive: true })
  })
  documentObject.addEventListener('visibilitychange', handleVisibilityChange)
  windowObject.addEventListener('storage', handleStorage)
  scheduleCheck()

  return () => {
    stopped = true
    if (timeoutId !== null) windowObject.clearTimeout(timeoutId)
    ACTIVITY_EVENTS.forEach((eventName) => {
      windowObject.removeEventListener(eventName, recordActivity)
    })
    documentObject.removeEventListener('visibilitychange', handleVisibilityChange)
    windowObject.removeEventListener('storage', handleStorage)
  }
}
