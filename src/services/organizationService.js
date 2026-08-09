import { getCurrentSupabaseUser, invokeSupabaseFunctionPublic, supabase } from '../lib/supabase'
import { assertRequiredText, normalizeText } from '../utils/validation'
import { normalizeGhanaRegion } from '../utils/ghanaRegions'
// ✅ NHIS PHARMACY LEVEL PATCH START
import { normalizePharmacyLevel } from '../utils/nhisPharmacyLevel'
// ✅ NHIS PHARMACY LEVEL PATCH END

/**
 * Organization Service
 * Handles multi-tenant organization management
 */

const TENANT_SIGNUP_FUNCTION = 'tenant-signup'
const DEFAULT_MEDICATION_BATCH_PREFIX = 'PDF-IMP-'
const VALID_ORGANIZATION_TYPES = ['pharmacy', 'hospital', 'chemical_shop']

// ✅ NHIS PHARMACY LEVEL PATCH START
const isMissingPharmacyLevelColumnError = (error) => {
  const message = String(error?.message || error?.details || '').toLowerCase()
  return error?.code === 'PGRST204' ||
    (message.includes('pharmacy_level') && (message.includes('schema cache') || message.includes('column')))
}

const withoutPharmacyLevel = (payload) => {
  const nextPayload = { ...payload }
  delete nextPayload.pharmacy_level
  return nextPayload
}
// ✅ NHIS PHARMACY LEVEL PATCH END

const normalizeOrganizationType = (value) => {
  const normalized = normalizeText(value).toLowerCase()
  return VALID_ORGANIZATION_TYPES.includes(normalized) ? normalized : 'pharmacy'
}

const invokeTenantSignup = async (payload) => {
  const { data, error } = await invokeSupabaseFunctionPublic(TENANT_SIGNUP_FUNCTION, {
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
  const user = await getCurrentSupabaseUser()
  if (!user?.id) {
    return null
  }

  const { data, error } = await supabase
    .from('users')
    .select(`
      organization_id,
      organizations (*)
    `)
    .eq('id', user.id)
    .maybeSingle()

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
  const organizationType = normalizeOrganizationType(payload.organizationType)
  const organization = {
    name: assertRequiredText(payload.pharmacyName, `${organizationType === 'hospital' ? 'Hospital' : 'Pharmacy'} name`),
    organizationType,
    subdomain: assertRequiredText(payload.subdomain, 'Subdomain').toLowerCase(),
    phone: normalizeText(payload.pharmacyPhone) || null,
    email: normalizeText(payload.pharmacyEmail) || null,
    address: normalizeText(payload.address) || null,
    city: normalizeText(payload.city) || null,
    region: normalizeGhanaRegion(payload.region) || null,
    logoUrl: normalizeText(payload.logoUrl) || null,
    slogan: normalizeText(payload.slogan) || null,
    licenseNumber: normalizeText(payload.licenseNumber) || null,
    // ✅ NHIS PHARMACY LEVEL PATCH START
    pharmacyLevel: organizationType === 'pharmacy' ? normalizePharmacyLevel(payload.pharmacyLevel) : '',
    // ✅ NHIS PHARMACY LEVEL PATCH END
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

  const organizationType = normalizeOrganizationType(orgData.organizationType ?? orgData.organization_type)
  const payload = {
    name: normalizeText(name),
    organization_type: organizationType,
    subdomain: subdomain,
    address: normalizeText(orgData.address) || null,
    city: normalizeText(orgData.city) || null,
    region: normalizeGhanaRegion(orgData.region) || null,
    phone: normalizeText(orgData.phone) || null,
    email: normalizeText(orgData.email) || null,
    logo_url: normalizeText(orgData.logoUrl ?? orgData.logo_url) || null,
    slogan: normalizeText(orgData.slogan) || null,
    license_number: normalizeText(orgData.licenseNumber) || null,
    // ✅ NHIS PHARMACY LEVEL PATCH START
    pharmacy_level: organizationType === 'pharmacy' ? normalizePharmacyLevel(orgData.pharmacyLevel) || null : null,
    // ✅ NHIS PHARMACY LEVEL PATCH END
    status: 'trial', // Start with trial
    subscription_tier: 'trial',
    trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
  }

  let { data, error } = await supabase
    .from('organizations')
    .insert([payload])
    .select()
    .single()

  // ✅ NHIS PHARMACY LEVEL PATCH START
  if (error && isMissingPharmacyLevelColumnError(error)) {
    ;({ data, error } = await supabase
      .from('organizations')
      .insert([withoutPharmacyLevel(payload)])
      .select()
      .single())
  }
  // ✅ NHIS PHARMACY LEVEL PATCH END

  if (error) throw error

  return data
}

/**
 * Update organization details
 */
export const updateOrganization = async (orgId, updates) => {
  const nextOrganizationType =
    updates.organizationType !== undefined || updates.organization_type !== undefined
      ? normalizeOrganizationType(updates.organizationType ?? updates.organization_type)
      : undefined
  const payload = {
    name: updates.name ? normalizeText(updates.name) : undefined,
    organization_type: nextOrganizationType,
    address: updates.address !== undefined ? normalizeText(updates.address) || null : undefined,
    city: updates.city !== undefined ? normalizeText(updates.city) || null : undefined,
    region: updates.region !== undefined ? normalizeGhanaRegion(updates.region) || null : undefined,
    phone: updates.phone !== undefined ? normalizeText(updates.phone) || null : undefined,
    email: updates.email !== undefined ? normalizeText(updates.email) || null : undefined,
    logo_url: updates.logoUrl !== undefined ? normalizeText(updates.logoUrl) || null : undefined,
    slogan: updates.slogan !== undefined ? normalizeText(updates.slogan) || null : undefined,
    license_number: updates.licenseNumber !== undefined ? normalizeText(updates.licenseNumber) || null : undefined,
    // ✅ NHIS PHARMACY LEVEL PATCH START
    pharmacy_level: updates.pharmacyLevel !== undefined
      ? nextOrganizationType === 'hospital'
        ? null
        : normalizePharmacyLevel(updates.pharmacyLevel) || null
      : undefined,
    // ✅ NHIS PHARMACY LEVEL PATCH END
    updated_at: new Date().toISOString(),
  }

  // Remove undefined values
  Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key])

  let { data, error } = await supabase
    .from('organizations')
    .update(payload)
    .eq('id', orgId)
    .select()
    .single()

  // ✅ NHIS PHARMACY LEVEL PATCH START
  if (error && isMissingPharmacyLevelColumnError(error)) {
    ;({ data, error } = await supabase
      .from('organizations')
      .update(withoutPharmacyLevel(payload))
      .eq('id', orgId)
      .select()
      .single())
  }
  // ✅ NHIS PHARMACY LEVEL PATCH END

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
    supabase
      .from('drugs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .not('batch_number', 'ilike', `${DEFAULT_MEDICATION_BATCH_PREFIX}%`),
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
