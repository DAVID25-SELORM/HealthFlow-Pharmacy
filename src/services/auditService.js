import { getCurrentSupabaseUser, supabase } from '../lib/supabase'
import { getStoredActiveRole } from '../utils/activeRole'

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

  const row = {
    actor_user_id: user?.id || null,
    actor_email: user?.email || null,
    event_type: eventType,
    entity_type: entityType,
    entity_id: entityId || null,
    action,
    details: details || {},
  }

  const scopedRow = organizationId ? { ...row, organization_id: organizationId } : row
  let { error } = await supabase.from('audit_logs').insert(scopedRow)

  if (error && organizationId && isMissingAuditOrganizationColumnError(error)) {
    const retryResult = await supabase.from('audit_logs').insert(row)
    error = retryResult.error
  }

  if (error) {
    throw error
  }
}

export const logAuditEvent = async ({ eventType, entityType, entityId, action, details = {} }) => {
  const enrichedDetails = withActiveRole(details)
  const currentUser = await getCurrentSupabaseUser()
  const organizationId = await getCurrentUserOrganizationId(currentUser?.id)
  const { error } = await supabase.rpc('log_audit_event', {
    p_event_type: eventType,
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_action: action,
    p_details: enrichedDetails,
    p_organization_id: organizationId,
  })

  if (error) {
    if (isMissingRpcFunctionError(error)) {
      await insertAuditEventDirectly({ eventType, entityType, entityId, action, details: enrichedDetails, organizationId })
      return
    }

    throw error
  }
}

export const tryLogAuditEvent = async (payload) => {
  try {
    await logAuditEvent(payload)
  } catch (error) {
    console.warn('Audit log failed:', error.message)
  }
}
