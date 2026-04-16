import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const USER_ROLES = ['admin', 'pharmacist', 'assistant'] as const
const DISABLE_DURATION = '876000h'
const USERS_PER_PAGE = 200
const MAX_USER_PAGES = 10

type StaffRole = (typeof USER_ROLES)[number]
type StaffAction = 'upsert_staff_user' | 'set_staff_status'

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const isValidRole = (value: string): value is StaffRole =>
  USER_ROLES.includes(value as StaffRole)

const deriveDisplayName = (email: string, fullName?: string | null) => {
  const normalizedName = normalizeText(fullName)
  if (normalizedName) {
    return normalizedName
  }

  const [emailPrefix = 'Staff User'] = email.split('@')
  return emailPrefix
}

const userIsActive = (user: { banned_until?: string | null }) => {
  if (!user?.banned_until) {
    return true
  }

  return new Date(user.banned_until).getTime() <= Date.now()
}

const getRoleFromUser = (user: {
  app_metadata?: Record<string, unknown> | null
  user_metadata?: Record<string, unknown> | null
}) => {
  const candidate = normalizeText(user?.app_metadata?.role ?? user?.user_metadata?.role).toLowerCase()
  return isValidRole(candidate) ? candidate : 'assistant'
}

const getFunctionEnv = () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey =
    Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    throw new Error(
      'Missing Supabase function environment. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SERVICE_ROLE_KEY.'
    )
  }

  return {
    supabaseUrl,
    supabaseAnonKey,
    serviceRoleKey,
  }
}

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

const getRequesterProfile = async (
  adminClient: ReturnType<typeof createAdminClient>,
  userId: string
) => {
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

  const roleCandidate = normalizeText(data.role).toLowerCase()

  return {
    id: data.id,
    role: isValidRole(roleCandidate) ? roleCandidate : 'assistant',
    organization_id: normalizeText(data.organization_id) || null,
  }
}

const syncPublicUser = async (
  adminClient: ReturnType<typeof createAdminClient>,
  authUser: {
    id: string
    email?: string | null
    phone?: string | null
    app_metadata?: Record<string, unknown> | null
    user_metadata?: Record<string, unknown> | null
    banned_until?: string | null
  },
  overrides: {
    fullName?: string | null
    phone?: string | null
    role?: StaffRole
    isActive?: boolean
    organizationId?: string | null
  } = {}
) => {
  const email = normalizeText(authUser.email).toLowerCase()
  const fullName = deriveDisplayName(email, overrides.fullName ?? normalizeText(authUser.user_metadata?.full_name))
  const phone = normalizeText(overrides.phone ?? authUser.user_metadata?.phone ?? authUser.phone) || null
  const role = overrides.role || getRoleFromUser(authUser)
  const isActive = overrides.isActive ?? userIsActive(authUser)
  const requestedOrganizationId = normalizeText(overrides.organizationId)

  const { data: conflictingUser, error: conflictingUserError } = await adminClient
    .from('users')
    .select('id, email, organization_id')
    .eq('email', email)
    .maybeSingle()

  if (conflictingUserError) {
    throw conflictingUserError
  }

  if (conflictingUser && conflictingUser.id !== authUser.id) {
    throw new Error(`public.users already contains ${email} under a different account id.`)
  }

  const { data: existingProfile, error: existingProfileError } = await adminClient
    .from('users')
    .select('id, organization_id')
    .eq('id', authUser.id)
    .maybeSingle()

  if (existingProfileError) {
    throw existingProfileError
  }

  const existingOrganizationId = normalizeText(existingProfile?.organization_id)
  const conflictingOrganizationId = normalizeText(conflictingUser?.organization_id)

  if (
    requestedOrganizationId &&
    existingOrganizationId &&
    existingOrganizationId !== requestedOrganizationId
  ) {
    throw new Error('This user already belongs to another organization.')
  }

  if (
    requestedOrganizationId &&
    conflictingOrganizationId &&
    conflictingOrganizationId !== requestedOrganizationId
  ) {
    throw new Error('This email is already assigned to another organization.')
  }

  const organizationId =
    requestedOrganizationId || existingOrganizationId || conflictingOrganizationId || null

  const { error: syncError } = await adminClient.from('users').upsert(
    {
      id: authUser.id,
      email,
      full_name: fullName,
      phone,
      role,
      is_active: isActive,
      organization_id: organizationId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  )

  if (syncError) {
    throw syncError
  }

  return {
    id: authUser.id,
    email,
    full_name: fullName,
    phone,
    role,
    is_active: isActive,
    organization_id: organizationId,
  }
}

const upsertStaffUser = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  const email = normalizeText(payload.email).toLowerCase()
  const fullName = normalizeText(payload.fullName)
  const phone = normalizeText(payload.phone) || null
  const password = normalizeText(payload.password)
  const roleCandidate = normalizeText(payload.role).toLowerCase()

  if (!email) {
    throw new Error('Email is required.')
  }

  if (!fullName) {
    throw new Error('Full name is required.')
  }

  if (!password || password.length < 8) {
    throw new Error('Temporary password must be at least 8 characters.')
  }

  if (!isValidRole(roleCandidate)) {
    throw new Error('Role must be admin, pharmacist, or assistant.')
  }

  const metadata = {
    full_name: fullName,
    phone,
    role: roleCandidate,
  }

  const existingUser = await findAuthUserByEmail(adminClient, email)

  if (existingUser) {
    const { data, error } = await adminClient.auth.admin.updateUserById(existingUser.id, {
      password,
      email_confirm: true,
      ban_duration: 'none',
      user_metadata: {
        ...(existingUser.user_metadata || {}),
        ...metadata,
      },
      app_metadata: {
        ...(existingUser.app_metadata || {}),
        role: roleCandidate,
      },
    })

    if (error || !data.user) {
      throw error || new Error('Unable to update the staff user.')
    }

    const syncedProfile = await syncPublicUser(adminClient, data.user, {
      fullName,
      phone,
      role: roleCandidate,
      isActive: true,
      organizationId,
    })

    return {
      mode: 'updated',
      user: syncedProfile,
    }
  }

  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: metadata,
    app_metadata: {
      role: roleCandidate,
    },
  })

  if (error || !data.user) {
    throw error || new Error('Unable to create the staff user.')
  }

  const syncedProfile = await syncPublicUser(adminClient, data.user, {
    fullName,
    phone,
    role: roleCandidate,
    isActive: true,
    organizationId,
  })

  return {
    mode: 'created',
    user: syncedProfile,
  }
}

const setStaffStatus = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterId: string,
  organizationId: string,
  payload: Record<string, unknown>
) => {
  const userId = normalizeText(payload.userId)
  const isActive = Boolean(payload.isActive)

  if (!userId) {
    throw new Error('User id is required.')
  }

  if (!isActive && requesterId === userId) {
    throw new Error('You cannot disable your own admin account.')
  }

  const { data: targetProfile, error: targetProfileError } = await adminClient
    .from('users')
    .select('id, organization_id')
    .eq('id', userId)
    .maybeSingle()

  if (targetProfileError) {
    throw targetProfileError
  }

  if (!targetProfile || normalizeText(targetProfile.organization_id) !== organizationId) {
    throw new Error('You can only manage staff accounts in your own organization.')
  }

  const { data, error } = await adminClient.auth.admin.getUserById(userId)
  if (error) {
    throw error
  }

  const authUser = data.user

  const { data: updatedUserData, error: updateError } = await adminClient.auth.admin.updateUserById(
    userId,
    {
      ban_duration: isActive ? 'none' : DISABLE_DURATION,
    }
  )

  if (updateError) {
    throw updateError
  }

  const syncedProfile = await syncPublicUser(adminClient, updatedUserData.user || authUser, {
    isActive,
    organizationId,
  })

  return {
    user: syncedProfile,
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
    const authorization = request.headers.get('Authorization')
    if (!authorization) {
      return json({ error: 'Missing authorization header.' }, 401)
    }

    const { supabaseUrl, supabaseAnonKey, serviceRoleKey } = getFunctionEnv()
    const userClient = createUserClient(supabaseUrl, supabaseAnonKey, authorization)
    const adminClient = createAdminClient(supabaseUrl, serviceRoleKey)

    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser()

    if (authError || !user) {
      return json({ error: 'You must be signed in to manage staff accounts.' }, 401)
    }

    const requesterProfile = await getRequesterProfile(adminClient, user.id)
    if (!requesterProfile || requesterProfile.role !== 'admin') {
      return json({ error: 'Only admin users can manage staff accounts.' }, 403)
    }

    if (!requesterProfile.organization_id) {
      return json({ error: 'Admin account is missing organization context.' }, 400)
    }

    const payload = (await request.json()) as Record<string, unknown>
    const action = normalizeText(payload.action) as StaffAction

    if (action === 'upsert_staff_user') {
      return json(await upsertStaffUser(adminClient, requesterProfile.organization_id, payload))
    }

    if (action === 'set_staff_status') {
      return json(
        await setStaffStatus(adminClient, user.id, requesterProfile.organization_id, payload)
      )
    }

    return json({ error: 'Unsupported staff action.' }, 400)
  } catch (error) {
    console.error('staff-admin error:', error)
    const message = error instanceof Error ? error.message : 'Unexpected staff admin error.'
    return json({ error: message }, 400)
  }
})
