import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'

const NotificationContext = createContext(null)

// Timed toasts (info / success) stay long enough to be read: a base time plus
// a little per character, capped so a very long message does not linger.
const BASE_TOAST_DURATION_MS = 3500
const MS_PER_CHARACTER = 40
const MAX_AUTO_TOAST_DURATION_MS = 12000
const MAX_VISIBLE_TOASTS = 6

// Errors and warnings carry something the user has to read and act on, so
// they stay until the user dismisses them.
const PERSISTENT_TOAST_TYPES = new Set(['warning', 'error'])

let nextToastId = 1

export const getToastDuration = (type, duration, message = '') => {
  if (PERSISTENT_TOAST_TYPES.has(type)) {
    return 0
  }

  // A caller can opt any other toast into explicit acknowledgement.
  if (duration === 0) {
    return 0
  }

  // A caller that asks for a specific duration gets exactly that.
  const parsedDuration = Number(duration)
  if (duration !== undefined && duration !== null && Number.isFinite(parsedDuration) && parsedDuration > 0) {
    return parsedDuration
  }

  const length = typeof message === 'string' ? message.length : 0
  return Math.min(MAX_AUTO_TOAST_DURATION_MS, BASE_TOAST_DURATION_MS + MS_PER_CHARACTER * length)
}

export const NotificationProvider = ({ children }) => {
  const [toasts, setToasts] = useState([])
  // toastsRef mirrors state so notify() can see what is already on screen.
  const toastsRef = useRef([])
  const timersRef = useRef(new Map())
  const durationsRef = useRef(new Map())

  const commit = useCallback((next) => {
    toastsRef.current = next
    setToasts(next)
  }, [])

  const clearTimer = useCallback((id) => {
    const handle = timersRef.current.get(id)
    if (handle !== undefined) {
      window.clearTimeout(handle)
      timersRef.current.delete(id)
    }
  }, [])

  const removeToast = useCallback(
    (id) => {
      clearTimer(id)
      durationsRef.current.delete(id)
      commit(toastsRef.current.filter((toast) => toast.id !== id))
    },
    [clearTimer, commit]
  )

  const startTimer = useCallback(
    (id) => {
      clearTimer(id)
      const duration = durationsRef.current.get(id)
      if (!duration) return
      timersRef.current.set(
        id,
        window.setTimeout(() => {
          removeToast(id)
        }, duration)
      )
    },
    [clearTimer, removeToast]
  )

  const clearToasts = useCallback(() => {
    for (const handle of timersRef.current.values()) {
      window.clearTimeout(handle)
    }
    timersRef.current.clear()
    durationsRef.current.clear()
    commit([])
  }, [commit])

  const notify = useCallback(
    (message, type = 'info', duration) => {
      const toastDuration = getToastDuration(type, duration, message)

      // The same message is already showing: do not stack a copy of it. A timed
      // toast just starts its countdown again.
      const duplicate = typeof message === 'string'
        ? toastsRef.current.find((toast) => toast.type === type && toast.message === message)
        : undefined
      if (duplicate) {
        durationsRef.current.set(duplicate.id, toastDuration)
        startTimer(duplicate.id)
        return
      }

      const id = nextToastId++
      durationsRef.current.set(id, toastDuration)
      const next = [...toastsRef.current, { id, message, type }]
      while (next.length > MAX_VISIBLE_TOASTS) {
        const dropped = next.shift()
        clearTimer(dropped.id)
        durationsRef.current.delete(dropped.id)
      }
      commit(next)
      startTimer(id)
    },
    [clearTimer, commit, startTimer]
  )

  const value = useMemo(
    () => ({
      notify,
      removeToast,
      clearToasts,
    }),
    [notify, removeToast, clearToasts]
  )

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return
      const newest = toastsRef.current[toastsRef.current.length - 1]
      if (newest) removeToast(newest.id)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [removeToast])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const handle of timers.values()) {
        window.clearTimeout(handle)
      }
      timers.clear()
    }
  }, [])

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.length > 1 && (
          <button className="toast-dismiss-all" type="button" onClick={clearToasts}>
            Dismiss all notifications
          </button>
        )}
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast-item toast-${toast.type}`}
            // Reading a toast pauses its countdown; it restarts when the pointer or focus leaves.
            onMouseEnter={() => clearTimer(toast.id)}
            onMouseLeave={() => startTimer(toast.id)}
            onFocus={() => clearTimer(toast.id)}
            onBlur={() => startTimer(toast.id)}
          >
            <span className="toast-message">{toast.message}</span>
            <button
              className="toast-dismiss"
              type="button"
              onClick={() => removeToast(toast.id)}
              aria-label="Dismiss notification"
              title="Dismiss notification"
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </NotificationContext.Provider>
  )
}

export const useNotification = () => {
  const context = useContext(NotificationContext)
  if (!context) {
    throw new Error('useNotification must be used within NotificationProvider')
  }
  return context
}
