import { invokeSupabaseFunction, supabase } from '../lib/supabase'

const TENANT_SIGNUP_FUNCTION = 'tenant-signup'
const STAFF_ADMIN_FUNCTION = 'staff-admin'
const VALID_STATUSES = ['trial', 'active', 'suspended', 'cancelled']
const VALID_TIERS = ['trial', 'basic', 'pro', 'enterprise']

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '')

const normalizeOrganizationStatus = (status, fallback = 'trial') => {
  const normalized = normalizeText(status).toLowerCase()
  const mapped = normalized === 'inactive' ? 'cancelled' : normalized

  if (!mapped) {
    return fallback
  }

  if (!VALID_STATUSES.includes(mapped)) {
    throw new Error('Select a valid organization status.')
  }

  return mapped
}

const normalizeSubscriptionTier = (tier, fallback = 'basic') => {
  const normalized = normalizeText(tier).toLowerCase()
  const mapped =
    normalized === 'standard' || normalized === 'professional'
      ? 'pro'
      : normalized === 'free'
        ? 'basic'
        : normalized

  if (!mapped) {
    return fallback
  }

  if (!VALID_TIERS.includes(mapped)) {
    throw new Error('Select a valid subscription tier.')
  }

  return mapped
}

const normalizeOptionalIsoDate = (value) => {
  const normalized = normalizeText(value)
  if (!normalized) {
    return null
  }

  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Enter a valid date.')
  }

  return parsed.toISOString()
}

const invokeFunction = async (name, payload) => {
  const { data, error } = await invokeSupabaseFunction(name, {
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
  return (data || []).map((organization) => ({
    ...organization,
    status: normalizeOrganizationStatus(organization.status),
    subscription_tier: normalizeSubscriptionTier(
      organization.subscription_tier,
      organization.status === 'trial' ? 'trial' : 'basic'
    ),
  }))
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
export const createPharmacyTenant = async ({ pharmacy, admin }) =>
  invokeFunction(TENANT_SIGNUP_FUNCTION, {
    action: 'create_tenant',
    organization: {
      name: normalizeText(pharmacy.name),
      subdomain: normalizeText(pharmacy.subdomain).toLowerCase(),
      phone: normalizeText(pharmacy.phone) || null,
      email: normalizeText(pharmacy.email) || null,
      address: normalizeText(pharmacy.address) || null,
      city: normalizeText(pharmacy.city) || null,
      region: normalizeText(pharmacy.region) || null,
      licenseNumber: normalizeText(pharmacy.licenseNumber) || null,
      status: 'trial',
      subscriptionTier: normalizeSubscriptionTier(pharmacy.subscriptionTier, 'basic'),
    },
    adminUser: {
      fullName: normalizeText(admin.fullName),
      email: normalizeText(admin.email).toLowerCase(),
      phone: normalizeText(admin.phone) || null,
      password: normalizeText(admin.temporaryPassword),
    },
  })

/**
 * Update organization status (activate / suspend / cancel / set trial)
 */
export const updateOrganizationStatus = async (orgId, status) => {
  const { data, error } = await supabase
    .from('organizations')
    .update({
      status: normalizeOrganizationStatus(status),
      updated_at: new Date().toISOString(),
    })
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
    .update({
      subscription_tier: normalizeSubscriptionTier(tier),
      updated_at: new Date().toISOString(),
    })
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
  const normalized = normalizeText(subdomain).toLowerCase()

  if (!/^[a-z0-9-]+$/.test(normalized)) {
    return false
  }

  if (normalized.length < 3 || normalized.length > 50) {
    return false
  }

  const result = await invokeFunction(TENANT_SIGNUP_FUNCTION, {
    action: 'check_subdomain',
    subdomain: normalized,
  })

  return Boolean(result?.available)
}

/**
 * Update full organization details (name, contact, address, license, tier, status, trial end)
 */
export const updateOrganizationDetails = async (orgId, fields) => {
  const payload = {
    name: normalizeText(fields.name) || undefined,
    phone: fields.phone !== undefined ? normalizeText(fields.phone) || null : undefined,
    email: fields.email !== undefined ? normalizeText(fields.email) || null : undefined,
    address: fields.address !== undefined ? normalizeText(fields.address) || null : undefined,
    city: fields.city !== undefined ? normalizeText(fields.city) || null : undefined,
    region: fields.region !== undefined ? normalizeText(fields.region) || null : undefined,
    license_number:
      fields.licenseNumber !== undefined ? normalizeText(fields.licenseNumber) || null : undefined,
    status:
      fields.status !== undefined ? normalizeOrganizationStatus(fields.status) : undefined,
    subscription_tier:
      fields.subscriptionTier !== undefined
        ? normalizeSubscriptionTier(fields.subscriptionTier)
        : undefined,
    trial_ends_at:
      fields.trialEndsAt !== undefined ? normalizeOptionalIsoDate(fields.trialEndsAt) : undefined,
    subscription_ends_at:
      fields.subscriptionEndsAt !== undefined
        ? normalizeOptionalIsoDate(fields.subscriptionEndsAt)
        : undefined,
    updated_at: new Date().toISOString(),
  }

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
 * Update a user's details and sync Supabase Auth + public.users
 */
export const updateOrganizationUser = async (userId, fields) => {
  const response = await invokeFunction(STAFF_ADMIN_FUNCTION, {
    action: 'update_staff_user',
    userId,
    fullName: normalizeText(fields.fullName),
    email: normalizeText(fields.email).toLowerCase(),
    role: normalizeText(fields.role).toLowerCase(),
    isActive: Boolean(fields.isActive),
  })

  return response.user
}
