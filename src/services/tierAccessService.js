import { invokeSupabaseFunction } from '../lib/supabase'

const TIER_ACCESS_FUNCTION = 'tier-access'
const REDACTED_VALUE = '[REDACTED]'

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

export const invokeTierAccess = async (payload) => {
  console.log('[TIER ACCESS REQUEST]', {
    action: payload?.action,
    organizationId: payload?.organizationId || payload?.organization_id,
    payload: redactPayload(payload),
  })

  const { data, error } = await invokeSupabaseFunction(TIER_ACCESS_FUNCTION, {
    body: payload,
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }

  return data
}
