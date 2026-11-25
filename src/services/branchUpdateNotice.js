// One shared watch for "an update is waiting" on an offline server. The menu, the phone bar and the notice at the
// top of the page all read it, so the server is asked once, not once by each of them.
import { getBranchUpdateNotice, isServedByOfflineServer } from './branchServerApi'

export const UPDATE_NOTICE_POLL_MS = 2 * 60 * 1000

const listeners = new Set()
let notice = null
let timer = null
// The version this page was opened with. If the server later reports another, the page is showing old screens.
let openedVersion = ''

export const refreshBranchUpdateNotice = async () => {
  if (!isServedByOfflineServer()) return null
  try {
    const next = await getBranchUpdateNotice()
    openedVersion = openedVersion || next.currentVersion || ''
    notice = {
      ...next,
      reloadNeeded: Boolean(openedVersion && next.currentVersion && next.currentVersion !== openedVersion),
    }
    listeners.forEach((listener) => listener(notice))
  } catch {
    // Not signed in to the offline server yet, or it is restarting: keep what is already known.
  }
  return notice
}

const refreshWhenBack = () => {
  if (document.visibilityState !== 'hidden') void refreshBranchUpdateNotice()
}

const stop = () => {
  window.clearInterval(timer)
  timer = null
  window.removeEventListener('online', refreshWhenBack)
  document.removeEventListener('visibilitychange', refreshWhenBack)
}

export const subscribeBranchUpdateNotice = (listener) => {
  listeners.add(listener)
  listener(notice)
  if (!timer && isServedByOfflineServer()) {
    timer = window.setInterval(() => void refreshBranchUpdateNotice(), UPDATE_NOTICE_POLL_MS)
    window.addEventListener('online', refreshWhenBack)
    document.addEventListener('visibilitychange', refreshWhenBack)
    void refreshBranchUpdateNotice()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      stop()
      notice = null
    }
  }
}
