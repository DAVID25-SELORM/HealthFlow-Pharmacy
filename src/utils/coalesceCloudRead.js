import { getCachedSupabaseSession } from '../lib/supabase'

// Share only pending reads with identical arguments and the same session object.
// Completed results are never cached: a later refresh sees fresh stock/claims.
export const createCoalescedCloudRead = () => {
  const sessions = new WeakMap()
  return (key, read) => {
    const session = getCachedSupabaseSession()
    if (!session) return read()
    let requests = sessions.get(session)
    if (!requests) { requests = new Map(); sessions.set(session, requests) }
    if (requests.has(key)) return requests.get(key)
    const request = Promise.resolve().then(read).finally(() => requests.delete(key))
    requests.set(key, request)
    return request
  }
}
