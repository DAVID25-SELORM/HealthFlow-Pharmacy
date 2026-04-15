import { supabase } from '../lib/supabase'

export const logAuditEvent = async ({ eventType, entityType, entityId, action, details = {} }) => {
  const { error } = await supabase.rpc('log_audit_event', {
    p_event_type: eventType,
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_action: action,
    p_details: details,
  })

  if (error) {
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
