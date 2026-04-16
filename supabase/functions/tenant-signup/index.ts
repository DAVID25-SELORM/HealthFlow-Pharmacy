import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const USERS_PER_PAGE = 200
const MAX_USER_PAGES = 10
const SUBDOMAIN_PATTERN = /^[a-z0-9-]+$/

type TenantSignupAction = 'check_subdomain' | 'register_signup'

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

const getFunctionEnv = () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey =
    Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Missing Supabase function environment. Set SUPABASE_URL and SERVICE_ROLE_KEY.'
    )
  }

  return {
    supabaseUrl,
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

const registerSignup = async (
  adminClient: ReturnType<typeof createAdminClient>,
  payload: Record<string, unknown>
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

  if (!adminPassword || adminPassword.length < 6) {
    throw new Error('Admin password must be at least 6 characters.')
  }

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
          status: 'trial',
          subscription_tier: 'trial',
          trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ])
      .select('id, name, subdomain, status, subscription_tier, trial_ends_at')
      .single()

    if (organizationError) {
      throw organizationError
    }

    organizationId = organization.id

    const { data: createdUserData, error: createUserError } = await adminClient.auth.admin.createUser({
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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405)
  }

  try {
    const { supabaseUrl, serviceRoleKey } = getFunctionEnv()
    const adminClient = createAdminClient(supabaseUrl, serviceRoleKey)

    const payload = (await request.json()) as Record<string, unknown>
    const action = normalizeText(payload.action) as TenantSignupAction

    if (action === 'check_subdomain') {
      return json(await checkSubdomain(adminClient, payload))
    }

    if (action === 'register_signup') {
      return json(await registerSignup(adminClient, payload))
    }

    return json({ error: 'Unsupported tenant signup action.' }, 400)
  } catch (error) {
    console.error('tenant-signup error:', error)
    const message = error instanceof Error ? error.message : 'Unexpected tenant signup error.'
    return json({ error: message }, 400)
  }
})
