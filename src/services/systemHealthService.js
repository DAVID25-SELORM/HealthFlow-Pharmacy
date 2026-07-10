import { getCurrentSupabaseUser, isSupabaseConfigured, supabase } from '../lib/supabase'
import { isNetworkRequestError } from '../utils/requestErrors'
import { getStoredActiveRole } from '../utils/activeRole'
import { REPORT_ROLES, hasRole } from '../utils/roles'
import { getBranchServerConfig, getBranchServerHealth } from './branchServerApi'
import {
  recordCacheEvent,
  recordPollingRun,
  recordRetry,
  setPollingStatus,
} from './productionMetricsService'
import { invokeTierAccess } from './tierAccessService'

const ok = (label, details = {}) => ({ label, status: 'ok', ...details })
const warn = (label, details = {}) => ({ label, status: 'warn', ...details })
const fail = (label, details = {}) => ({ label, status: 'fail', ...details })

const HEALTH_TIMEOUT_MS = 12000
const HEALTH_CACHE_MS = 5 * 60 * 1000
const HEALTH_BACKOFF_BASE_MS = 30 * 1000
const HEALTH_BACKOFF_MAX_MS = 5 * 60 * 1000
const AUTH_WARN_MS = 2500
const REST_WARN_MS = 3000

let cachedHealth = null
let cachedHealthKey = ''
let cachedHealthAt = 0
let healthInFlight = null
let healthInFlightKey = ''
let failureCount = 0
let nextAllowedCheckAt = 0
let pollTimer = null
let pollRunning = false
let pollAbortController = null
let pollOptions = null
const pollSubscribers = new Set()

const getSupabaseUrl = () => (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
const getSupabaseKey = () =>
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  ''

const formatError = (error) =>
  error?.message || error?.error_description || 'Check failed.'

const isBrowserOffline = () =>
  typeof navigator !== 'undefined' && navigator.onLine === false

const createNetworkCheck = () =>
  isBrowserOffline()
    ? warn('Network connection', {
        summary: 'Offline',
        detail: 'This browser is offline. Health checks will resume when the internet connection returns.',
      })
    : ok('Network connection', {
        summary: 'Online',
        detail: 'Browser network status is online.',
      })

const createOfflineHealth = () => ({
  checkedAt: new Date().toISOString(),
  status: 'warn',
  checks: [createNetworkCheck()],
})

const createBackoffHealth = (retryAt) => ({
  checkedAt: cachedHealth?.checkedAt || new Date().toISOString(),
  status: cachedHealth?.status || 'warn',
  checks: cachedHealth?.checks?.length
    ? cachedHealth.checks
    : [
        warn('System health', {
          summary: 'Waiting to retry',
          detail: `Previous health check failed. Next automatic retry is scheduled at ${new Date(retryAt).toLocaleTimeString()}.`,
        }),
      ],
})

const getHealthCacheKey = (options = {}) => [
  options.scope || 'full',
  options.activeRole || '',
  options.canViewReports === false ? 'no-reports' : 'reports',
].join('|')

const getBackoffMs = () =>
  Math.min(HEALTH_BACKOFF_BASE_MS * (2 ** Math.max(0, failureCount - 1)), HEALTH_BACKOFF_MAX_MS)

const normalizeHealthError = (error) => {
  if (isNetworkRequestError(error)) {
    return new Error('Network connection unavailable. Health checks will retry when the connection is stable.')
  }
  return error
}

const failFromError = (label, summary, error) => {
  const networkError = normalizeHealthError(error)
  return fail(label, {
    summary: isNetworkRequestError(error) ? 'Network unavailable' : summary,
    detail: formatError(networkError),
  })
}

const withTimeout = async (promise, label, timeoutMs = HEALTH_TIMEOUT_MS) => {
  let timeoutId
  const setTimer = typeof window !== 'undefined' && typeof window.setTimeout === 'function'
    ? window.setTimeout.bind(window)
    : setTimeout
  const clearTimer = typeof window !== 'undefined' && typeof window.clearTimeout === 'function'
    ? window.clearTimeout.bind(window)
    : clearTimeout

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimer(
          () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timeoutId) {
      clearTimer(timeoutId)
    }
  }
}

const timedFetch = async (url, options = {}, timeoutMs = HEALTH_TIMEOUT_MS) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = performance.now()

  if (options.signal?.aborted) {
    controller.abort()
  }

  const abortFromParent = () => controller.abort()
  options.signal?.addEventListener?.('abort', abortFromParent, { once: true })

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    return {
      response,
      durationMs: Math.round(performance.now() - startedAt),
    }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener?.('abort', abortFromParent)
  }
}

const getLatencyStatus = (durationMs, warnAtMs) =>
  durationMs >= warnAtMs ? 'warn' : 'ok'

const latencyCheck = (label, durationMs, warnAtMs, details = {}) => {
  const payload = {
    ...details,
    summary: durationMs >= warnAtMs ? 'Slow response' : 'Responsive',
    detail: `${details.detailPrefix || 'Responded'} in ${durationMs} ms.`,
  }
  delete payload.detailPrefix
  return getLatencyStatus(durationMs, warnAtMs) === 'warn'
    ? warn(label, payload)
    : ok(label, payload)
}

const latestRow = async (table, select, orderColumn) => {
  const { data, error } = await supabase
    .from(table)
    .select(select)
    .order(orderColumn, { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error && error.code !== 'PGRST116') throw error
  return data || null
}

const checkSupabase = async () => {
  if (!isSupabaseConfigured()) {
    return fail('HealthFlow Cloud connection', {
      summary: 'Not configured',
      detail: 'The app is missing HealthFlow Cloud environment settings.',
    })
  }

  try {
    const { error } = await supabase
      .from('organizations')
      .select('id')
      .limit(1)

    if (error) throw error

    return ok('HealthFlow Cloud connection', {
      summary: 'Reachable',
      detail: 'The app can reach the HealthFlow Cloud workspace.',
    })
  } catch (error) {
    return failFromError('HealthFlow Cloud connection', 'Cloud check failed', error)
  }
}

const checkSupabaseAuthEndpoint = async (options = {}) => {
  const supabaseUrl = getSupabaseUrl()
  const supabaseKey = getSupabaseKey()
  if (!supabaseUrl || !supabaseKey) {
    return fail('HealthFlow sign-in service', {
      summary: 'Not configured',
      detail: 'The app is missing HealthFlow Cloud sign-in settings.',
    })
  }

  try {
    const { response, durationMs } = await timedFetch(
      `${supabaseUrl}/auth/v1/health`,
      {
        headers: { apikey: supabaseKey },
        signal: options.signal,
      },
      options.timeoutMs || HEALTH_TIMEOUT_MS
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`)
    }

    return latencyCheck('HealthFlow sign-in service', durationMs, AUTH_WARN_MS, {
      detailPrefix: 'Sign-in service responded',
    })
  } catch (error) {
    return failFromError('HealthFlow sign-in service', 'Sign-in check failed', error)
  }
}

const checkSupabaseRestLatency = async () => {
  if (!isSupabaseConfigured()) {
    return fail('HealthFlow Cloud API', {
      summary: 'Not configured',
      detail: 'The app is missing HealthFlow Cloud environment settings.',
    })
  }

  try {
    const startedAt = performance.now()
    const { error } = await supabase
      .from('organizations')
      .select('id')
      .limit(1)

    if (error) throw error

    const durationMs = Math.round(performance.now() - startedAt)
    return latencyCheck('HealthFlow Cloud API', durationMs, REST_WARN_MS, {
      detailPrefix: 'Cloud API responded',
    })
  } catch (error) {
    return failFromError('HealthFlow Cloud API', 'Cloud API check failed', error)
  }
}

const checkAuthenticatedSession = async () => {
  if (!isSupabaseConfigured()) {
    return fail('Authenticated session', { summary: 'HealthFlow Cloud sign-in is not configured' })
  }

  try {
    const startedAt = performance.now()
    const user = await getCurrentSupabaseUser()
    if (!user?.id) throw new Error('No authenticated user was returned.')

    return ok('Authenticated session', {
      summary: user.email || 'Signed in',
      detail: `Auth verified in ${Math.round(performance.now() - startedAt)} ms.`,
    })
  } catch (error) {
    return failFromError('Authenticated session', 'Login session check failed', error)
  }
}

const checkReportEngine = async (options = {}) => {
  const activeRole = String(options.activeRole || getStoredActiveRole() || '').trim().toLowerCase()
  const roleCannotViewReports = activeRole ? !hasRole(activeRole, REPORT_ROLES) : false

  if (options.canViewReports === false || roleCannotViewReports) {
    return warn('Reports and Edge Function', {
      summary: 'Skipped',
      detail: 'The active role does not have report access.',
    })
  }

  try {
    const startedAt = performance.now()
    const result = await withTimeout(
      invokeTierAccess({ action: 'get_report_health' }),
      'Report health check',
      options.timeoutMs || HEALTH_TIMEOUT_MS
    )
    const durationMs = Math.round(performance.now() - startedAt)

    return ok('Reports and Edge Function', {
      summary: 'Report engine reachable',
      detail: `Responded in ${durationMs} ms. ${Number(result?.counts?.nhisClaims || 0)} NHIS claims visible.`,
    })
  } catch (error) {
    return failFromError('Reports and Edge Function', 'Report engine check failed', error)
  }
}

const checkRecentSale = async () => {
  if (!isSupabaseConfigured()) return warn('Recent sale', { summary: 'Skipped' })

  try {
    const sale = await latestRow(
      'sales',
      'id, sale_number, sale_date, net_amount, payment_status',
      'sale_date'
    )

    if (!sale) {
      return warn('Recent sale', {
        summary: 'No completed sale found',
        detail: 'No sale row was returned for the current account.',
      })
    }

    return ok('Recent sale', {
      summary: sale.sale_number || 'Sale found',
      detail: `${sale.payment_status || 'status unknown'} · GHS ${Number(sale.net_amount || 0).toFixed(2)}`,
      timestamp: sale.sale_date,
    })
  } catch (error) {
    return failFromError('Recent sale', 'Could not read sales', error)
  }
}

const checkRecentAuditLog = async () => {
  if (!isSupabaseConfigured()) return warn('Recent activity log', { summary: 'Skipped' })

  try {
    let log = null

    try {
      const result = await withTimeout(
        invokeTierAccess({ action: 'get_activity_logs', limit: 1 }),
        'Activity log check',
        HEALTH_TIMEOUT_MS
      )
      log = Array.isArray(result?.logs) ? result.logs[0] || null : null
    } catch (error) {
      const unsupportedAction = String(error?.message || '').toLowerCase().includes('unsupported action')
      if (!unsupportedAction) throw error

      log = await latestRow(
        'audit_logs',
        'id, event_type, entity_type, action, created_at',
        'created_at'
      )
    }

    if (!log) {
      return warn('Recent activity log', {
        summary: 'No activity found',
        detail: 'No audit log row was returned for the current account.',
      })
    }

    return ok('Recent activity log', {
      summary: log.event_type || log.action || 'Activity found',
      detail: log.entity_type || 'Audit log is recording events.',
      timestamp: log.created_at,
    })
  } catch (error) {
    return failFromError('Recent activity log', 'Could not read audit logs', error)
  }
}

const checkRecentNhisClaim = async () => {
  if (!isSupabaseConfigured()) return warn('NHIS access', { summary: 'Skipped' })

  try {
    const claim = await latestRow(
      'nhis_claims',
      'id, claim_number, status, created_at',
      'created_at'
    )

    if (!claim) {
      return warn('NHIS access', {
        summary: 'No NHIS claim found',
        detail: 'The NHIS table is reachable but no claim is visible for this account.',
      })
    }

    return ok('NHIS access', {
      summary: claim.claim_number || 'Claim found',
      detail: claim.status || 'NHIS claim reads are working.',
      timestamp: claim.created_at,
    })
  } catch (error) {
    return failFromError('NHIS access', 'Could not read NHIS claims', error)
  }
}

const checkLocalBranchServer = async () => {
  const config = getBranchServerConfig()
  if (!config.enabled || !config.token) {
    return warn('Local branch server', {
      summary: 'Not configured in this browser',
      detail: 'Cloud mode can still operate normally.',
    })
  }

  try {
    const health = await getBranchServerHealth()
    return health?.ok
      ? ok('Local branch server', {
          summary: 'Reachable',
          detail: health.version ? `Version ${health.version}` : 'Local server responded.',
        })
      : warn('Local branch server', {
          summary: 'Unexpected response',
          detail: 'The local server responded but did not report OK.',
        })
  } catch (error) {
    return warn('Local branch server', {
      summary: 'Not reachable from this browser',
      detail: formatError(error),
    })
  }
}

const buildSystemHealth = async (options = {}) => {
  const scope = options.scope || 'full'
  const isSummaryScope = scope === 'summary'
  const baseChecks = [
    createNetworkCheck(),
    checkSupabaseAuthEndpoint(options),
    checkAuthenticatedSession(),
    checkLocalBranchServer(),
  ]

  const fullChecks = isSummaryScope
    ? []
    : [
        checkSupabase(),
        checkSupabaseRestLatency(),
        checkReportEngine(options),
        checkRecentSale(),
        checkRecentNhisClaim(),
        checkRecentAuditLog(),
      ]

  const checks = await Promise.all([...baseChecks, ...fullChecks])

  const hasFailure = checks.some((check) => check.status === 'fail')
  const hasWarning = checks.some((check) => check.status === 'warn')

  return {
    checkedAt: new Date().toISOString(),
    status: hasFailure ? 'fail' : hasWarning ? 'warn' : 'ok',
    checks,
  }
}

export const getSystemHealth = async (options = {}) => {
  const now = Date.now()
  const cacheKey = getHealthCacheKey(options)

  if (isBrowserOffline()) {
    recordCacheEvent('system-health', 'miss')
    return createOfflineHealth()
  }

  if (!options.force && cachedHealth && cachedHealthKey === cacheKey && now - cachedHealthAt < HEALTH_CACHE_MS) {
    recordCacheEvent('system-health', 'hit')
    return cachedHealth
  }

  if (!options.force && now < nextAllowedCheckAt) {
    recordCacheEvent('system-health backoff', 'hit')
    return createBackoffHealth(nextAllowedCheckAt)
  }

  if (healthInFlight) {
    recordCacheEvent('system-health in-flight', 'hit')
    return healthInFlight
  }

  recordCacheEvent('system-health', 'miss')
  healthInFlightKey = cacheKey
  healthInFlight = buildSystemHealth(options)
    .then((health) => {
      cachedHealth = health
      cachedHealthKey = healthInFlightKey
      cachedHealthAt = Date.now()
      const hasFailure = health.checks?.some((check) => check.status === 'fail')
      if (hasFailure) {
        failureCount += 1
        nextAllowedCheckAt = Date.now() + getBackoffMs()
        recordRetry('system-health')
      } else {
        failureCount = 0
        nextAllowedCheckAt = 0
      }
      return health
    })
    .catch((error) => {
      failureCount += 1
      nextAllowedCheckAt = Date.now() + getBackoffMs()
      recordRetry('system-health')
      throw normalizeHealthError(error)
    })
    .finally(() => {
      healthInFlight = null
      healthInFlightKey = ''
    })

  return healthInFlight
}

export const resetSystemHealthCache = () => {
  stopSystemHealthPolling()
  pollSubscribers.clear()
  cachedHealth = null
  cachedHealthKey = ''
  cachedHealthAt = 0
  healthInFlight = null
  healthInFlightKey = ''
  failureCount = 0
  nextAllowedCheckAt = 0
}

const emitPolledHealth = (health) => {
  pollSubscribers.forEach((subscriber) => {
    try {
      subscriber(health)
    } catch (error) {
      console.warn('System health subscriber failed:', error)
    }
  })
}

const stopSystemHealthPolling = () => {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }

  if (pollAbortController) {
    pollAbortController.abort()
    pollAbortController = null
  }

  pollRunning = false
  pollOptions = null
  setPollingStatus({
    active: false,
    subscriberCount: pollSubscribers.size,
  })
}

const runSystemHealthPoll = async () => {
  if (pollRunning || !pollOptions) return

  if (isBrowserOffline()) {
    emitPolledHealth(createOfflineHealth())
    setPollingStatus({
      active: Boolean(pollTimer),
      subscriberCount: pollSubscribers.size,
      lastStatus: 'offline',
    })
    return
  }

  pollRunning = true
  pollAbortController = new AbortController()
  const startedAt = performance.now()
  setPollingStatus({
    active: true,
    intervalMs: HEALTH_CACHE_MS,
    subscriberCount: pollSubscribers.size,
    lastStartedAt: new Date().toISOString(),
    lastStatus: 'running',
  })

  try {
    const health = await getSystemHealth({
      ...pollOptions,
      scope: 'summary',
      signal: pollAbortController.signal,
    })
    emitPolledHealth(health)
    recordPollingRun({
      label: 'system-health',
      durationMs: performance.now() - startedAt,
      status: health.status || 'ok',
    })
  } catch (error) {
    console.warn('Unable to load polled system health:', normalizeHealthError(error))
    emitPolledHealth(cachedHealth || {
      checkedAt: new Date().toISOString(),
      status: 'warn',
      checks: [
        warn('System health', {
          summary: 'Check failed',
          detail: formatError(normalizeHealthError(error)),
        }),
      ],
    })
    recordPollingRun({
      label: 'system-health',
      durationMs: performance.now() - startedAt,
      status: 'failed',
    })
  } finally {
    pollRunning = false
    pollAbortController = null
    setPollingStatus({
      active: Boolean(pollTimer),
      intervalMs: HEALTH_CACHE_MS,
      subscriberCount: pollSubscribers.size,
    })
  }
}

export const subscribeSystemHealthPolling = (subscriber, options = {}) => {
  if (typeof window === 'undefined') {
    return () => {}
  }

  pollSubscribers.add(subscriber)
  pollOptions = {
    canViewReports: options.canViewReports,
    activeRole: options.activeRole,
  }
  setPollingStatus({
    active: Boolean(pollTimer),
    intervalMs: HEALTH_CACHE_MS,
    subscriberCount: pollSubscribers.size,
  })

  if (cachedHealth) {
    subscriber(cachedHealth)
  }

  if (!pollTimer) {
    void runSystemHealthPoll()
    pollTimer = window.setInterval(() => {
      void runSystemHealthPoll()
    }, HEALTH_CACHE_MS)
    setPollingStatus({
      active: true,
      intervalMs: HEALTH_CACHE_MS,
      subscriberCount: pollSubscribers.size,
    })
  }

  return () => {
    pollSubscribers.delete(subscriber)
    setPollingStatus({
      active: Boolean(pollTimer),
      intervalMs: HEALTH_CACHE_MS,
      subscriberCount: pollSubscribers.size,
    })
    if (pollSubscribers.size === 0) {
      stopSystemHealthPolling()
    }
  }
}
