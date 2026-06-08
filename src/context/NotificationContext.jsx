import { createContext, useCallback, useContext, useMemo, useState } from 'react'

const NotificationContext = createContext(null)
const DEFAULT_TOAST_DURATION_MS = 3500
const PERSISTENT_TOAST_TYPES = new Set(['warning'])

let nextToastId = 1

const getToastDuration = (type, duration) => {
  if (PERSISTENT_TOAST_TYPES.has(type)) {
    return 0
  }

  const parsedDuration = Number(duration)
  return Number.isFinite(parsedDuration) && parsedDuration > 0
    ? parsedDuration
    : DEFAULT_TOAST_DURATION_MS
}

export const NotificationProvider = ({ children }) => {
  const [toasts, setToasts] = useState([])

  const removeToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback(
    (message, type = 'info', duration = DEFAULT_TOAST_DURATION_MS) => {
      const id = nextToastId++
      setToasts((current) => [...current, { id, message, type }])
      const toastDuration = getToastDuration(type, duration)

      if (toastDuration > 0) {
        window.setTimeout(() => {
          removeToast(id)
        }, toastDuration)
      }
    },
    [removeToast]
  )

  const value = useMemo(
    () => ({
      notify,
      removeToast,
    }),
    [notify, removeToast]
  )

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-item toast-${toast.type}`}>
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              aria-label="Dismiss notification"
              title="Dismiss notification"
            >
              x
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
