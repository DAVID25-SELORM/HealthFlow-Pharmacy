import { invokeSupabaseFunction } from '../lib/supabase'
import { getStoredActiveRole } from '../utils/activeRole'
import { debugLog } from '../utils/debugLog'

const TIER_ACCESS_FUNCTION = 'tier-access'
const REDACTED_VALUE = '[REDACTED]'
const inFlightReadRequests = new Map()

const isReadOnlyAction = (action = '') => {
  const normalized = String(action || '').toLowerCase()
  return (
    normalized.startsWith('get_') ||
    normalized.startsWith('list_') ||
    normalized.startsWith('search_')
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

const stringifyForLog = (value) => {
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return String(value)
  }
}

const getStablePayloadKey = (payload) => {
  try {
    return JSON.stringify(payload, Object.keys(payload || {}).sort())
  } catch {
    return ''
  }
}

const resolveTierAccessResponse = async (requestPromise) => {
  const { data, error } = await requestPromise

  if (error) {
    console.error('[TIER ACCESS ERROR BODY]', stringifyForLog({
      message: error?.message || '',
      status: error?.status || error?.statusCode || '',
      body: error?.body || null,
      details: error?.details || null,
      missingFields: error?.missingFields || [],
    }))
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }

  return data
}

export const invokeTierAccess = async (payload) => {
  const activeRole = getStoredActiveRole()
  const requestPayload = activeRole && !payload?.activeRole
    ? { ...payload, activeRole }
    : payload
  const shouldDedupe = isReadOnlyAction(requestPayload?.action)
  const dedupeKey = shouldDedupe ? getStablePayloadKey(requestPayload) : ''

  if (dedupeKey && inFlightReadRequests.has(dedupeKey)) {
    debugLog('[TIER ACCESS DEDUPED]', {
      action: requestPayload?.action,
      organizationId: requestPayload?.organizationId || requestPayload?.organization_id,
    })
    return inFlightReadRequests.get(dedupeKey)
  }

  debugLog('[TIER ACCESS REQUEST]', {
    action: requestPayload?.action,
    organizationId: requestPayload?.organizationId || requestPayload?.organization_id,
    payload: redactPayload(requestPayload),
  })

  const requestPromise = invokeSupabaseFunction(TIER_ACCESS_FUNCTION, {
    body: requestPayload,
  })

  if (dedupeKey) {
    inFlightReadRequests.set(
      dedupeKey,
      resolveTierAccessResponse(requestPromise).finally(() => {
        inFlightReadRequests.delete(dedupeKey)
      })
    )
  }

  if (dedupeKey) {
    return inFlightReadRequests.get(dedupeKey)
  }

  return resolveTierAccessResponse(requestPromise)
}
