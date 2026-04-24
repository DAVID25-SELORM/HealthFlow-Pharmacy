import { supabase } from '../lib/supabase'

const isMissingRpcFunctionError = (error) => {
  const code = String(error?.code || '').toUpperCase()
  const message = String(error?.message || '').toLowerCase()

  return code === 'PGRST202' || message.includes('could not find the function')
}

const insertAuditEventDirectly = async ({
  eventType,
  entityType,
  entityId,
  action,
  details = {},
}) => {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { error } = await supabase.from('audit_logs').insert({
    actor_user_id: user?.id || null,
    actor_email: user?.email || null,
    event_type: eventType,
    entity_type: entityType,
    entity_id: entityId || null,
    action,
    details: details || {},
  })

  if (error) {
    throw error
  }
}

export const logAuditEvent = async ({ eventType, entityType, entityId, action, details = {} }) => {
  const { error } = await supabase.rpc('log_audit_event', {
    p_event_type: eventType,
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_action: action,
    p_details: details,
  })

  if (error) {
    if (isMissingRpcFunctionError(error)) {
      await insertAuditEventDirectly({ eventType, entityType, entityId, action, details })
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
