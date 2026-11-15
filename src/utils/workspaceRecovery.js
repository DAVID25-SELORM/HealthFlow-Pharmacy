// Keep retries bounded and serialize timer, manual, and reconnect requests.
//
// After the quick retries (2s, 5s, 15s) fail, the page is reloaded once if a `reload` function is
// given and it agrees (see workspaceAutoReload), then the recovery keeps trying every 30 seconds,
// up to a limit, so a shop is not left on a dead screen waiting for a click.
export const createWorkspaceRecovery = (retry, { reload, steadyDelayMs = 30000, maxSteadyAttempts = 40 } = {}) => {
  let timer
  let attempts = 0
  let steadyAttempts = 0
  let failed = false
  let stopped = false
  let pending = false
  let reloadTried = false
  const delays = [2000, 5000, 15000]
  const schedule = () => {
    clearTimeout(timer)
    if (stopped || !failed) return
    if (attempts < delays.length) {
      timer = setTimeout(() => { attempts += 1; void run() }, delays[attempts])
      return
    }
    if (!reloadTried && typeof reload === 'function') {
      reloadTried = true
      let reloading = false
      try { reloading = reload() === true } catch { reloading = false }
      // The page is being replaced: nothing more to schedule.
      if (reloading) return
    }
    if (steadyAttempts < maxSteadyAttempts) {
      timer = setTimeout(() => { steadyAttempts += 1; void run() }, steadyDelayMs)
    }
  }
  const run = async () => {
    if (stopped || !failed || pending) return
    clearTimeout(timer)
    pending = true
    try { await retry() } finally { pending = false; schedule() }
  }
  return {
    update(value) {
      failed = value
      if (!failed) {
        attempts = 0
        steadyAttempts = 0
        reloadTried = false
      }
      if (!pending) schedule()
    },
    retry: run,
    stop() { stopped = true; clearTimeout(timer) },
  }
}
