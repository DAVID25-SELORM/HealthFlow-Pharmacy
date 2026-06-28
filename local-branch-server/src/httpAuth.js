import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { config } from './config.js'

export const BRANCH_AUTH_COOKIE = 'healthflow_branch_session'
const BRANCH_USER_SESSION_TTL_SECONDS = config.offlineSessionHours * 60 * 60

const safeTokenEquals = (actual, expected) => {
  if (!actual || !expected) {
    return false
  }

  const actualBuffer = Buffer.from(String(actual), 'utf8')
  const expectedBuffer = Buffer.from(String(expected), 'utf8')

  if (actualBuffer.length !== expectedBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer)
}

const readCookie = (request, name) => {
  const cookieHeader = String(request.get('Cookie') || '')
  for (const part of cookieHeader.split(';')) {
    const [key, ...valueParts] = part.trim().split('=')
    if (key === name) {
      return decodeURIComponent(valueParts.join('=') || '')
    }
  }
  return ''
}

export const getBranchAuthCookie = () =>
  `${BRANCH_AUTH_COOKIE}=${encodeURIComponent(config.branchServerToken)}; Path=/; HttpOnly; SameSite=Strict`

export const requireBranchToken = (request, response, next) => {
  const token =
    request.get('x-branch-token') ||
    readCookie(request, BRANCH_AUTH_COOKIE) ||
    ''

  if (!safeTokenEquals(token, config.branchServerToken)) {
    response.status(401).json({ error: 'Branch server token is invalid or missing.' })
    return
  }

  next()
}

const encodeSessionPart = (value) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

const signSessionPart = (value) =>
  crypto.createHmac('sha256', config.branchServerToken).update(value).digest('base64url')

const parseSignedSession = (token) => {
  const [payloadPart, signature] = String(token || '').split('.')
  if (!payloadPart || !signature || !safeTokenEquals(signature, signSessionPart(payloadPart))) {
    return null
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
    if (!payload?.userId || Number(payload.expiresAt || 0) <= Math.floor(Date.now() / 1000)) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

const getIdentityClient = () => {
  if (!config.supabaseUrl || !config.supabaseSyncKey) {
    throw new Error('Branch staff authorization requires SUPABASE_URL and SUPABASE_SYNC_KEY.')
  }

  return createClient(config.supabaseUrl, config.supabaseSyncKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

const isMissingUserPrivilegeColumn = (error) => {
  const message = String(error?.message || error?.details || '').toLowerCase()
  const status = Number(error?.status || error?.statusCode || 0)
  return (
    status === 400 ||
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    message.includes('assigned_roles') ||
    message.includes('can_delete_nhis_claims')
  )
}

const getStaffAuthorizationProfile = async (client, userId) => {
  const runQuery = async (columns) =>
    await client
      .from('users')
      .select(columns)
      .eq('id', userId)
      .maybeSingle()

  const result = await runQuery(
    'id, email, full_name, role, assigned_roles, organization_id, branch_id, is_active, can_manage_claims, can_delete_nhis_claims, can_refund, can_manage_purchases, can_approve_purchases, can_view_reports, can_view_activity_log'
  )

  if (!result.error || !isMissingUserPrivilegeColumn(result.error)) {
    return result
  }

  const legacyResult = await runQuery(
    'id, email, full_name, role, organization_id, branch_id, is_active, can_manage_claims'
  )

  return {
    ...legacyResult,
    data: legacyResult.data
      ? {
          ...legacyResult.data,
          assigned_roles: [legacyResult.data.role].filter(Boolean),
          can_delete_nhis_claims: ['admin', 'super_admin'].includes(
            String(legacyResult.data.role || '').trim().toLowerCase()
          ),
        }
      : legacyResult.data,
  }
}

const createBranchUserSession = (profile, activeRole, { offline = false } = {}) => {
  if (!profile || profile.is_active === false) {
    throw new Error('This staff account is disabled or unavailable.')
  }
  if (config.organizationId && profile.organization_id !== config.organizationId) {
    throw new Error('This staff account does not belong to this facility.')
  }
  if (config.branchId && profile.branch_id && profile.branch_id !== config.branchId) {
    throw new Error('This staff account is not assigned to this branch.')
  }

  const primaryRole = String(profile.role || '').trim().toLowerCase()
  const cachedAssignedRoles = Array.isArray(profile.assignedRoles) ? profile.assignedRoles : []
  const assignedRoles = [...new Set([
    primaryRole,
    ...(Array.isArray(profile.assigned_roles) ? profile.assigned_roles : []),
    ...cachedAssignedRoles,
  ].map((role) => String(role || '').trim().toLowerCase()).filter(Boolean))]
  const selectedRole = String(activeRole || primaryRole).trim().toLowerCase()
  if (!assignedRoles.includes(selectedRole)) {
    throw new Error('The selected active role is not assigned to this staff member.')
  }

  const expiresAt = Math.floor(Date.now() / 1000) + BRANCH_USER_SESSION_TTL_SECONDS
  const payload = {
    userId: profile.id,
    organizationId: profile.organization_id || '',
    branchId: profile.branch_id || '',
    role: selectedRole,
    assignedRoles,
    canManageClaims: Boolean(profile.can_manage_claims),
    canDeleteNhisClaims: Boolean(profile.can_delete_nhis_claims),
    offline,
    expiresAt,
  }
  const payloadPart = encodeSessionPart(payload)

  return {
    token: `${payloadPart}.${signSessionPart(payloadPart)}`,
    expiresAt,
    role: selectedRole,
    userId: profile.id,
    offline,
    user: {
      id: profile.id,
      email: profile.email || '',
      fullName: profile.full_name || profile.fullName || profile.email || 'Staff member',
    },
    profile: {
      id: profile.id,
      email: profile.email || '',
      full_name: profile.full_name || profile.fullName || profile.email || 'Staff member',
      role: primaryRole,
      assigned_roles: assignedRoles,
      organization_id: profile.organization_id || profile.organizationId || '',
      branch_id: profile.branch_id || profile.branchId || '',
      is_active: profile.is_active !== false && profile.isActive !== false,
      ...(profile.permissions || {}),
    },
  }
}

export const issueBranchUserSession = async ({ accessToken, activeRole }) => {
  const client = getIdentityClient()
  const { data: userData, error: userError } = await client.auth.getUser(accessToken)
  if (userError || !userData?.user?.id) {
    throw new Error('Unable to verify the signed-in staff member.')
  }

  const { data: profile, error: profileError } = await getStaffAuthorizationProfile(client, userData.user.id)
  if (profileError) throw profileError
  return createBranchUserSession(profile, activeRole)
}

export const issueOfflineBranchUserSession = (profile, activeRole) =>
  createBranchUserSession({
    ...profile,
    ...(profile.permissions || {}),
    organization_id: profile.organizationId,
    branch_id: profile.branchId,
    assigned_roles: profile.assignedRoles,
    is_active: profile.isActive,
  }, activeRole, { offline: true })

export const requireBranchUserSession = (request, response, next) => {
  const session = parseSignedSession(request.get('x-branch-user-session'))
  if (!session) {
    response.status(401).json({ error: 'A verified staff session is required for this action.' })
    return
  }

  request.branchUser = session
  next()
}
