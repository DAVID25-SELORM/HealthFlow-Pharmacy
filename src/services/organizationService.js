import { invokeSupabaseFunction, supabase } from '../lib/supabase'
import { assertRequiredText, normalizeText } from '../utils/validation'

/**
 * Organization Service
 * Handles multi-tenant organization management
 */

const TENANT_SIGNUP_FUNCTION = 'tenant-signup'

const invokeTenantSignup = async (payload) => {
  const { data, error } = await invokeSupabaseFunction(TENANT_SIGNUP_FUNCTION, {
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

/**
 * Get current user's organization
 */
export const getCurrentOrganization = async () => {
  const { data, error } = await supabase
    .from('users')
    .select(`
      organization_id,
      organizations (*)
    `)
    .eq('id', (await supabase.auth.getUser()).data.user?.id)
    .single()

  if (error) throw error

  return data?.organizations || null
}

/**
 * Get organization by ID
 */
export const getOrganizationById = async (orgId) => {
  const { data, error } = await supabase
    .from('organizations')
    .select('*')
    .eq('id', orgId)
    .single()

  if (error) throw error

  return data
}

/**
 * Get organization by subdomain
 */
export const getOrganizationBySubdomain = async (subdomain) => {
  const { data, error } = await supabase
    .from('organizations')
    .select('*')
    .eq('subdomain', normalizeText(subdomain))
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      // No organization found
      return null
    }
    throw error
  }

  return data
}

export const registerOrganizationSignup = async (payload) => {
  const organization = {
    name: assertRequiredText(payload.pharmacyName, 'Pharmacy name'),
    subdomain: assertRequiredText(payload.subdomain, 'Subdomain').toLowerCase(),
    phone: normalizeText(payload.pharmacyPhone) || null,
    email: normalizeText(payload.pharmacyEmail) || null,
    address: normalizeText(payload.address) || null,
    city: normalizeText(payload.city) || null,
    region: normalizeText(payload.region) || null,
    licenseNumber: normalizeText(payload.licenseNumber) || null,
  }

  const adminUser = {
    fullName: assertRequiredText(payload.fullName, 'Full name'),
    email: assertRequiredText(payload.email, 'Email').toLowerCase(),
    phone: normalizeText(payload.phone) || null,
    password: assertRequiredText(payload.password, 'Password'),
  }

  return invokeTenantSignup({
    action: 'register_signup',
    organization,
    adminUser,
  })
}

/**
 * Create a new organization (pharmacy signup)
 */
export const createOrganization = async (orgData) => {
  const name = assertRequiredText(orgData.name, 'Organization name')
  const subdomain = assertRequiredText(orgData.subdomain, 'Subdomain').toLowerCase()
  
  // Validate subdomain format (alphanumeric and hyphens only)
  if (!/^[a-z0-9-]+$/.test(subdomain)) {
    throw new Error('Subdomain can only contain lowercase letters, numbers, and hyphens')
  }

  if (subdomain.length < 3 || subdomain.length > 50) {
    throw new Error('Subdomain must be between 3 and 50 characters')
  }

  // Check if subdomain is already taken
  const existing = await getOrganizationBySubdomain(subdomain)
  if (existing) {
    throw new Error('This subdomain is already taken. Please choose another.')
  }

  const payload = {
    name: normalizeText(name),
    subdomain: subdomain,
    address: normalizeText(orgData.address) || null,
    city: normalizeText(orgData.city) || null,
    region: normalizeText(orgData.region) || null,
    phone: normalizeText(orgData.phone) || null,
    email: normalizeText(orgData.email) || null,
    license_number: normalizeText(orgData.licenseNumber) || null,
    status: 'trial', // Start with trial
    subscription_tier: 'trial',
    trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
  }

  const { data, error } = await supabase
    .from('organizations')
    .insert([payload])
    .select()
    .single()

  if (error) throw error

  return data
}

/**
 * Update organization details
 */
export const updateOrganization = async (orgId, updates) => {
  const payload = {
    name: updates.name ? normalizeText(updates.name) : undefined,
    address: updates.address !== undefined ? normalizeText(updates.address) || null : undefined,
    city: updates.city !== undefined ? normalizeText(updates.city) || null : undefined,
    region: updates.region !== undefined ? normalizeText(updates.region) || null : undefined,
    phone: updates.phone !== undefined ? normalizeText(updates.phone) || null : undefined,
    email: updates.email !== undefined ? normalizeText(updates.email) || null : undefined,
    license_number: updates.licenseNumber !== undefined ? normalizeText(updates.licenseNumber) || null : undefined,
    updated_at: new Date().toISOString(),
  }

  // Remove undefined values
  Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key])

  const { data, error } = await supabase
    .from('organizations')
    .update(payload)
    .eq('id', orgId)
    .select()
    .single()

  if (error) throw error

  return data
}

/**
 * Set organization owner
 */
export const setOrganizationOwner = async (orgId, userId) => {
  const { data, error } = await supabase
    .from('organizations')
    .update({ owner_user_id: userId })
    .eq('id', orgId)
    .select()
    .single()

  if (error) throw error

  return data
}

/**
 * Get organization users/staff
 */
export const getOrganizationUsers = async (orgId) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, phone, role, is_active, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })

  if (error) throw error

  return data || []
}

/**
 * Get organization statistics
 */
export const getOrganizationStats = async (orgId) => {
  const [usersCount, drugsCount, patientsCount, salesCount] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabase.from('drugs').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabase.from('patients').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabase.from('sales').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
  ])

  return {
    totalUsers: usersCount.count || 0,
    totalDrugs: drugsCount.count || 0,
    totalPatients: patientsCount.count || 0,
    totalSales: salesCount.count || 0,
  }
}

/**
 * Check if subdomain is available
 */
export const checkSubdomainAvailability = async (subdomain) => {
  const normalized = normalizeText(subdomain).toLowerCase()
  
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    return { available: false, message: 'Invalid format. Use only letters, numbers, and hyphens.' }
  }

  if (normalized.length < 3 || normalized.length > 50) {
    return { available: false, message: 'Subdomain must be 3-50 characters long.' }
  }

  return invokeTenantSignup({
    action: 'check_subdomain',
    subdomain: normalized,
  })
}

/**
 * Update organization subscription
 */
export const updateOrganizationSubscription = async (orgId, tier, endsAt = null) => {
  const payload = {
    subscription_tier: tier,
    subscription_ends_at: endsAt,
    status: tier === 'cancelled' ? 'cancelled' : 'active',
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('organizations')
    .update(payload)
    .eq('id', orgId)
    .select()
    .single()

  if (error) throw error

  return data
}

/**
 * Suspend organization
 */
export const suspendOrganization = async (orgId, reason = null) => {
  const { data, error } = await supabase
    .from('organizations')
    .update({
      status: 'suspended',
      settings: { suspension_reason: reason },
      updated_at: new Date().toISOString(),
    })
    .eq('id', orgId)
    .select()
    .single()

  if (error) throw error

  return data
}

/**
 * Reactivate organization
 */
export const reactivateOrganization = async (orgId) => {
  const { data, error } = await supabase
    .from('organizations')
    .update({
      status: 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', orgId)
    .select()
    .single()

  if (error) throw error

  return data
}
