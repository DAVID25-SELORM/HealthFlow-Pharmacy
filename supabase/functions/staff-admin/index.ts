import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { resolveTierAccess } from '../_shared/tier.ts'

const STAFF_ROLES = [
  'admin',
  'pharmacist',
  'assistant',
  'technician',
  'cashier',
  'inventory_officer',
  'accounts_officer',
  'nurse',
  'doctor',
  'records_officer',
  'other',
  'branch_manager',
  'procurement',
  'claims_officer',
  'billing',
  'delivery',
] as const
const DISABLE_DURATION = '876000h'
const USERS_PER_PAGE = 200
const MAX_USER_PAGES = 10

type StaffRole = (typeof STAFF_ROLES)[number]
type StaffAction =
  | 'upsert_staff_user'
  | 'set_staff_status'
  | 'set_refund_permission'
  | 'set_staff_branch'
  | 'update_staff_user'
  | 'update_staff_access'
type RequesterProfile = {
  id: string
  role: string
  assigned_roles: string[]
  organization_id: string | null
}

const formatTierLabel = (tier: string) => {
  if (tier === 'pro') {
    return 'Professional'
  }

  return tier.charAt(0).toUpperCase() + tier.slice(1)
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

const isValidRole = (value: string): value is StaffRole =>
  STAFF_ROLES.includes(value as StaffRole)

const staffRoleMessage = () => `Role must be one of: ${STAFF_ROLES.join(', ')}.`

const normalizeAssignedRoles = (value: unknown, primaryRole: StaffRole) => {
  const values = Array.isArray(value) ? value : []
  return [...new Set([primaryRole, ...values.map((role) => normalizeText(role).toLowerCase())])]
    .filter((role): role is StaffRole => isValidRole(role))
}

const requesterHasRole = (profile: RequesterProfile, roles: string[]) =>
  roles.some((role) => role === profile.role || profile.assigned_roles.includes(role))

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

const isMissingUserPrivilegeColumn = (error: unknown) => {
  const payload = error as { code?: string; status?: number; statusCode?: number; message?: string; details?: string }
  const message = normalizeText(payload?.message || payload?.details).toLowerCase()
  const status = Number(payload?.status || payload?.statusCode || 0)
  return (
    status === 400 ||
    payload?.code === '42703' ||
    payload?.code === 'PGRST204' ||
    message.includes('assigned_roles')
  )
}

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
): Promise<RequesterProfile | null> => {
  const runQuery = async (columns: string) =>
    await adminClient
      .from('users')
      .select(columns)
      .eq('id', userId)
      .maybeSingle()

  let { data, error } = await runQuery('id, role, assigned_roles, organization_id')

  if (error && isMissingUserPrivilegeColumn(error)) {
    const legacyResult = await runQuery('id, role, organization_id')
    data = legacyResult.data
      ? {
          ...legacyResult.data,
          assigned_roles: [legacyResult.data.role].filter(Boolean),
        }
      : legacyResult.data
    error = legacyResult.error
  }

  if (error) {
    throw error
  }

  if (!data) {
    return null
  }

  return {
    id: data.id,
    role: normalizeText(data.role).toLowerCase(),
    assigned_roles: Array.isArray(data.assigned_roles)
      ? data.assigned_roles.map((role: unknown) => normalizeText(role).toLowerCase()).filter(Boolean)
      : [],
    organization_id: normalizeText(data.organization_id) || null,
  }
}

const getOrganizationTierContext = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string
) => {
  const { data: organization, error } = await adminClient
    .from('organizations')
    .select('id, status, billing_status, subscription_tier, trial_ends_at, subscription_ends_at, can_use_claims')
    .eq('id', organizationId)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!organization) {
    throw new Error('Organization not found.')
  }

  return resolveTierAccess(organization)
}

const assertOrganizationCanAddUsers = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  additionalUsers = 1
) => {
  const tierContext = await getOrganizationTierContext(adminClient, organizationId)
  if (tierContext.isSuspended) {
    throw new Error('This pharmacy is locked. Contact platform support to restore access.')
  }

  const maxUsers = tierContext.tierLimits.maxUsers
  if (!Number.isFinite(maxUsers)) {
    return
  }

  const { count, error } = await adminClient
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)

  if (error) {
    throw error
  }

  if ((count || 0) + additionalUsers > maxUsers) {
    throw new Error(
      `This organization has reached the ${maxUsers}-user limit for its ${formatTierLabel(
        tierContext.effectiveTier
      )} plan.`
    )
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
    assignedRoles?: StaffRole[]
    isActive?: boolean
    organizationId?: string | null
    canRefund?: boolean
    canManageInventory?: boolean
    canViewReports?: boolean
    canManageClaims?: boolean
    canManagePurchases?: boolean
    canProcessSales?: boolean
    canManagePatients?: boolean
    canManageAccounting?: boolean
    canManageEpharmacy?: boolean
    canViewActivityLog?: boolean
    canAdjustStock?: boolean
    canApprovePurchases?: boolean
    canDeleteNhisClaims?: boolean
    branchId?: string | null
  } = {}
) => {
  const email = normalizeText(authUser.email).toLowerCase()
  const fullName = deriveDisplayName(
    email,
    overrides.fullName ?? normalizeText(authUser.user_metadata?.full_name)
  )
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
      ...(overrides.assignedRoles ? { assigned_roles: overrides.assignedRoles } : {}),
      is_active: isActive,
      organization_id: organizationId,
      ...(typeof overrides.canRefund === 'boolean' ? { can_refund: overrides.canRefund } : {}),
      ...(typeof overrides.canManageInventory === 'boolean' ? { can_manage_inventory: overrides.canManageInventory } : {}),
      ...(typeof overrides.canViewReports === 'boolean' ? { can_view_reports: overrides.canViewReports } : {}),
      ...(typeof overrides.canManageClaims === 'boolean' ? { can_manage_claims: overrides.canManageClaims } : {}),
      ...(typeof overrides.canManagePurchases === 'boolean' ? { can_manage_purchases: overrides.canManagePurchases } : {}),
      ...(typeof overrides.canProcessSales === 'boolean' ? { can_process_sales: overrides.canProcessSales } : {}),
      ...(typeof overrides.canManagePatients === 'boolean' ? { can_manage_patients: overrides.canManagePatients } : {}),
      ...(typeof overrides.canManageAccounting === 'boolean' ? { can_manage_accounting: overrides.canManageAccounting } : {}),
      ...(typeof overrides.canManageEpharmacy === 'boolean' ? { can_manage_epharmacy: overrides.canManageEpharmacy } : {}),
      ...(typeof overrides.canViewActivityLog === 'boolean' ? { can_view_activity_log: overrides.canViewActivityLog } : {}),
      ...(typeof overrides.canAdjustStock === 'boolean' ? { can_adjust_stock: overrides.canAdjustStock } : {}),
      ...(typeof overrides.canApprovePurchases === 'boolean' ? { can_approve_purchases: overrides.canApprovePurchases } : {}),
      ...(typeof overrides.canDeleteNhisClaims === 'boolean' ? { can_delete_nhis_claims: overrides.canDeleteNhisClaims } : {}),
      ...(overrides.branchId !== undefined ? { branch_id: overrides.branchId } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  )

  if (syncError) {
    throw syncError
  }

  const { data: syncedProfile, error: syncedProfileError } = await adminClient
    .from('users')
    .select(
      'id, email, full_name, phone, role, assigned_roles, can_refund, can_manage_inventory, can_view_reports, can_manage_claims, can_manage_purchases, can_process_sales, can_manage_patients, can_manage_accounting, can_manage_epharmacy, can_view_activity_log, can_adjust_stock, can_approve_purchases, can_delete_nhis_claims, is_active, organization_id, branch_id'
    )
    .eq('id', authUser.id)
    .single()

  if (syncedProfileError) {
    throw syncedProfileError
  }

  return syncedProfile
}

const validateStaffBranch = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string,
  branchId: string | null
) => {
  if (!branchId) return null

  const { data: branch, error } = await adminClient
    .from('branches')
    .select('id, organization_id, is_active')
    .eq('id', branchId)
    .maybeSingle()

  if (error) throw error
  if (!branch || normalizeText(branch.organization_id) !== organizationId) {
    throw new Error('Select a branch from the staff member organization.')
  }
  if (branch.is_active === false) {
    throw new Error('Select an active branch.')
  }

  return branchId
}

const upsertStaffUser = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  payload: Record<string, unknown>
) => {
  const email = normalizeText(payload.email).toLowerCase()
  const fullName = normalizeText(payload.fullName)
  const phone = normalizeText(payload.phone) || null
  const password = normalizeText(payload.password)
  const roleCandidate = normalizeText(payload.role).toLowerCase()
  const assignedRoles = isValidRole(roleCandidate)
    ? normalizeAssignedRoles(payload.assignedRoles, roleCandidate)
    : []
  const requestedOrganizationId = normalizeText(payload.organizationId)
  const canRefund = typeof payload.canRefund === 'boolean' ? payload.canRefund : undefined
  const canManageInventory = typeof payload.canManageInventory === 'boolean' ? payload.canManageInventory : undefined
  const canViewReports = typeof payload.canViewReports === 'boolean' ? payload.canViewReports : undefined
  const canManageClaims = typeof payload.canManageClaims === 'boolean' ? payload.canManageClaims : undefined
  const canManagePurchases = typeof payload.canManagePurchases === 'boolean' ? payload.canManagePurchases : undefined
  const canProcessSales = typeof payload.canProcessSales === 'boolean' ? payload.canProcessSales : undefined
  const canManagePatients = typeof payload.canManagePatients === 'boolean' ? payload.canManagePatients : undefined
  const canManageAccounting = typeof payload.canManageAccounting === 'boolean' ? payload.canManageAccounting : undefined
  const canManageEpharmacy = typeof payload.canManageEpharmacy === 'boolean' ? payload.canManageEpharmacy : undefined
  const canViewActivityLog = typeof payload.canViewActivityLog === 'boolean' ? payload.canViewActivityLog : undefined
  const canAdjustStock = typeof payload.canAdjustStock === 'boolean' ? payload.canAdjustStock : undefined
  const canApprovePurchases = typeof payload.canApprovePurchases === 'boolean' ? payload.canApprovePurchases : undefined
  const canDeleteNhisClaims = typeof payload.canDeleteNhisClaims === 'boolean' ? payload.canDeleteNhisClaims : undefined
  const requestedBranchId = normalizeText(payload.branchId) || null

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
    throw new Error(staffRoleMessage())
  }

  const organizationId =
    requesterProfile.role === 'super_admin'
      ? requestedOrganizationId
      : requesterProfile.organization_id

  if (!organizationId) {
    throw new Error(
      requesterProfile.role === 'super_admin'
        ? 'Organization id is required when creating staff as a super admin.'
        : 'Admin account is missing organization context.'
    )
  }
  const branchId = await validateStaffBranch(adminClient, organizationId, requestedBranchId)

  const metadata = {
    full_name: fullName,
    phone,
    role: roleCandidate,
  }

  const existingUser = await findAuthUserByEmail(adminClient, email)

  if (existingUser) {
    const { data: existingProfile, error: existingProfileError } = await adminClient
      .from('users')
      .select('id, organization_id')
      .eq('id', existingUser.id)
      .maybeSingle()

    if (existingProfileError) {
      throw existingProfileError
    }

    const existingOrganizationId = normalizeText(existingProfile?.organization_id)
    if (existingOrganizationId && existingOrganizationId !== organizationId) {
      throw new Error('This user already belongs to another organization.')
    }

    if (!existingOrganizationId) {
      await assertOrganizationCanAddUsers(adminClient, organizationId)
    }

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
      assignedRoles,
      isActive: true,
      organizationId,
      canRefund,
      canManageInventory,
      canViewReports,
      canManageClaims,
      canManagePurchases,
      canProcessSales,
      canManagePatients,
      canManageAccounting,
      canManageEpharmacy,
      canViewActivityLog,
      canAdjustStock,
      canApprovePurchases,
      canDeleteNhisClaims,
      branchId,
    })

    return {
      mode: 'updated',
      user: syncedProfile,
    }
  }

  await assertOrganizationCanAddUsers(adminClient, organizationId)

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
    assignedRoles,
    isActive: true,
    organizationId,
    canRefund,
    canManageInventory,
    canViewReports,
    canManageClaims,
    canManagePurchases,
    canProcessSales,
    canManagePatients,
    canManageAccounting,
    canManageEpharmacy,
    canViewActivityLog,
    canAdjustStock,
    canApprovePurchases,
    canDeleteNhisClaims,
    branchId,
  })

  return {
    mode: 'created',
    user: syncedProfile,
  }
}

const setStaffStatus = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  payload: Record<string, unknown>
) => {
  const userId = normalizeText(payload.userId)
  const isActive = Boolean(payload.isActive)

  if (!userId) {
    throw new Error('User id is required.')
  }

  if (!isActive && requesterProfile.id === userId) {
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

  const targetOrganizationId = normalizeText(targetProfile?.organization_id)
  if (!targetProfile || !targetOrganizationId) {
    throw new Error('Target user is missing organization context.')
  }

  if (
    requesterProfile.role !== 'super_admin' &&
    targetOrganizationId !== requesterProfile.organization_id
  ) {
    throw new Error('You can only manage staff accounts in your own organization.')
  }

  const { data, error } = await adminClient.auth.admin.getUserById(userId)
  if (error || !data.user) {
    throw error || new Error('Unable to load the target user.')
  }

  const { data: updatedUserData, error: updateError } = await adminClient.auth.admin.updateUserById(
    userId,
    {
      ban_duration: isActive ? 'none' : DISABLE_DURATION,
    }
  )

  if (updateError) {
    throw updateError
  }

  const syncedProfile = await syncPublicUser(adminClient, updatedUserData.user || data.user, {
    isActive,
    organizationId: targetOrganizationId,
  })

  return {
    user: syncedProfile,
  }
}

const setRefundPermission = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  payload: Record<string, unknown>
) => {
  const userId = normalizeText(payload.userId)
  const canRefund = Boolean(payload.canRefund)

  if (!userId) {
    throw new Error('User id is required.')
  }

  const { data: targetProfile, error: targetProfileError } = await adminClient
    .from('users')
    .select('id, role, organization_id')
    .eq('id', userId)
    .maybeSingle()

  if (targetProfileError) {
    throw targetProfileError
  }

  const targetOrganizationId = normalizeText(targetProfile?.organization_id)
  if (!targetProfile || !targetOrganizationId) {
    throw new Error('Target user is missing organization context.')
  }

  if (
    requesterProfile.role !== 'super_admin' &&
    targetOrganizationId !== requesterProfile.organization_id
  ) {
    throw new Error('You can only manage staff accounts in your own organization.')
  }

  const { data, error } = await adminClient
    .from('users')
    .update({
      can_refund: canRefund,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .eq('organization_id', targetOrganizationId)
    .select('id, email, full_name, phone, role, can_refund, is_active, organization_id')
    .single()

  if (error) {
    throw error
  }

  return {
    user: data,
  }
}

const setStaffBranch = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  payload: Record<string, unknown>
) => {
  const userId = normalizeText(payload.userId)
  const branchId = normalizeText(payload.branchId) || null

  if (!userId) {
    throw new Error('User id is required.')
  }

  const { data: targetProfile, error: targetProfileError } = await adminClient
    .from('users')
    .select('id, organization_id')
    .eq('id', userId)
    .maybeSingle()

  if (targetProfileError) {
    throw targetProfileError
  }

  const targetOrganizationId = normalizeText(targetProfile?.organization_id)
  if (!targetProfile || !targetOrganizationId) {
    throw new Error('Target user is missing organization context.')
  }

  if (
    requesterProfile.role !== 'super_admin' &&
    targetOrganizationId !== requesterProfile.organization_id
  ) {
    throw new Error('You can only manage staff accounts in your own organization.')
  }

  if (branchId) {
    const { data: branch, error: branchError } = await adminClient
      .from('branches')
      .select('id, organization_id, is_active')
      .eq('id', branchId)
      .maybeSingle()

    if (branchError) {
      throw branchError
    }

    if (!branch || normalizeText(branch.organization_id) !== targetOrganizationId) {
      throw new Error('Select a branch from the target user organization.')
    }

    if (branch.is_active === false) {
      throw new Error('Select an active branch.')
    }
  }

  const { data, error } = await adminClient
    .from('users')
    .update({
      branch_id: branchId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .eq('organization_id', targetOrganizationId)
    .select(
      'id, email, full_name, phone, role, can_refund, is_active, organization_id, branch_id, branches (id, name, code)'
    )
    .single()

  if (error) {
    throw error
  }

  return {
    user: data,
  }
}

const updateStaffUser = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  payload: Record<string, unknown>
) => {
  const userId = normalizeText(payload.userId)
  const email = normalizeText(payload.email).toLowerCase()
  const fullName = normalizeText(payload.fullName)
  const roleCandidate = normalizeText(payload.role).toLowerCase()
  const assignedRoles = isValidRole(roleCandidate)
    ? normalizeAssignedRoles(payload.assignedRoles, roleCandidate)
    : []
  const phone = normalizeText(payload.phone) || null
  const isActive =
    typeof payload.isActive === 'boolean' ? Boolean(payload.isActive) : undefined
  const password = normalizeText(payload.password)
  const canRefund = typeof payload.canRefund === 'boolean' ? payload.canRefund : undefined
  const canManageInventory = typeof payload.canManageInventory === 'boolean' ? payload.canManageInventory : undefined
  const canViewReports = typeof payload.canViewReports === 'boolean' ? payload.canViewReports : undefined
  const canManageClaims = typeof payload.canManageClaims === 'boolean' ? payload.canManageClaims : undefined
  const canManagePurchases = typeof payload.canManagePurchases === 'boolean' ? payload.canManagePurchases : undefined
  const canProcessSales = typeof payload.canProcessSales === 'boolean' ? payload.canProcessSales : undefined
  const canManagePatients = typeof payload.canManagePatients === 'boolean' ? payload.canManagePatients : undefined
  const canManageAccounting = typeof payload.canManageAccounting === 'boolean' ? payload.canManageAccounting : undefined
  const canManageEpharmacy = typeof payload.canManageEpharmacy === 'boolean' ? payload.canManageEpharmacy : undefined
  const canViewActivityLog = typeof payload.canViewActivityLog === 'boolean' ? payload.canViewActivityLog : undefined
  const canAdjustStock = typeof payload.canAdjustStock === 'boolean' ? payload.canAdjustStock : undefined
  const canApprovePurchases = typeof payload.canApprovePurchases === 'boolean' ? payload.canApprovePurchases : undefined
  const canDeleteNhisClaims = typeof payload.canDeleteNhisClaims === 'boolean' ? payload.canDeleteNhisClaims : undefined
  const requestedBranchId =
    payload.branchId === null ? null : normalizeText(payload.branchId) || undefined

  if (!userId) {
    throw new Error('User id is required.')
  }

  if (!email) {
    throw new Error('Email is required.')
  }

  if (!fullName) {
    throw new Error('Full name is required.')
  }

  if (!isValidRole(roleCandidate)) {
    throw new Error(staffRoleMessage())
  }
  if (password && password.length < 8) {
    throw new Error('Temporary password must be at least 8 characters.')
  }

  const { data: targetProfile, error: targetProfileError } = await adminClient
    .from('users')
    .select('id, role, organization_id, branch_id')
    .eq('id', userId)
    .maybeSingle()

  if (targetProfileError) {
    throw targetProfileError
  }

  if (!targetProfile) {
    throw new Error('User record not found.')
  }

  const targetOrganizationId = normalizeText(targetProfile.organization_id)
  if (!targetOrganizationId) {
    throw new Error('Target user is missing organization context.')
  }

  if (
    requesterProfile.role !== 'super_admin' &&
    requesterProfile.organization_id !== targetOrganizationId
  ) {
    throw new Error('You can only manage staff accounts in your own organization.')
  }
  if (
    requesterProfile.id === userId &&
    (roleCandidate !== normalizeText(targetProfile.role).toLowerCase() || isActive === false)
  ) {
    throw new Error('You cannot demote or disable your own admin account.')
  }
  const branchId = requestedBranchId === undefined
    ? normalizeText(targetProfile.branch_id) || null
    : await validateStaffBranch(adminClient, targetOrganizationId, requestedBranchId)

  const conflictingAuthUser = await findAuthUserByEmail(adminClient, email)
  if (conflictingAuthUser && conflictingAuthUser.id !== userId) {
    throw new Error('Another auth account already uses this email address.')
  }

  const { data: currentUserData, error: currentUserError } = await adminClient.auth.admin.getUserById(
    userId
  )

  if (currentUserError || !currentUserData.user) {
    throw currentUserError || new Error('Unable to load the target user.')
  }

  const currentUser = currentUserData.user
  const nextIsActive = isActive ?? userIsActive(currentUser)
  const nextPhone =
    phone || normalizeText(currentUser.user_metadata?.phone ?? currentUser.phone) || null

  const authUpdates: Record<string, unknown> = {
    email,
    email_confirm: true,
    ban_duration: nextIsActive ? 'none' : DISABLE_DURATION,
    user_metadata: {
      ...(currentUser.user_metadata || {}),
      full_name: fullName,
      phone: nextPhone,
    },
    app_metadata: {
      ...(currentUser.app_metadata || {}),
      role: roleCandidate,
    },
  }
  if (password) {
    authUpdates.password = password
  }

  const { data: updatedUserData, error: updateError } = await adminClient.auth.admin.updateUserById(
    userId,
    authUpdates
  )

  if (updateError || !updatedUserData.user) {
    throw updateError || new Error('Unable to update the staff user.')
  }

  const syncedProfile = await syncPublicUser(adminClient, updatedUserData.user, {
    fullName,
    phone: nextPhone,
    role: roleCandidate,
    assignedRoles,
    isActive: nextIsActive,
    organizationId: targetOrganizationId,
    canRefund,
    canManageInventory,
    canViewReports,
    canManageClaims,
    canManagePurchases,
    canProcessSales,
    canManagePatients,
    canManageAccounting,
    canManageEpharmacy,
    canViewActivityLog,
    canAdjustStock,
    canApprovePurchases,
    canDeleteNhisClaims,
    branchId,
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
    if (!requesterProfile) {
      return json({ error: 'Unable to determine your staff permissions.' }, 403)
    }

    const payload = (await request.json()) as Record<string, unknown>
    const action = normalizeText(payload.action) as StaffAction

    if (action === 'update_staff_user' || action === 'update_staff_access') {
      if (!requesterHasRole(requesterProfile, ['admin', 'super_admin'])) {
        return json({ error: 'Only admin or super admin users can update staff accounts.' }, 403)
      }

      return json(await updateStaffUser(adminClient, requesterProfile, payload))
    }

    if (!requesterHasRole(requesterProfile, ['admin', 'super_admin'])) {
      return json({ error: 'Only admin or super admin users can manage staff accounts.' }, 403)
    }

    if (requesterProfile.role === 'admin' && !requesterProfile.organization_id) {
      return json({ error: 'Admin account is missing organization context.' }, 400)
    }

    if (action === 'upsert_staff_user') {
      return json(await upsertStaffUser(adminClient, requesterProfile, payload))
    }

    if (action === 'set_staff_status') {
      return json(await setStaffStatus(adminClient, requesterProfile, payload))
    }

    if (action === 'set_refund_permission') {
      return json(await setRefundPermission(adminClient, requesterProfile, payload))
    }

    if (action === 'set_staff_branch') {
      return json(await setStaffBranch(adminClient, requesterProfile, payload))
    }

    return json({ error: 'Unsupported staff action.' }, 400)
  } catch (error) {
    console.error('staff-admin error:', error)
    const message = error instanceof Error ? error.message : 'Unexpected staff admin error.'
    return json({ error: message }, 400)
  }
})
