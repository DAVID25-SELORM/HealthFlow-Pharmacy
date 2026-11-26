// How this browser proves itself to the offline server that served it. A computer is registered by opening HealthFlow
// from its "HealthFlow Offline POS" shortcut, which carries the computer's own id and secret. They are saved in this
// browser and sent with each request. The server's own key is never given to a browser.
const WORKSTATION_ID_KEY = 'healthflow.workstation.id'
const WORKSTATION_SECRET_KEY = 'healthflow.workstation.secret'

const captureWorkstationEnrollment = () => {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const id = url.searchParams.get('workstationId') || ''
  const secret = url.searchParams.get('workstationSecret') || ''
  if (!id || !secret) return
  window.localStorage.setItem(WORKSTATION_ID_KEY, id)
  window.localStorage.setItem(WORKSTATION_SECRET_KEY, secret)
  url.searchParams.delete('workstationId')
  url.searchParams.delete('workstationSecret')
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`)
}

// Runs as soon as this module loads: before anything checks the connection, and before the address can change.
captureWorkstationEnrollment()

export const getHostedBranchConfig = () =>
  typeof window === 'undefined' ? {} : window.__HEALTHFLOW_BRANCH_SERVER__ || {}

// True only when this page came from an offline (branch) server, which says so in /branch-runtime-config.js.
// The online website is never one, even when it has been connected to a branch server.
export const isServedByOfflineServer = () => getHostedBranchConfig().enabled === true

// The offline server says so when its records belong to another pharmacy. The app then leaves it alone.
export const isOfflineServerLocked = () => getHostedBranchConfig().dataLocked === true

export const getWorkstationHeaders = () => {
  if (typeof window === 'undefined') return {}
  try {
    const id = window.localStorage.getItem(WORKSTATION_ID_KEY)
    if (!id) return {}
    return {
      'x-healthflow-workstation-id': id,
      'x-healthflow-workstation-secret': window.localStorage.getItem(WORKSTATION_SECRET_KEY) || '',
    }
  } catch {
    return {}
  }
}

// A registered computer, using the very server that served the page. Its registration means nothing to another one.
export const isRegisteredForServer = (serverUrl) => {
  if (!isServedByOfflineServer() || !getWorkstationHeaders()['x-healthflow-workstation-secret']) return false
  try {
    return new URL(serverUrl, window.location.origin).origin === window.location.origin
  } catch {
    return false
  }
}
