const MAX_RECENT_FAILURES = 30
const MAX_POLL_RUNS = 20
const HISTORY_STORAGE_KEY = 'healthflow_production_metrics_history_v1'
const ALERT_STORAGE_KEY = 'healthflow_production_metrics_alerts_v1'
const HISTORY_SAMPLE_INTERVAL_MS = 60 * 1000
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const ALERT_COOLDOWN_MS = 10 * 60 * 1000

export const PRODUCTION_METRIC_THRESHOLDS = {
  averageLatencyMs: 5000,
  latencyConsecutiveMinutes: 5,
  peakConcurrentRequests: 20,
  retrySpikePerMinute: 5,
  cacheHitRatePercent: 40,
  healthFailureConsecutiveRuns: 3,
}

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
let history = null

const nowIso = () => new Date().toISOString()

const isMetricsConsoleEnabled = () => {
  const envValue = String(import.meta.env.VITE_HEALTHFLOW_METRICS_CONSOLE || '').toLowerCase()
  if (envValue === 'true') return true
  if (envValue === 'false') return false
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem('healthflow_metrics_console') === 'true'
}

const logMetrics = (...args) => {
  if (isMetricsConsoleEnabled()) {
    console.info(...args)
  }
}

const readJson = (key, fallback) => {
  if (typeof window === 'undefined') return fallback
  try {
    const value = window.localStorage.getItem(key)
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

const writeJson = (key, value) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn('Unable to persist production metrics:', error)
  }
}

const getHistory = () => {
  if (!history) {
    const saved = readJson(HISTORY_STORAGE_KEY, [])
    history = Array.isArray(saved) ? saved : []
  }
  return history
}

const pruneHistory = () => {
  const cutoff = Date.now() - HISTORY_RETENTION_MS
  history = getHistory().filter((sample) => Number(sample.atMs || 0) >= cutoff)
  return history
}

const getCacheTotals = () => {
  const cache = Array.from(metrics.cache.values())
  const hits = cache.reduce((sum, item) => sum + item.hits, 0)
  const misses = cache.reduce((sum, item) => sum + item.misses, 0)
  const total = hits + misses
  return {
    hits,
    misses,
    hitRate: total ? Math.round((hits / total) * 100) : 0,
  }
}

const getFailedHealthRunCount = () => metrics.polling.runs
  .slice(0, PRODUCTION_METRIC_THRESHOLDS.healthFailureConsecutiveRuns)
  .filter((run) => ['fail', 'failed'].includes(String(run.status || '').toLowerCase()))
  .length

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

  logMetrics('[HealthFlow metrics] api', {
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
  logMetrics('[HealthFlow metrics] retry', { label, retryCount: metrics.retryCount })
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
  logMetrics('[HealthFlow metrics] polling', {
    label,
    durationMs: roundedDuration,
    status,
  })
  emit()
}

export const recordProductionMetricsSample = ({ force = false } = {}) => {
  const currentHistory = pruneHistory()
  const now = Date.now()
  const lastSample = currentHistory[currentHistory.length - 1]
  if (!force && lastSample && now - Number(lastSample.atMs || 0) < HISTORY_SAMPLE_INTERVAL_MS) {
    return lastSample
  }

  const tierAccess = Array.from(metrics.tierAccess.values())
  const totalDuration = tierAccess.reduce((sum, item) => sum + item.totalMs, 0)
  const totalCompleted = tierAccess.reduce((sum, item) => sum + item.count, 0)
  const cacheTotals = getCacheTotals()
  const sample = {
    at: nowIso(),
    atMs: now,
    averageApiLatencyMs: totalCompleted ? Math.round(totalDuration / totalCompleted) : 0,
    concurrentRequests: metrics.concurrentRequests,
    maxConcurrentRequests: metrics.maxConcurrentRequests,
    retryCount: metrics.retryCount,
    cacheHitRate: cacheTotals.hitRate,
    failedRequestCount: metrics.failedRequests.length,
    pollingStatus: metrics.polling.lastStatus || 'idle',
    pollingDurationMs: metrics.polling.lastDurationMs || 0,
    healthFailureCount: getFailedHealthRunCount(),
  }

  currentHistory.push(sample)
  history = currentHistory
  writeJson(HISTORY_STORAGE_KEY, history)
  emit()
  return sample
}

const getWindowSamples = (windowMs) => {
  const cutoff = Date.now() - windowMs
  return pruneHistory().filter((sample) => Number(sample.atMs || 0) >= cutoff)
}

const getTrendSummary = (label, windowMs) => {
  const samples = getWindowSamples(windowMs)
  const count = samples.length
  const average = (field) => count
    ? Math.round(samples.reduce((sum, sample) => sum + Number(sample[field] || 0), 0) / count)
    : 0
  const max = (field) => samples.reduce((highest, sample) => Math.max(highest, Number(sample[field] || 0)), 0)
  const last = samples[count - 1] || null

  return {
    label,
    sampleCount: count,
    averageApiLatencyMs: average('averageApiLatencyMs'),
    peakConcurrentRequests: max('maxConcurrentRequests'),
    retryCountDelta: count ? Math.max(0, Number(last?.retryCount || 0) - Number(samples[0]?.retryCount || 0)) : 0,
    averageCacheHitRate: average('cacheHitRate'),
    failedRequestPeak: max('failedRequestCount'),
    pollingAverageMs: average('pollingDurationMs'),
  }
}

export const getProductionMetricsHistory = () => ({
  samples: [...pruneHistory()],
  windows: [
    getTrendSummary('24 hours', 24 * 60 * 60 * 1000),
    getTrendSummary('7 days', 7 * 24 * 60 * 60 * 1000),
    getTrendSummary('30 days', 30 * 24 * 60 * 60 * 1000),
  ],
})

const getRecentMinuteSamples = (minutes) =>
  getWindowSamples(minutes * 60 * 1000)

const createAlert = (id, title, detail, severity = 'warning') => ({
  id,
  title,
  detail,
  severity,
  at: nowIso(),
})

export const evaluateProductionMetricAlerts = () => {
  const alerts = []
  const recentLatency = getRecentMinuteSamples(PRODUCTION_METRIC_THRESHOLDS.latencyConsecutiveMinutes)
  const enoughLatencySamples = recentLatency.length >= PRODUCTION_METRIC_THRESHOLDS.latencyConsecutiveMinutes
  if (
    enoughLatencySamples &&
    recentLatency.every((sample) => Number(sample.averageApiLatencyMs || 0) > PRODUCTION_METRIC_THRESHOLDS.averageLatencyMs)
  ) {
    alerts.push(createAlert(
      'latency-5-minutes',
      'Average API latency is high',
      `Average API latency has stayed above ${Math.round(PRODUCTION_METRIC_THRESHOLDS.averageLatencyMs / 1000)} seconds for ${PRODUCTION_METRIC_THRESHOLDS.latencyConsecutiveMinutes} consecutive minutes.`
    ))
  }

  if (metrics.maxConcurrentRequests > PRODUCTION_METRIC_THRESHOLDS.peakConcurrentRequests) {
    alerts.push(createAlert(
      'peak-concurrency',
      'Peak concurrent requests exceeded threshold',
      `Peak concurrent requests reached ${metrics.maxConcurrentRequests}; threshold is ${PRODUCTION_METRIC_THRESHOLDS.peakConcurrentRequests}.`
    ))
  }

  const lastTwo = getRecentMinuteSamples(2)
  if (lastTwo.length >= 2) {
    const retryDelta = Number(lastTwo[lastTwo.length - 1]?.retryCount || 0) - Number(lastTwo[0]?.retryCount || 0)
    if (retryDelta >= PRODUCTION_METRIC_THRESHOLDS.retrySpikePerMinute) {
      alerts.push(createAlert(
        'retry-spike',
        'Retry count spiked',
        `${retryDelta} retries were recorded recently; threshold is ${PRODUCTION_METRIC_THRESHOLDS.retrySpikePerMinute}.`
      ))
    }
  }

  const cacheTotals = getCacheTotals()
  if (
    cacheTotals.hits + cacheTotals.misses >= 10 &&
    cacheTotals.hitRate < PRODUCTION_METRIC_THRESHOLDS.cacheHitRatePercent
  ) {
    alerts.push(createAlert(
      'cache-hit-rate',
      'Cache hit rate is low',
      `Cache hit rate is ${cacheTotals.hitRate}%; threshold is ${PRODUCTION_METRIC_THRESHOLDS.cacheHitRatePercent}%.`
    ))
  }

  if (getFailedHealthRunCount() >= PRODUCTION_METRIC_THRESHOLDS.healthFailureConsecutiveRuns) {
    alerts.push(createAlert(
      'health-check-failures',
      'Health checks are failing repeatedly',
      `${PRODUCTION_METRIC_THRESHOLDS.healthFailureConsecutiveRuns} recent health check runs failed.`
    ))
  }

  return alerts
}

export const filterNewProductionMetricAlerts = (alerts = []) => {
  const now = Date.now()
  const sentAlerts = readJson(ALERT_STORAGE_KEY, {})
  const freshAlerts = alerts.filter((alert) => {
    const lastSentAt = Number(sentAlerts[alert.id] || 0)
    return now - lastSentAt >= ALERT_COOLDOWN_MS
  })

  if (freshAlerts.length) {
    freshAlerts.forEach((alert) => {
      sentAlerts[alert.id] = now
    })
    writeJson(ALERT_STORAGE_KEY, sentAlerts)
  }

  return freshAlerts
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
    history: getProductionMetricsHistory(),
    thresholds: { ...PRODUCTION_METRIC_THRESHOLDS },
    activeAlerts: evaluateProductionMetricAlerts(),
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
  history = []
  writeJson(HISTORY_STORAGE_KEY, history)
  writeJson(ALERT_STORAGE_KEY, {})
  emit()
}
