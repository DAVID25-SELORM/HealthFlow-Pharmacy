import { supabase } from '../lib/supabase'

const requireOrganizationId = (organizationId) => {
  const value = String(organizationId || '').trim()
  if (!value) throw new Error('Select a Chemical Shop organization first.')
  return value
}

export const getRestrictedInventory = async (organizationId) => {
  const { data, error } = await supabase.rpc('get_restricted_inventory', {
    p_organization_id: requireOrganizationId(organizationId),
  })
  if (error) throw error
  return data || []
}

export const getRestrictedInventoryAudit = async (organizationId, itemId = null) => {
  const { data, error } = await supabase.rpc('get_restricted_inventory_audit', {
    p_organization_id: requireOrganizationId(organizationId),
    p_restricted_inventory_id: itemId || null,
  })
  if (error) throw error
  return data || []
}

export const updateRestrictedInventoryStatus = async (itemId, status, reason) => {
  const normalizedReason = String(reason || '').trim()
  if (!normalizedReason) throw new Error('Enter a reason for this compliance action.')
  const { error } = await supabase.rpc('update_restricted_inventory_status', {
    p_restricted_inventory_id: itemId,
    p_status: status,
    p_reason: normalizedReason,
  })
  if (error) throw error
}
