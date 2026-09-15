// Keep retries bounded and serialize timer, manual, and reconnect requests.
export const createWorkspaceRecovery = (retry) => {
  let timer
  let attempts = 0
  let failed = false
  let stopped = false
  let pending = false
  const delays = [2000, 5000, 15000]
  const schedule = () => {
    clearTimeout(timer)
    if (!stopped && failed && attempts < delays.length) {
      timer = setTimeout(() => { attempts += 1; void run() }, delays[attempts])
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
      if (!failed) attempts = 0
      if (!pending) schedule()
    },
    retry: run,
    stop() { stopped = true; clearTimeout(timer) },
  }
}
