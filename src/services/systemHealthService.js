import { isSupabaseConfigured, supabase } from '../lib/supabase'
import { getBranchServerConfig, getBranchServerHealth } from './branchServerApi'
import { invokeTierAccess } from './tierAccessService'

const ok = (label, details = {}) => ({ label, status: 'ok', ...details })
const warn = (label, details = {}) => ({ label, status: 'warn', ...details })
const fail = (label, details = {}) => ({ label, status: 'fail', ...details })

const formatError = (error) =>
  error?.message || error?.error_description || 'Check failed.'

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

const checkTierAccess = async () => {
  try {
    const startedAt = performance.now()
    await invokeTierAccess({ action: 'get_activity_logs', limit: 1 })
    const durationMs = Math.round(performance.now() - startedAt)

    return ok('Edge Function', {
      summary: 'tier-access reachable',
      detail: `Responded in ${durationMs} ms.`,
    })
  } catch (error) {
    return fail('Edge Function', {
      summary: 'tier-access check failed',
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
    const log = await latestRow(
      'audit_logs',
      'id, event_type, entity_type, action, created_at',
      'created_at'
    )

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

export const getSystemHealth = async () => {
  const checks = await Promise.all([
    checkSupabase(),
    checkTierAccess(),
    checkRecentSale(),
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
