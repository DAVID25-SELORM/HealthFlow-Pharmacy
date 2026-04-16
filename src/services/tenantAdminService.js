import { supabase } from '../lib/supabase'

/**
 * Tenant Admin Service
 * Super-admin only: manage all pharmacies across the platform
 */

/**
 * Get all organizations with their user counts
 */
export const getAllOrganizations = async () => {
  const { data, error } = await supabase
    .from('organizations')
    .select(`
      id,
      name,
      subdomain,
      status,
      subscription_tier,
      trial_ends_at,
      subscription_ends_at,
      phone,
      email,
      address,
      city,
      region,
      license_number,
      created_at
    `)
    .order('created_at', { ascending: false })

  if (error) throw error
  return data || []
}

/**
 * Get user count per organization
 */
export const getOrganizationUserCounts = async (orgIds) => {
  if (!orgIds.length) return {}

  const { data, error } = await supabase
    .from('users')
    .select('organization_id')
    .in('organization_id', orgIds)

  if (error) throw error

  return (data || []).reduce((acc, row) => {
    acc[row.organization_id] = (acc[row.organization_id] || 0) + 1
    return acc
  }, {})
}

/**
 * Create a new pharmacy organization + admin account
 */
export const createPharmacyTenant = async ({ pharmacy, admin }) => {
  // 1. Create the organization
  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .insert([{
      name: pharmacy.name.trim(),
      subdomain: pharmacy.subdomain.trim().toLowerCase(),
      status: 'trial',
      subscription_tier: pharmacy.subscriptionTier || 'basic',
      phone: pharmacy.phone?.trim() || null,
      email: pharmacy.email?.trim() || null,
      address: pharmacy.address?.trim() || null,
      city: pharmacy.city?.trim() || null,
      region: pharmacy.region?.trim() || null,
      license_number: pharmacy.licenseNumber?.trim() || null,
      trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }])
    .select()
    .single()

  if (orgError) throw orgError

  // 2. Create the admin auth user via Supabase Admin API (via Edge Function)
  // Falls back to instructing user to create manually if edge function not available
  const { data: fn, error: fnError } = await supabase.functions.invoke('staff-admin', {
    body: {
      action: 'create',
      email: admin.email.trim(),
      full_name: admin.fullName.trim(),
      phone: admin.phone?.trim() || null,
      role: 'admin',
      organization_id: org.id,
      temporary_password: admin.temporaryPassword,
    },
  })

  if (fnError || fn?.error) {
    // Rollback org creation on auth failure
    await supabase.from('organizations').delete().eq('id', org.id)
    throw new Error(fn?.error || fnError?.message || 'Failed to create admin account')
  }

  // 3. Create default pharmacy settings
  await supabase.from('pharmacy_settings').insert([{
    organization_id: org.id,
    pharmacy_name: pharmacy.name.trim(),
    phone: pharmacy.phone?.trim() || null,
    email: pharmacy.email?.trim() || null,
    address: pharmacy.address?.trim() || null,
    city: pharmacy.city?.trim() || null,
    region: pharmacy.region?.trim() || null,
    license_number: pharmacy.licenseNumber?.trim() || null,
    currency: 'GHS',
    low_stock_threshold: 10,
    expiry_alert_days: 30,
    tax_rate: 0,
  }])

  return { organization: org, admin: fn }
}

/**
 * Update organization status (activate / suspend / set trial)
 */
export const updateOrganizationStatus = async (orgId, status) => {
  const { data, error } = await supabase
    .from('organizations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', orgId)
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Update subscription tier
 */
export const updateSubscriptionTier = async (orgId, tier) => {
  const { data, error } = await supabase
    .from('organizations')
    .update({ subscription_tier: tier, updated_at: new Date().toISOString() })
    .eq('id', orgId)
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Get all users for a specific organization
 */
export const getOrganizationUsers = async (orgId) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, role, is_active, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return data || []
}

/**
 * Check subdomain availability
 */
export const checkSubdomainAvailable = async (subdomain) => {
  const { data, error } = await supabase
    .from('organizations')
    .select('id')
    .eq('subdomain', subdomain.toLowerCase().trim())
    .maybeSingle()

  if (error) throw error
  return !data
}
