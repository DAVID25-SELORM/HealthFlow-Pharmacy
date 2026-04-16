import { supabase } from '../lib/supabase'

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '')

const getCurrentOrganizationId = async () => {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()

  if (userError) {
    throw userError
  }

  if (!user) {
    throw new Error('You must be signed in to manage branches.')
  }

  const { data, error } = await supabase
    .from('users')
    .select('organization_id')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    throw error
  }

  const organizationId = normalizeText(data?.organization_id)
  if (!organizationId) {
    throw new Error('Current account is missing organization context.')
  }

  return organizationId
}

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
  const organizationId = await getCurrentOrganizationId()

  const { data, error } = await supabase
    .from('branches')
    .insert([
      {
        organization_id: organizationId,
        name: normalizeText(fields.name),
        code: normalizeText(fields.code) || null,
        phone: normalizeText(fields.phone) || null,
        email: normalizeText(fields.email) || null,
        address: normalizeText(fields.address) || null,
        city: normalizeText(fields.city) || null,
        region: normalizeText(fields.region) || null,
        is_main: false,
      },
    ])
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
    name: normalizeText(fields.name) || undefined,
    code: fields.code !== undefined ? normalizeText(fields.code) || null : undefined,
    phone: fields.phone !== undefined ? normalizeText(fields.phone) || null : undefined,
    email: fields.email !== undefined ? normalizeText(fields.email) || null : undefined,
    address: fields.address !== undefined ? normalizeText(fields.address) || null : undefined,
    city: fields.city !== undefined ? normalizeText(fields.city) || null : undefined,
    region: fields.region !== undefined ? normalizeText(fields.region) || null : undefined,
    updated_at: new Date().toISOString(),
  }

  Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key])

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
