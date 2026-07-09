import { getCurrentSupabaseUser, isSupabaseConfigured, supabase } from '../lib/supabase'
import { getStoredActiveRole } from '../utils/activeRole'
import { REPORT_ROLES, hasRole } from '../utils/roles'
import { getBranchServerConfig, getBranchServerHealth } from './branchServerApi'
import { invokeTierAccess } from './tierAccessService'

const ok = (label, details = {}) => ({ label, status: 'ok', ...details })
const warn = (label, details = {}) => ({ label, status: 'warn', ...details })
const fail = (label, details = {}) => ({ label, status: 'fail', ...details })

const HEALTH_TIMEOUT_MS = 8000
const AUTH_WARN_MS = 2500
const REST_WARN_MS = 3000

const getSupabaseUrl = () => (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
const getSupabaseKey = () =>
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  ''

const formatError = (error) =>
  error?.message || error?.error_description || 'Check failed.'

const timedFetch = async (url, options = {}, timeoutMs = HEALTH_TIMEOUT_MS) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = performance.now()

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
    return fail('Supabase connection', {
      summary: 'Not configured',
      detail: 'The app is missing Supabase environment settings.',
    })
  }

  try {
    const { error } = await supabase
      .from('organizations')
      .select('id')
      .limit(1)

    if (error) throw error

    return ok('Supabase connection', {
      summary: 'Reachable',
      detail: 'The app can reach the production database.',
    })
  } catch (error) {
    return fail('Supabase connection', {
      summary: 'Database check failed',
      detail: formatError(error),
    })
  }
}

const checkSupabaseAuthEndpoint = async () => {
  const supabaseUrl = getSupabaseUrl()
  const supabaseKey = getSupabaseKey()
  if (!supabaseUrl || !supabaseKey) {
    return fail('Supabase Auth endpoint', {
      summary: 'Not configured',
      detail: 'The app is missing Supabase URL or publishable key.',
    })
  }

  try {
    const { response, durationMs } = await timedFetch(`${supabaseUrl}/auth/v1/health`, {
      headers: { apikey: supabaseKey },
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`)
    }

    return latencyCheck('Supabase Auth endpoint', durationMs, AUTH_WARN_MS, {
      detailPrefix: 'Auth health responded',
    })
  } catch (error) {
    return fail('Supabase Auth endpoint', {
      summary: 'Auth health check failed',
      detail: formatError(error),
    })
  }
}

const checkSupabaseRestLatency = async () => {
  if (!isSupabaseConfigured()) {
    return fail('Supabase REST latency', {
      summary: 'Not configured',
      detail: 'The app is missing Supabase environment settings.',
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
    return latencyCheck('Supabase REST latency', durationMs, REST_WARN_MS, {
      detailPrefix: 'Database API responded',
    })
  } catch (error) {
    return fail('Supabase REST latency', {
      summary: 'REST check failed',
      detail: formatError(error),
    })
  }
}

const checkAuthenticatedSession = async () => {
  if (!isSupabaseConfigured()) {
    return fail('Authenticated session', { summary: 'Supabase is not configured' })
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
    return fail('Authenticated session', {
      summary: 'Login session check failed',
      detail: formatError(error),
    })
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
    const result = await invokeTierAccess({ action: 'get_report_health' })
    const durationMs = Math.round(performance.now() - startedAt)

    return ok('Reports and Edge Function', {
      summary: 'Report engine reachable',
      detail: `Responded in ${durationMs} ms. ${Number(result?.counts?.nhisClaims || 0)} NHIS claims visible.`,
    })
  } catch (error) {
    return fail('Reports and Edge Function', {
      summary: 'Report engine check failed',
      detail: formatError(error),
    })
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
    return fail('Recent sale', {
      summary: 'Could not read sales',
      detail: formatError(error),
    })
  }
}

const checkRecentAuditLog = async () => {
  if (!isSupabaseConfigured()) return warn('Recent activity log', { summary: 'Skipped' })

  try {
    let log = null

    try {
      const result = await invokeTierAccess({ action: 'get_activity_logs', limit: 1 })
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
    return fail('Recent activity log', {
      summary: 'Could not read audit logs',
      detail: formatError(error),
    })
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
    return fail('NHIS access', {
      summary: 'Could not read NHIS claims',
      detail: formatError(error),
    })
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

export const getSystemHealth = async (options = {}) => {
  const checks = await Promise.all([
    checkSupabase(),
    checkSupabaseAuthEndpoint(),
    checkSupabaseRestLatency(),
    checkAuthenticatedSession(),
    checkReportEngine(options),
    checkRecentSale(),
    checkRecentNhisClaim(),
    checkRecentAuditLog(),
    checkLocalBranchServer(),
  ])

  const hasFailure = checks.some((check) => check.status === 'fail')
  const hasWarning = checks.some((check) => check.status === 'warn')

  return {
    checkedAt: new Date().toISOString(),
    status: hasFailure ? 'fail' : hasWarning ? 'warn' : 'ok',
    checks,
  }
}
