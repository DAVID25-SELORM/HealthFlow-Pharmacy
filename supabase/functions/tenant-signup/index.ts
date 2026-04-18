import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { buildDefaultMedicationRowsForOrganization } from '../_shared/defaultMedicationCatalog.ts'

const USERS_PER_PAGE = 200
const MAX_USER_PAGES = 10
const SUBDOMAIN_PATTERN = /^[a-z0-9-]+$/
const DEFAULT_CATALOG_SYNC_BATCH_SIZE = 200
const VALID_TIERS = ['trial', 'basic', 'pro', 'enterprise'] as const
const VALID_STATUSES = ['trial', 'active', 'suspended', 'cancelled'] as const
const ORGANIZATION_SELECT_FIELDS =
  'id, name, subdomain, status, subscription_tier, trial_ends_at, subscription_ends_at, phone, email, address, city, region, license_number, created_at, updated_at'
const TENANT_USER_SELECT_FIELDS = 'id, email, full_name, role, is_active, created_at'

type TenantSignupAction =
  | 'check_subdomain'
  | 'register_signup'
  | 'create_tenant'
  | 'get_tenant_admin_dashboard'
  | 'get_tenant_users'
  | 'update_tenant_organization'

type RequesterProfile = {
  id: string
  role: string
  organization_id: string | null
}

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const validateEmail = (value: string, label: string) => {
  const normalized = normalizeText(value).toLowerCase()

  if (!normalized || !normalized.includes('@')) {
    throw new Error(`${label} is required.`)
  }

  return normalized
}

const validateSubdomain = (value: unknown) => {
  const normalized = normalizeText(value).toLowerCase()

  if (!normalized) {
    throw new Error('Subdomain is required.')
  }

  if (!SUBDOMAIN_PATTERN.test(normalized)) {
    throw new Error('Subdomain can only contain lowercase letters, numbers, and hyphens.')
  }

  if (normalized.length < 3 || normalized.length > 50) {
    throw new Error('Subdomain must be between 3 and 50 characters.')
  }

  return normalized
}

const normalizeSubscriptionTier = (value: unknown, fallback: (typeof VALID_TIERS)[number]) => {
  const normalized = normalizeText(value).toLowerCase()
  const mapped =
    normalized === 'standard' || normalized === 'professional'
      ? 'pro'
      : normalized === 'free'
        ? 'basic'
        : normalized

  if (!mapped) {
    return fallback
  }

  if (VALID_TIERS.includes(mapped as (typeof VALID_TIERS)[number])) {
    return mapped as (typeof VALID_TIERS)[number]
  }

  throw new Error('Subscription tier must be trial, basic, pro, or enterprise.')
}

const normalizeOrganizationStatus = (
  value: unknown,
  fallback: (typeof VALID_STATUSES)[number]
) => {
  const normalized = normalizeText(value).toLowerCase()
  const mapped = normalized === 'inactive' ? 'cancelled' : normalized

  if (!mapped) {
    return fallback
  }

  if (VALID_STATUSES.includes(mapped as (typeof VALID_STATUSES)[number])) {
    return mapped as (typeof VALID_STATUSES)[number]
  }

  throw new Error('Organization status must be trial, active, suspended, or cancelled.')
}

const normalizeOptionalIsoDate = (value: unknown) => {
  const normalized = normalizeText(value)
  if (!normalized) {
    return null
  }

  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid organization date value.')
  }

  return parsed.toISOString()
}

const assertValidSubscriptionLifecycle = (input: {
  status: (typeof VALID_STATUSES)[number]
  subscriptionTier: (typeof VALID_TIERS)[number]
  trialEndsAt: string | null
  subscriptionEndsAt: string | null
}) => {
  const { status, subscriptionTier, trialEndsAt, subscriptionEndsAt } = input

  if (status === 'trial' && !trialEndsAt) {
    throw new Error('Trial organizations must include a trial end date.')
  }

  if (status !== 'trial' && subscriptionTier === 'trial') {
    throw new Error('Only organizations in trial status can use the trial tier.')
  }

  if (trialEndsAt && subscriptionEndsAt) {
    const trialEndTime = new Date(trialEndsAt).getTime()
    const subscriptionEndTime = new Date(subscriptionEndsAt).getTime()

    if (
      Number.isFinite(trialEndTime) &&
      Number.isFinite(subscriptionEndTime) &&
      subscriptionEndTime < trialEndTime
    ) {
      throw new Error('Subscription end date cannot be earlier than the trial end date.')
    }
  }
}

const getFunctionEnv = (requireAnonKey = false) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey =
    Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase function environment. Set SUPABASE_URL and SERVICE_ROLE_KEY.')
  }

  if (requireAnonKey && !supabaseAnonKey) {
    throw new Error('Missing Supabase function environment. Set SUPABASE_ANON_KEY.')
  }

  return {
    supabaseUrl,
    supabaseAnonKey: supabaseAnonKey || '',
    serviceRoleKey,
  }
}

const createAdminClient = (supabaseUrl: string, serviceRoleKey: string) =>
  createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

const createUserClient = (supabaseUrl: string, supabaseAnonKey: string, authorization: string) =>
  createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: authorization,
      },
    },
  })

const findAuthUserByEmail = async (
  adminClient: ReturnType<typeof createAdminClient>,
  email: string
) => {
  for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
    const { data, error } = await adminClient.auth.admin.listUsers({
      page,
      perPage: USERS_PER_PAGE,
    })

    if (error) {
      throw error
    }

    const matchedUser = data.users.find(
      (user) => normalizeText(user.email).toLowerCase() === email.toLowerCase()
    )

    if (matchedUser) {
      return matchedUser
    }

    if (data.users.length < USERS_PER_PAGE) {
      break
    }
  }

  return null
}

const getOrganizationBySubdomain = async (
  adminClient: ReturnType<typeof createAdminClient>,
  subdomain: string
) => {
  const { data, error } = await adminClient
    .from('organizations')
    .select('id, name, subdomain')
    .eq('subdomain', subdomain)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

const getRequesterProfile = async (
  adminClient: ReturnType<typeof createAdminClient>,
  userId: string
): Promise<RequesterProfile | null> => {
  const { data, error } = await adminClient
    .from('users')
    .select('id, role, organization_id')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) {
    return null
  }

  return {
    id: data.id,
    role: normalizeText(data.role).toLowerCase(),
    organization_id: normalizeText(data.organization_id) || null,
  }
}

const requireSuperAdmin = async (
  request: Request,
  adminClient: ReturnType<typeof createAdminClient>,
  supabaseUrl: string,
  supabaseAnonKey: string
) => {
  const authorization = request.headers.get('Authorization')
  if (!authorization) {
    return { error: json({ error: 'Missing authorization header.' }, 401) }
  }

  const userClient = createUserClient(supabaseUrl, supabaseAnonKey, authorization)
  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser()

  if (authError || !user) {
    return { error: json({ error: 'You must be signed in to manage tenant onboarding.' }, 401) }
  }

  const requesterProfile = await getRequesterProfile(adminClient, user.id)
  if (!requesterProfile || requesterProfile.role !== 'super_admin') {
    return { error: json({ error: 'Only super admins can create tenant pharmacies.' }, 403) }
  }

  return { requesterProfile }
}

const buildCountsByOrganization = (
  rows: Array<{
    organization_id?: string | null
  }>
) =>
  rows.reduce<Record<string, number>>((acc, row) => {
    const organizationId = normalizeText(row.organization_id)
    if (!organizationId) {
      return acc
    }

    acc[organizationId] = (acc[organizationId] || 0) + 1
    return acc
  }, {})

const syncPharmacySettingsFromOrganization = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organization: {
    id: string
    name: string
    phone?: string | null
    email?: string | null
    address?: string | null
    city?: string | null
    region?: string | null
    license_number?: string | null
  }
) => {
  const payload = {
    pharmacy_name: organization.name,
    phone: normalizeText(organization.phone) || null,
    email: normalizeText(organization.email) || null,
    address: normalizeText(organization.address) || null,
    city: normalizeText(organization.city) || null,
    region: normalizeText(organization.region) || null,
    license_number: normalizeText(organization.license_number) || null,
    updated_at: new Date().toISOString(),
  }

  const { data: existingSettings, error: existingSettingsError } = await adminClient
    .from('pharmacy_settings')
    .select('id')
    .eq('organization_id', organization.id)
    .order('updated_at', { ascending: false })
    .limit(1)

  if (existingSettingsError) {
    throw existingSettingsError
  }

  const existingSettingsId = existingSettings?.[0]?.id
  if (existingSettingsId) {
    const { error: updateSettingsError } = await adminClient
      .from('pharmacy_settings')
      .update(payload)
      .eq('id', existingSettingsId)

    if (updateSettingsError) {
      throw updateSettingsError
    }

    return
  }

  const { error: insertSettingsError } = await adminClient.from('pharmacy_settings').insert([
    {
      organization_id: organization.id,
      ...payload,
    },
  ])

  if (insertSettingsError) {
    throw insertSettingsError
  }
}

const seedDefaultMedicationCatalog = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string
) => {
  const { data: existingDrugs, error } = await adminClient
    .from('drugs')
    .select('batch_number')
    .eq('organization_id', organizationId)

  if (error) {
    throw error
  }

  const existingBatchNumbers = new Set(
    (existingDrugs || [])
      .map((row) => normalizeText(row.batch_number).toUpperCase())
      .filter(Boolean)
  )

  const missingRows = buildDefaultMedicationRowsForOrganization(organizationId, existingBatchNumbers)
  for (let index = 0; index < missingRows.length; index += DEFAULT_CATALOG_SYNC_BATCH_SIZE) {
    const batch = missingRows.slice(index, index + DEFAULT_CATALOG_SYNC_BATCH_SIZE)
    const { error: insertError } = await adminClient.from('drugs').insert(batch)

    if (insertError) {
      throw insertError
    }
  }
}

const getTenantAdminDashboard = async (adminClient: ReturnType<typeof createAdminClient>) => {
  const { data: organizations, error: organizationsError } = await adminClient
    .from('organizations')
    .select(ORGANIZATION_SELECT_FIELDS)
    .order('created_at', { ascending: false })

  if (organizationsError) {
    throw organizationsError
  }

  const organizationIds = (organizations || [])
    .map((organization) => normalizeText(organization.id))
    .filter(Boolean)

  let userCounts: Record<string, number> = {}
  let branchCounts: Record<string, number> = {}

  if (organizationIds.length > 0) {
    const [{ data: userRows, error: usersError }, { data: branchRows, error: branchesError }] =
      await Promise.all([
        adminClient.from('users').select('organization_id').in('organization_id', organizationIds),
        adminClient.from('branches').select('organization_id').in('organization_id', organizationIds),
      ])

    if (usersError) {
      throw usersError
    }

    if (branchesError) {
      throw branchesError
    }

    userCounts = buildCountsByOrganization(userRows || [])
    branchCounts = buildCountsByOrganization(branchRows || [])
  }

  return {
    organizations: organizations || [],
    userCounts,
    branchCounts,
  }
}

const getTenantUsers = async (
  adminClient: ReturnType<typeof createAdminClient>,
  payload: Record<string, unknown>
) => {
  const organizationId = normalizeText(payload.orgId)
  if (!organizationId) {
    throw new Error('Organization id is required.')
  }

  const { data: organization, error: organizationError } = await adminClient
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .maybeSingle()

  if (organizationError) {
    throw organizationError
  }

  if (!organization) {
    throw new Error('Organization not found.')
  }

  const { data: users, error: usersError } = await adminClient
    .from('users')
    .select(TENANT_USER_SELECT_FIELDS)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })

  if (usersError) {
    throw usersError
  }

  return {
    users: users || [],
  }
}

const updateTenantOrganization = async (
  adminClient: ReturnType<typeof createAdminClient>,
  payload: Record<string, unknown>
) => {
  const organizationId = normalizeText(payload.orgId)
  if (!organizationId) {
    throw new Error('Organization id is required.')
  }

  const organizationInput = (payload.organization || {}) as Record<string, unknown>
  const { data: existingOrganization, error: existingOrganizationError } = await adminClient
    .from('organizations')
    .select('id, subdomain, status, subscription_tier, trial_ends_at, subscription_ends_at')
    .eq('id', organizationId)
    .maybeSingle()

  if (existingOrganizationError) {
    throw existingOrganizationError
  }

  if (!existingOrganization) {
    throw new Error('Organization not found.')
  }

  const nextName =
    organizationInput.name !== undefined ? normalizeText(organizationInput.name) : undefined
  if (organizationInput.name !== undefined && !nextName) {
    throw new Error('Organization name is required.')
  }

  const nextEmail =
    organizationInput.email !== undefined
      ? normalizeText(organizationInput.email)
        ? validateEmail(String(organizationInput.email), 'Organization email')
        : null
      : undefined

  const nextSubdomain =
    organizationInput.subdomain !== undefined
      ? validateSubdomain(organizationInput.subdomain)
      : undefined

  if (nextSubdomain && nextSubdomain !== normalizeText(existingOrganization.subdomain)) {
    const conflictingOrganization = await getOrganizationBySubdomain(adminClient, nextSubdomain)
    if (conflictingOrganization && normalizeText(conflictingOrganization.id) !== organizationId) {
      throw new Error('This subdomain is already taken.')
    }
  }

  const updatePayload: Record<string, string | null> = {
    name: nextName ?? null,
    subdomain: nextSubdomain ?? null,
    phone: organizationInput.phone !== undefined ? normalizeText(organizationInput.phone) || null : null,
    email: nextEmail ?? null,
    address:
      organizationInput.address !== undefined ? normalizeText(organizationInput.address) || null : null,
    city: organizationInput.city !== undefined ? normalizeText(organizationInput.city) || null : null,
    region: organizationInput.region !== undefined ? normalizeText(organizationInput.region) || null : null,
    license_number:
      organizationInput.licenseNumber !== undefined
        ? normalizeText(organizationInput.licenseNumber) || null
        : null,
    status:
      organizationInput.status !== undefined
        ? normalizeOrganizationStatus(organizationInput.status, 'trial')
        : null,
    subscription_tier:
      organizationInput.subscriptionTier !== undefined
        ? normalizeSubscriptionTier(organizationInput.subscriptionTier, 'basic')
        : null,
    trial_ends_at:
      organizationInput.trialEndsAt !== undefined
        ? normalizeOptionalIsoDate(organizationInput.trialEndsAt)
        : null,
    subscription_ends_at:
      organizationInput.subscriptionEndsAt !== undefined
        ? normalizeOptionalIsoDate(organizationInput.subscriptionEndsAt)
        : null,
    updated_at: new Date().toISOString(),
  }

  Object.keys(updatePayload).forEach((key) => {
    if (key === 'updated_at') {
      return
    }

    if (organizationInput[key] === undefined && key !== 'license_number' && key !== 'subscription_tier') {
      delete updatePayload[key]
    }
  })

  if (organizationInput.licenseNumber === undefined) {
    delete updatePayload.license_number
  }

  if (organizationInput.subscriptionTier === undefined) {
    delete updatePayload.subscription_tier
  }

  if (organizationInput.trialEndsAt === undefined) {
    delete updatePayload.trial_ends_at
  }

  if (organizationInput.subscriptionEndsAt === undefined) {
    delete updatePayload.subscription_ends_at
  }

  if (organizationInput.subdomain === undefined) {
    delete updatePayload.subdomain
  }

  if (organizationInput.name === undefined) {
    delete updatePayload.name
  }

  if (organizationInput.phone === undefined) {
    delete updatePayload.phone
  }

  if (organizationInput.email === undefined) {
    delete updatePayload.email
  }

  if (organizationInput.address === undefined) {
    delete updatePayload.address
  }

  if (organizationInput.city === undefined) {
    delete updatePayload.city
  }

  if (organizationInput.region === undefined) {
    delete updatePayload.region
  }

  if (organizationInput.status === undefined) {
    delete updatePayload.status
  }

  const nextLifecycleStatus =
    updatePayload.status !== undefined
      ? normalizeOrganizationStatus(updatePayload.status, 'trial')
      : normalizeOrganizationStatus(existingOrganization.status, 'trial')
  const nextLifecycleTier =
    updatePayload.subscription_tier !== undefined
      ? normalizeSubscriptionTier(updatePayload.subscription_tier, 'basic')
      : normalizeSubscriptionTier(existingOrganization.subscription_tier, 'basic')
  const nextTrialEndsAt =
    updatePayload.trial_ends_at !== undefined
      ? updatePayload.trial_ends_at
      : normalizeOptionalIsoDate(existingOrganization.trial_ends_at)
  const nextSubscriptionEndsAt =
    updatePayload.subscription_ends_at !== undefined
      ? updatePayload.subscription_ends_at
      : normalizeOptionalIsoDate(existingOrganization.subscription_ends_at)

  assertValidSubscriptionLifecycle({
    status: nextLifecycleStatus,
    subscriptionTier: nextLifecycleTier,
    trialEndsAt: nextTrialEndsAt,
    subscriptionEndsAt: nextSubscriptionEndsAt,
  })

  const { data: updatedOrganization, error: updateOrganizationError } = await adminClient
    .from('organizations')
    .update(updatePayload)
    .eq('id', organizationId)
    .select(ORGANIZATION_SELECT_FIELDS)
    .maybeSingle()

  if (updateOrganizationError) {
    throw updateOrganizationError
  }

  if (!updatedOrganization) {
    throw new Error('Organization could not be updated.')
  }

  await syncPharmacySettingsFromOrganization(adminClient, {
    id: updatedOrganization.id,
    name: updatedOrganization.name,
    phone: updatedOrganization.phone,
    email: updatedOrganization.email,
    address: updatedOrganization.address,
    city: updatedOrganization.city,
    region: updatedOrganization.region,
    license_number: updatedOrganization.license_number,
  })

  return {
    organization: updatedOrganization,
  }
}

const checkSubdomain = async (
  adminClient: ReturnType<typeof createAdminClient>,
  payload: Record<string, unknown>
) => {
  const subdomain = validateSubdomain(payload.subdomain)
  const existingOrganization = await getOrganizationBySubdomain(adminClient, subdomain)

  if (existingOrganization) {
    return {
      available: false,
      message: 'This subdomain is already taken.',
    }
  }

  return {
    available: true,
    message: 'Subdomain is available!',
  }
}

const bootstrapOrganization = async (
  adminClient: ReturnType<typeof createAdminClient>,
  payload: Record<string, unknown>,
  defaults: {
    defaultStatus: (typeof VALID_STATUSES)[number]
    defaultTier: (typeof VALID_TIERS)[number]
    allowCustomStatus: boolean
    allowCustomTier: boolean
    defaultTrialEndsAt?: string | null
    defaultSubscriptionEndsAt?: string | null
  }
) => {
  const organizationInput = (payload.organization || {}) as Record<string, unknown>
  const adminUserInput = (payload.adminUser || {}) as Record<string, unknown>

  const organizationName = normalizeText(organizationInput.name)
  if (!organizationName) {
    throw new Error('Organization name is required.')
  }

  const subdomain = validateSubdomain(organizationInput.subdomain)
  const adminEmail = validateEmail(String(adminUserInput.email || ''), 'Admin email')
  const adminFullName = normalizeText(adminUserInput.fullName)
  const adminPassword = normalizeText(adminUserInput.password)

  if (!adminFullName) {
    throw new Error('Admin full name is required.')
  }

  if (!adminPassword || adminPassword.length < 8) {
    throw new Error('Admin password must be at least 8 characters.')
  }

  const organizationStatus = defaults.allowCustomStatus
    ? normalizeOrganizationStatus(organizationInput.status, defaults.defaultStatus)
    : defaults.defaultStatus

  const subscriptionTier = defaults.allowCustomTier
    ? normalizeSubscriptionTier(organizationInput.subscriptionTier, defaults.defaultTier)
    : defaults.defaultTier

  const trialEndsAt =
    normalizeOptionalIsoDate(organizationInput.trialEndsAt) ?? defaults.defaultTrialEndsAt ?? null
  const subscriptionEndsAt =
    normalizeOptionalIsoDate(organizationInput.subscriptionEndsAt) ??
    defaults.defaultSubscriptionEndsAt ??
    null

  assertValidSubscriptionLifecycle({
    status: organizationStatus,
    subscriptionTier,
    trialEndsAt,
    subscriptionEndsAt,
  })

  const subdomainCheck = await checkSubdomain(adminClient, { subdomain })
  if (!subdomainCheck.available) {
    throw new Error(String(subdomainCheck.message || 'This subdomain is already taken.'))
  }

  const existingAuthUser = await findAuthUserByEmail(adminClient, adminEmail)
  if (existingAuthUser) {
    throw new Error('An account with this email already exists.')
  }

  const { data: existingPublicUser, error: existingPublicUserError } = await adminClient
    .from('users')
    .select('id')
    .eq('email', adminEmail)
    .maybeSingle()

  if (existingPublicUserError) {
    throw existingPublicUserError
  }

  if (existingPublicUser) {
    throw new Error('An account with this email already exists.')
  }

  let organizationId: string | null = null
  let authUserId: string | null = null

  try {
    const { data: organization, error: organizationError } = await adminClient
      .from('organizations')
      .insert([
        {
          name: organizationName,
          subdomain,
          address: normalizeText(organizationInput.address) || null,
          city: normalizeText(organizationInput.city) || null,
          region: normalizeText(organizationInput.region) || null,
          phone: normalizeText(organizationInput.phone) || null,
          email: normalizeText(organizationInput.email) || adminEmail,
          license_number: normalizeText(organizationInput.licenseNumber) || null,
          status: organizationStatus,
          subscription_tier: subscriptionTier,
          trial_ends_at: trialEndsAt,
          subscription_ends_at: subscriptionEndsAt,
        },
      ])
      .select(
        'id, name, subdomain, status, subscription_tier, trial_ends_at, subscription_ends_at'
      )
      .single()

    if (organizationError) {
      throw organizationError
    }

    organizationId = organization.id

    const { data: createdUserData, error: createUserError } =
      await adminClient.auth.admin.createUser({
        email: adminEmail,
        password: adminPassword,
        email_confirm: true,
        user_metadata: {
          full_name: adminFullName,
          phone: normalizeText(adminUserInput.phone) || null,
        },
        app_metadata: {
          role: 'admin',
        },
      })

    if (createUserError || !createdUserData.user) {
      throw createUserError || new Error('Unable to create the admin user.')
    }

    authUserId = createdUserData.user.id

    const { error: publicUserError } = await adminClient.from('users').insert([
      {
        id: authUserId,
        email: adminEmail,
        full_name: adminFullName,
        phone: normalizeText(adminUserInput.phone) || null,
        role: 'admin',
        organization_id: organizationId,
        is_active: true,
      },
    ])

    if (publicUserError) {
      throw publicUserError
    }

    const { error: ownerError } = await adminClient
      .from('organizations')
      .update({
        owner_user_id: authUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', organizationId)

    if (ownerError) {
      throw ownerError
    }

    const { error: settingsError } = await adminClient.from('pharmacy_settings').insert([
      {
        organization_id: organizationId,
        pharmacy_name: organizationName,
        phone: normalizeText(organizationInput.phone) || null,
        email: normalizeText(organizationInput.email) || adminEmail,
        address: normalizeText(organizationInput.address) || null,
        city: normalizeText(organizationInput.city) || null,
        region: normalizeText(organizationInput.region) || null,
        license_number: normalizeText(organizationInput.licenseNumber) || null,
      },
    ])

    if (settingsError) {
      throw settingsError
    }

    await seedDefaultMedicationCatalog(adminClient, organizationId)

    return {
      organization,
      user: {
        id: authUserId,
        email: adminEmail,
        full_name: adminFullName,
        role: 'admin',
        organization_id: organizationId,
      },
    }
  } catch (error) {
    if (authUserId) {
      const { error: deleteUserError } = await adminClient.auth.admin.deleteUser(authUserId)
      if (deleteUserError) {
        console.error('tenant-signup cleanup failed for auth user:', deleteUserError)
      }
    }

    if (organizationId) {
      const { error: deleteOrganizationError } = await adminClient
        .from('organizations')
        .delete()
        .eq('id', organizationId)

      if (deleteOrganizationError) {
        console.error('tenant-signup cleanup failed for organization:', deleteOrganizationError)
      }
    }

    throw error
  }
}

const registerSignup = async (
  adminClient: ReturnType<typeof createAdminClient>,
  payload: Record<string, unknown>
) =>
  bootstrapOrganization(adminClient, payload, {
    defaultStatus: 'trial',
    defaultTier: 'trial',
    allowCustomStatus: false,
    allowCustomTier: false,
    defaultTrialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    defaultSubscriptionEndsAt: null,
  })

const createTenant = async (
  adminClient: ReturnType<typeof createAdminClient>,
  payload: Record<string, unknown>
) =>
  bootstrapOrganization(adminClient, payload, {
    defaultStatus: 'trial',
    defaultTier: 'basic',
    allowCustomStatus: true,
    allowCustomTier: true,
    defaultTrialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    defaultSubscriptionEndsAt: null,
  })

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405)
  }

  try {
    const payload = (await request.json()) as Record<string, unknown>
    const action = normalizeText(payload.action) as TenantSignupAction

    if (action === 'check_subdomain' || action === 'register_signup') {
      const { supabaseUrl, serviceRoleKey } = getFunctionEnv(false)
      const adminClient = createAdminClient(supabaseUrl, serviceRoleKey)

      if (action === 'check_subdomain') {
        return json(await checkSubdomain(adminClient, payload))
      }

      return json(await registerSignup(adminClient, payload))
    }

    if (action === 'create_tenant') {
      const { supabaseUrl, supabaseAnonKey, serviceRoleKey } = getFunctionEnv(true)
      const adminClient = createAdminClient(supabaseUrl, serviceRoleKey)
      const authorizationResult = await requireSuperAdmin(
        request,
        adminClient,
        supabaseUrl,
        supabaseAnonKey
      )

      if ('error' in authorizationResult) {
        return authorizationResult.error
      }

      return json(await createTenant(adminClient, payload))
    }

    if (
      action === 'get_tenant_admin_dashboard' ||
      action === 'get_tenant_users' ||
      action === 'update_tenant_organization'
    ) {
      const { supabaseUrl, supabaseAnonKey, serviceRoleKey } = getFunctionEnv(true)
      const adminClient = createAdminClient(supabaseUrl, serviceRoleKey)
      const authorizationResult = await requireSuperAdmin(
        request,
        adminClient,
        supabaseUrl,
        supabaseAnonKey
      )

      if ('error' in authorizationResult) {
        return authorizationResult.error
      }

      if (action === 'get_tenant_admin_dashboard') {
        return json(await getTenantAdminDashboard(adminClient))
      }

      if (action === 'get_tenant_users') {
        return json(await getTenantUsers(adminClient, payload))
      }

      return json(await updateTenantOrganization(adminClient, payload))
    }

    return json({ error: 'Unsupported tenant signup action.' }, 400)
  } catch (error) {
    console.error('tenant-signup error:', error)
    const message = error instanceof Error ? error.message : 'Unexpected tenant signup error.'
    return json({ error: message }, 400)
  }
})
