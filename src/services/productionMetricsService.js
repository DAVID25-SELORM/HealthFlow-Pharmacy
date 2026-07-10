const MAX_RECENT_FAILURES = 30
const MAX_POLL_RUNS = 20

const metrics = {
  startedAt: new Date().toISOString(),
  concurrentRequests: 0,
  maxConcurrentRequests: 0,
  totalRequests: 0,
  retryCount: 0,
  tierAccess: new Map(),
  failedRequests: [],
  cache: new Map(),
  polling: {
    active: false,
    intervalMs: 0,
    subscriberCount: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastDurationMs: 0,
    lastStatus: 'idle',
    runs: [],
  },
}

const subscribers = new Set()

const nowIso = () => new Date().toISOString()

const getActionStats = (action = 'unknown') => {
  const key = String(action || 'unknown')
  if (!metrics.tierAccess.has(key)) {
    metrics.tierAccess.set(key, {
      action: key,
      count: 0,
      failures: 0,
      totalMs: 0,
      averageMs: 0,
      maxMs: 0,
      lastMs: 0,
      lastStatus: 'idle',
      lastSeenAt: null,
    })
  }
  return metrics.tierAccess.get(key)
}

const getCacheStats = (name = 'default') => {
  const key = String(name || 'default')
  if (!metrics.cache.has(key)) {
    metrics.cache.set(key, {
      name: key,
      hits: 0,
      misses: 0,
      hitRate: 0,
      lastEventAt: null,
    })
  }
  return metrics.cache.get(key)
}

const emit = () => {
  const snapshot = getProductionMetricsSnapshot()
  subscribers.forEach((subscriber) => {
    try {
      subscriber(snapshot)
    } catch (error) {
      console.warn('Production metrics subscriber failed:', error)
    }
  })
}

export const recordTierAccessStart = (action = 'unknown') => {
  metrics.concurrentRequests += 1
  metrics.totalRequests += 1
  metrics.maxConcurrentRequests = Math.max(metrics.maxConcurrentRequests, metrics.concurrentRequests)
  getActionStats(action).lastStatus = 'running'
  emit()
}

export const recordTierAccessEnd = ({ action = 'unknown', durationMs = 0, success = true, error = null } = {}) => {
  metrics.concurrentRequests = Math.max(0, metrics.concurrentRequests - 1)
  const stats = getActionStats(action)
  const roundedDuration = Math.max(0, Math.round(Number(durationMs) || 0))
  stats.count += 1
  stats.totalMs += roundedDuration
  stats.averageMs = Math.round(stats.totalMs / Math.max(1, stats.count))
  stats.maxMs = Math.max(stats.maxMs, roundedDuration)
  stats.lastMs = roundedDuration
  stats.lastStatus = success ? 'ok' : 'failed'
  stats.lastSeenAt = nowIso()

  if (!success) {
    stats.failures += 1
    metrics.failedRequests.unshift({
      action: String(action || 'unknown'),
      message: error?.message || String(error || 'Request failed.'),
      durationMs: roundedDuration,
      at: nowIso(),
    })
    metrics.failedRequests = metrics.failedRequests.slice(0, MAX_RECENT_FAILURES)
  }

  console.info('[HealthFlow metrics] tier-access', {
    action: stats.action,
    averageMs: stats.averageMs,
    lastMs: stats.lastMs,
    concurrentRequests: metrics.concurrentRequests,
    failures: stats.failures,
  })
  emit()
}

export const recordCacheEvent = (name, event) => {
  const stats = getCacheStats(name)
  if (event === 'hit') {
    stats.hits += 1
  } else {
    stats.misses += 1
  }
  const total = stats.hits + stats.misses
  stats.hitRate = total ? Math.round((stats.hits / total) * 100) : 0
  stats.lastEventAt = nowIso()
  emit()
}

export const recordRetry = (label = 'request') => {
  metrics.retryCount += 1
  console.info('[HealthFlow metrics] retry', { label, retryCount: metrics.retryCount })
  emit()
}

export const setPollingStatus = (status = {}) => {
  metrics.polling = {
    ...metrics.polling,
    ...status,
  }
  emit()
}

export const recordPollingRun = ({ label = 'system-health', durationMs = 0, status = 'ok' } = {}) => {
  const roundedDuration = Math.max(0, Math.round(Number(durationMs) || 0))
  const finishedAt = nowIso()
  metrics.polling.lastFinishedAt = finishedAt
  metrics.polling.lastDurationMs = roundedDuration
  metrics.polling.lastStatus = status
  metrics.polling.runs.unshift({
    label,
    durationMs: roundedDuration,
    status,
    finishedAt,
  })
  metrics.polling.runs = metrics.polling.runs.slice(0, MAX_POLL_RUNS)
  console.info('[HealthFlow metrics] polling', {
    label,
    durationMs: roundedDuration,
    status,
  })
  emit()
}

export const getProductionMetricsSnapshot = () => {
  const tierAccess = Array.from(metrics.tierAccess.values())
    .map((item) => ({ ...item }))
    .sort((a, b) => b.averageMs - a.averageMs)
  const cache = Array.from(metrics.cache.values()).map((item) => ({ ...item }))
  const totalDuration = tierAccess.reduce((sum, item) => sum + item.totalMs, 0)
  const totalCompleted = tierAccess.reduce((sum, item) => sum + item.count, 0)

  return {
    startedAt: metrics.startedAt,
    averageApiLatencyMs: totalCompleted ? Math.round(totalDuration / totalCompleted) : 0,
    concurrentRequests: metrics.concurrentRequests,
    maxConcurrentRequests: metrics.maxConcurrentRequests,
    totalRequests: metrics.totalRequests,
    retryCount: metrics.retryCount,
    tierAccess,
    slowestEndpoints: tierAccess.slice(0, 8),
    failedRequests: [...metrics.failedRequests],
    cache,
    polling: {
      ...metrics.polling,
      runs: [...metrics.polling.runs],
    },
  }
}

export const subscribeProductionMetrics = (subscriber) => {
  subscribers.add(subscriber)
  subscriber(getProductionMetricsSnapshot())
  return () => subscribers.delete(subscriber)
}

export const resetProductionMetrics = () => {
  metrics.startedAt = nowIso()
  metrics.concurrentRequests = 0
  metrics.maxConcurrentRequests = 0
  metrics.totalRequests = 0
  metrics.retryCount = 0
  metrics.tierAccess.clear()
  metrics.failedRequests = []
  metrics.cache.clear()
  metrics.polling = {
    active: false,
    intervalMs: 0,
    subscriberCount: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastDurationMs: 0,
    lastStatus: 'idle',
    runs: [],
  }
  emit()
}
