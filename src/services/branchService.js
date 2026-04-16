import { supabase } from '../lib/supabase'

/**
 * Get all branches for the current user's organization.
 * Main branch is always first, others sorted by name.
 */
export const getBranches = async () => {
  const { data, error } = await supabase
    .from('branches')
    .select('*')
    .order('is_main', { ascending: false })
    .order('name')

  if (error) throw error
  return data || []
}

/**
 * Get branch counts per organization (super_admin / TenantAdmin use).
 */
export const getBranchCountsByOrgIds = async (orgIds) => {
  if (!orgIds.length) return {}

  const { data, error } = await supabase
    .from('branches')
    .select('organization_id')
    .in('organization_id', orgIds)

  if (error) throw error

  return (data || []).reduce((acc, row) => {
    acc[row.organization_id] = (acc[row.organization_id] || 0) + 1
    return acc
  }, {})
}

/**
 * Create a new (non-main) branch in the current user's organization.
 */
export const createBranch = async (fields) => {
  const { data, error } = await supabase
    .from('branches')
    .insert([{
      name: fields.name.trim(),
      code: fields.code?.trim() || null,
      phone: fields.phone?.trim() || null,
      email: fields.email?.trim() || null,
      address: fields.address?.trim() || null,
      city: fields.city?.trim() || null,
      region: fields.region?.trim() || null,
      is_main: false,
    }])
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Update an existing branch's details.
 */
export const updateBranch = async (id, fields) => {
  const payload = {
    name: fields.name?.trim() || undefined,
    code: fields.code?.trim() || null,
    phone: fields.phone?.trim() || null,
    email: fields.email?.trim() || null,
    address: fields.address?.trim() || null,
    city: fields.city?.trim() || null,
    region: fields.region?.trim() || null,
    updated_at: new Date().toISOString(),
  }

  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k])

  const { data, error } = await supabase
    .from('branches')
    .update(payload)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Deactivate a branch (soft delete). Main branch cannot be deactivated.
 */
export const deactivateBranch = async (id) => {
  const { error } = await supabase
    .from('branches')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw error
}
