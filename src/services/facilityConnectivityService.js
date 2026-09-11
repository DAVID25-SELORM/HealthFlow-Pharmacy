import { supabase } from '../lib/supabase'

export const recordFacilityBrowserContact = async () => {
  const { error } = await supabase.rpc('record_facility_browser_contact')
  if (error) throw error
}

export const getFacilityConnectivity = async () => {
  const { data, error } = await supabase.rpc('get_facility_connectivity')
  if (error) throw error
  if (!data || !Array.isArray(data.facilities) || !data.checkedAt || data.facilities.some((facility) => !['ONLINE', 'RECENTLY_ACTIVE', 'ATTENTION_REQUIRED', 'OFFLINE', 'NEVER_CONNECTED'].includes(facility.connectivityStatus))) {
    throw new Error('Facility connectivity response is unavailable.')
  }
  return data
}

// One contact per minute while a signed-in workspace is visible. This does
// not renew authentication, extend idle timeouts or queue offline requests.
export const startFacilityContactReporting = ({ send = recordFacilityBrowserContact } = {}) => {
  let stopped = false
  let pending = false
  let lastAttempt = -Infinity
  const report = async () => {
    if (stopped || pending || document.visibilityState === 'hidden' || navigator.onLine === false) return
    if (Date.now() - lastAttempt < 60000) return
    pending = true
    lastAttempt = Date.now()
    try { await send() } catch { /* Optional telemetry must not interrupt staff work. */ }
    finally { pending = false }
  }
  void report()
  const timer = window.setInterval(() => void report(), 60000)
  document.addEventListener('visibilitychange', report)
  window.addEventListener('online', report)
  return () => {
    stopped = true
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', report)
    window.removeEventListener('online', report)
  }
}
