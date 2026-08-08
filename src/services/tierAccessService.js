import { invokeSupabaseFunction } from '../lib/supabase'
import { getStoredActiveRole } from '../utils/activeRole'
import { debugLog } from '../utils/debugLog'
import { isNetworkRequestError } from '../utils/requestErrors'
import {
  recordCacheEvent,
  recordTierAccessEnd,
  recordTierAccessStart,
} from './productionMetricsService'

const TIER_ACCESS_FUNCTION = 'tier-access'
const REDACTED_VALUE = '[REDACTED]'
const inFlightReadRequests = new Map()
const TRANSIENT_RETRY_DELAYS_MS = [500, 1500]

const isReadOnlyAction = (action = '') => {
  const normalized = String(action || '').toLowerCase()
  return (
    normalized.startsWith('get_') ||
    normalized.startsWith('list_') ||
    normalized.startsWith('search_') ||
    normalized.startsWith('check_')
  )
}

const shouldRedactField = (key = '') => {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
  return (
    normalized === 'credentials' ||
    normalized.includes('apikey') ||
    normalized.includes('apisecret') ||
    normalized.includes('password') ||
    normalized.includes('token') ||
    normalized.includes('authorization') ||
    normalized.includes('encrypted') ||
    normalized.includes('secret')
  )
}

const redactPayload = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => redactPayload(item))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      shouldRedactField(key) ? REDACTED_VALUE : redactPayload(entry),
    ])
  )
}

const getStablePayloadKey = (payload) => {
  try {
    return JSON.stringify(payload, Object.keys(payload || {}).sort())
  } catch {
    return ''
  }
}

const isTransientReadFailure = (error) => {
  const status = Number(error?.status || error?.statusCode || error?.context?.status || 0)
  return isNetworkRequestError(error) || [502, 503, 504].includes(status)
}

const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))

const executeTierAccessRequest = async (requestPayload) => {
  const readOnly = isReadOnlyAction(requestPayload?.action)
  let attempt = 0

  while (true) {
    const { data, error } = await invokeSupabaseFunction(TIER_ACCESS_FUNCTION, {
      body: requestPayload,
    })

    if (!error) return { data, error: null }
    if (!readOnly || !isTransientReadFailure(error) || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) {
      return { data, error }
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { data, error }
    }

    await wait(TRANSIENT_RETRY_DELAYS_MS[attempt])
    attempt += 1
  }
}

const resolveTierAccessResponse = async (requestPromise) => {
  const { data, error } = await requestPromise

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }

  return data
}

const resolveMeasuredTierAccessResponse = async (action, requestPromise, startedAt) => {
  try {
    const response = await resolveTierAccessResponse(requestPromise)
    recordTierAccessEnd({
      action,
      durationMs: performance.now() - startedAt,
      success: true,
    })
    return response
  } catch (error) {
    recordTierAccessEnd({
      action,
      durationMs: performance.now() - startedAt,
      success: false,
      error,
    })
    throw error
  }
}

export const invokeTierAccess = async (payload) => {
  const activeRole = getStoredActiveRole()
  const requestPayload = activeRole && !payload?.activeRole
    ? { ...payload, activeRole }
    : payload
  const shouldDedupe = isReadOnlyAction(requestPayload?.action)
  const dedupeKey = shouldDedupe ? getStablePayloadKey(requestPayload) : ''

  if (dedupeKey && inFlightReadRequests.has(dedupeKey)) {
    recordCacheEvent('tier-access in-flight', 'hit')
    debugLog('[TIER ACCESS DEDUPED]', {
      action: requestPayload?.action,
      organizationId: requestPayload?.organizationId || requestPayload?.organization_id,
    })
    return inFlightReadRequests.get(dedupeKey)
  }

  if (dedupeKey) {
    recordCacheEvent('tier-access in-flight', 'miss')
  }

  debugLog('[TIER ACCESS REQUEST]', {
    action: requestPayload?.action,
    organizationId: requestPayload?.organizationId || requestPayload?.organization_id,
    payload: redactPayload(requestPayload),
  })

  const action = requestPayload?.action || 'unknown'
  const startedAt = performance.now()
  recordTierAccessStart(action)
  const requestPromise = executeTierAccessRequest(requestPayload)

  if (dedupeKey) {
    inFlightReadRequests.set(
      dedupeKey,
      resolveMeasuredTierAccessResponse(action, requestPromise, startedAt).finally(() => {
        inFlightReadRequests.delete(dedupeKey)
      })
    )
  }

  if (dedupeKey) {
    return inFlightReadRequests.get(dedupeKey)
  }

  return resolveMeasuredTierAccessResponse(action, requestPromise, startedAt)
}
