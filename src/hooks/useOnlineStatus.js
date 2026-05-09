import { useEffect, useState } from 'react'

const getCurrentOnlineStatus = () =>
  typeof navigator === 'undefined' ? true : navigator.onLine

export const useOnlineStatus = () => {
  const [isOnline, setIsOnline] = useState(getCurrentOnlineStatus)

  useEffect(() => {
    const updateStatus = () => setIsOnline(getCurrentOnlineStatus())

    window.addEventListener('online', updateStatus)
    window.addEventListener('offline', updateStatus)
    updateStatus()

    return () => {
      window.removeEventListener('online', updateStatus)
      window.removeEventListener('offline', updateStatus)
    }
  }, [])

  return isOnline
}
