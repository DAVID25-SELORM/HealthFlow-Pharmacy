import { getCurrentSupabaseUser, supabase } from '../lib/supabase'
import { getStoredActiveRole } from '../utils/activeRole'
import { isNetworkRequestError } from '../utils/requestErrors'
import { logRequestFailure } from '../utils/requestDiagnostics'

const MAX_PENDING_AUDIT_EVENTS = 100
const pendingAuditEvents = []
let auditFlushPromise = null

// Additive accountability: stamp every audit event with the role the user was
// actively working as when the action happened. Does not change any caller
// behaviour — it only enriches the free-form audit `details` payload.
const withActiveRole = (details = {}) => {
  const activeRole = getStoredActiveRole()
  if (!activeRole) {
    return details || {}
  }
  return { active_role: activeRole, ...(details || {}) }
}

const isMissingRpcFunctionError = (error) => {
  const code = String(error?.code || '').toUpperCase()
  const message = String(error?.message || '').toLowerCase()

  return code === 'PGRST202' || message.includes('could not find the function')
}

const isMissingAuditOrganizationColumnError = (error) => {
  const code = String(error?.code || '').toUpperCase()
  const message = String(error?.message || error?.details || '').toLowerCase()
  return code === '42703' || code === 'PGRST204' || message.includes('organization_id')
}

export const uuidOrNull = (value) => {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  if (!normalized) {
    return null
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null
}

const AUDIT_UUID_DETAIL_KEYS = new Set([
  'user_id',
  'organization_id',
  'branch_id',
  'claim_id',
  'patient_id',
  'encounter_id',
  'prescription_id',
])

const sanitizeAuditDetails = (details) => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return details || {}
  }

  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      AUDIT_UUID_DETAIL_KEYS.has(key) ? uuidOrNull(value) : value,
    ])
  )
}

const debugAuditPayload = (payload) => {
  if (import.meta.env.DEV) {
    console.log('Audit payload', payload)
  }
}

const getCurrentUserOrganizationId = async (userId) => {
  if (!userId) {
    return null
  }

  const { data, error } = await supabase
    .from('users')
    .select('organization_id')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    return null
  }

  return data?.organization_id || null
}

const insertAuditEventDirectly = async ({
  eventType,
  entityType,
  entityId,
  action,
  details = {},
  organizationId = null,
}) => {
  const user = await getCurrentSupabaseUser()
  const safeEntityId = uuidOrNull(entityId)
  const safeOrganizationId = uuidOrNull(organizationId)
  const safeDetails = sanitizeAuditDetails(details)

  const row = {
    actor_user_id: uuidOrNull(user?.id),
    actor_email: user?.email || null,
    event_type: eventType,
    entity_type: entityType,
    entity_id: safeEntityId,
    action,
    details: safeDetails,
  }

  const scopedRow = safeOrganizationId ? { ...row, organization_id: safeOrganizationId } : row
  let { error } = await supabase.from('audit_logs').insert(scopedRow)

  if (error && safeOrganizationId && isMissingAuditOrganizationColumnError(error)) {
    const retryResult = await supabase.from('audit_logs').insert(row)
    error = retryResult.error
  }

  if (error) {
    throw error
  }
}

export const logAuditEvent = async ({ eventType, entityType, entityId, action, details = {} }) => {
  const safeEntityId = uuidOrNull(entityId)
  const enrichedDetails = sanitizeAuditDetails(withActiveRole(details))
  const currentUser = await getCurrentSupabaseUser()
  const organizationId = uuidOrNull(await getCurrentUserOrganizationId(currentUser?.id))
  const payload = {
    p_event_type: eventType,
    p_entity_type: entityType,
    p_entity_id: safeEntityId,
    p_action: action,
    p_details: enrichedDetails,
    p_organization_id: organizationId,
  }
  debugAuditPayload(payload)

  const { error } = await supabase.rpc('log_audit_event', payload)

  if (error) {
    if (isMissingRpcFunctionError(error)) {
      await insertAuditEventDirectly({
        eventType,
        entityType,
        entityId: safeEntityId,
        action,
        details: enrichedDetails,
        organizationId,
      })
      return
    }

    throw error
  }
}

export const tryLogAuditEvent = async (payload) => {
  try {
    await logAuditEvent(payload)
  } catch (error) {
    logRequestFailure('audit-log', error, {
      endpoint: '/rest/v1/rpc/log_audit_event',
      method: 'POST',
    })
    if (isNetworkRequestError(error)) {
      if (pendingAuditEvents.length >= MAX_PENDING_AUDIT_EVENTS) pendingAuditEvents.shift()
      pendingAuditEvents.push(payload)
    }
  }
}

export const flushPendingAuditEvents = async () => {
  if (auditFlushPromise || pendingAuditEvents.length === 0) return auditFlushPromise
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return undefined

  auditFlushPromise = (async () => {
    while (pendingAuditEvents.length > 0) {
      const payload = pendingAuditEvents[0]
      try {
        await logAuditEvent(payload)
        pendingAuditEvents.shift()
      } catch (error) {
        logRequestFailure('audit-log-retry', error, {
          endpoint: '/rest/v1/rpc/log_audit_event',
          method: 'POST',
        })
        if (isNetworkRequestError(error)) {
          break
        }
        pendingAuditEvents.shift()
      }
    }
  })().finally(() => {
    auditFlushPromise = null
  })

  return auditFlushPromise
}

export const getPendingAuditEventCount = () => pendingAuditEvents.length

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void flushPendingAuditEvents()
  })
}
