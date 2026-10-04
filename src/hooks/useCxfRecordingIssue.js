import { useCallback, useEffect, useState } from 'react'

const read = (key) => {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null') } catch { return null }
}

// Keep the repair manifest across page remounts, scoped to the signed-in facility/user.
export function useCxfRecordingIssue(userId, organizationId) {
  const key = `cxf-recording:${userId || ''}:${organizationId || ''}`
  const [state, setState] = useState(() => ({ key, value: read(key) }))
  const value = state.key === key ? state.value : read(key)
  useEffect(() => {
    const update = (event) => {
      if (event.detail.key === key) setState(event.detail)
    }
    window.addEventListener('cxf-recording-change', update)
    return () => window.removeEventListener('cxf-recording-change', update)
  }, [key])
  const save = useCallback((next) => {
    try {
      if (next) sessionStorage.setItem(key, JSON.stringify(next))
      else sessionStorage.removeItem(key)
    } catch { /* In-memory retry remains available if browser storage is disabled. */ }
    setState({ key, value: next })
    window.dispatchEvent(new CustomEvent('cxf-recording-change', { detail: { key, value: next } }))
  }, [key])
  return [value, save]
}
