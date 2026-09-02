import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  clearSupabaseStoredSession,
  supabase,
  isSupabaseConfigured,
  markSupabaseAuthActive,
  refreshSupabaseSessionOnce,
  setCachedSupabaseSession,
  setCachedSupabaseUser,
  subscribeSupabaseAuthExpired,
} from '../lib/supabase'
import { getPasswordRecoveryRedirectUrl } from '../config/appUrl'
import {
  ACCOUNTING_ROLES,
  ACTIVITY_LOG_ROLES,
  CLAIMS_ROLES,
  EPHARMACY_ROLES,
  INVENTORY_ROLES,
  PATIENT_ROLES,
  PURCHASES_ROLES,
  REPORT_ROLES,
  SALES_ROLES,
  hasRole,
  normalizeAssignedRoles,
} from '../utils/roles'
import { storeActiveRole } from '../utils/activeRole'
import {
  clearSavedBranchUserSession,
  getSavedOfflineStaffSession,
  signInToBranchOffline,
} from '../services/branchServerApi'
import { logAuthDiagnostic, timeAuthOperation } from '../utils/authDiagnostics'
import { recordSessionActivity, startSessionIdleMonitor } from '../utils/sessionIdleManager'

const AuthContext = createContext(null)
const FALLBACK_ROLE = 'assistant'
const AUTH_REQUEST_TIMEOUT_MS = 12000
const PROFILE_REQUEST_TIMEOUT_MS = 25000
const AUTH_SERVICE_UNREACHABLE_MESSAGE = 'Unable to reach authentication service. Please try again.'
const PROFILE_SELECT = `
  id,
  email,
  full_name,
  role,
  assigned_roles,
  can_refund,
  can_manage_inventory,
  can_view_reports,
  can_manage_claims,
  can_manage_purchases,
  can_process_sales,
  can_manage_patients,
  can_manage_accounting,
  can_manage_epharmacy,
  can_view_activity_log,
  can_adjust_stock,
  can_approve_purchases,
  can_delete_nhis_claims,
  can_manage_restricted_inventory,
  is_active,
  organization_id,
  branch_id
`
const OPTIONAL_PRIVILEGE_COLUMNS = [
  'can_manage_purchases',
  'can_process_sales',
  'can_manage_patients',
  'can_manage_accounting',
  'can_manage_epharmacy',
  'can_view_activity_log',
  'can_adjust_stock',
  'can_approve_purchases',
  'assigned_roles',
  'can_delete_nhis_claims',
  'can_manage_restricted_inventory',
]
const LEGACY_PROFILE_SELECT = OPTIONAL_PRIVILEGE_COLUMNS.reduce(
  (columns, field) => columns.replace(new RegExp(`\\s*${field},\\s*`), '\n'),
  PROFILE_SELECT
)

const isMissingPrivilegeColumn = (error) => {
  const message = String(error?.message || error?.details || '').toLowerCase()
  const status = Number(error?.status || error?.statusCode || 0)
  return (
    status === 400 ||
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    (OPTIONAL_PRIVILEGE_COLUMNS.some((field) => message.includes(field)) && message.includes('column'))
  )
}

const withTimeout = (promise, label, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new Error(`${label} timed out. Please check your internet connection and try again.`))
    }, timeoutMs)

    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => globalThis.clearTimeout(timeout))
  })

const loadProfileRelations = async (profile) => {
  const [organizationResult, branchResult] = await Promise.allSettled([
    profile?.organization_id
      ? withTimeout(
          supabase
            .from('organizations')
            .select('*')
            .eq('id', profile.organization_id)
            .maybeSingle(),
          'Organization loading',
          PROFILE_REQUEST_TIMEOUT_MS
        )
      : Promise.resolve({ data: null, error: null }),
    profile?.branch_id
      ? withTimeout(
          supabase
            .from('branches')
            .select('id, name, code, is_main')
            .eq('id', profile.branch_id)
            .maybeSingle(),
          'Branch loading',
          PROFILE_REQUEST_TIMEOUT_MS
        )
      : Promise.resolve({ data: null, error: null }),
  ])

  if (organizationResult.status === 'rejected') {
    console.warn('Unable to load user organization:', organizationResult.reason)
  }
  if (branchResult.status === 'rejected') {
    console.warn('Unable to load user branch:', branchResult.reason)
  }

  const organization =
    organizationResult.status === 'fulfilled' && !organizationResult.value?.error
      ? organizationResult.value?.data || null
      : null
  const branch =
    branchResult.status === 'fulfilled' && !branchResult.value?.error
      ? branchResult.value?.data || null
      : null

  return {
    profile: profile ? { ...profile, organizations: organization, branches: branch } : null,
    organization,
    branch,
  }
}

const loadUserProfile = async (userId) => {
  const runQuery = (columns) =>
    withTimeout(
      supabase
        .from('users')
        .select(columns)
        .eq('id', userId)
        .maybeSingle(),
      'User profile loading',
      PROFILE_REQUEST_TIMEOUT_MS
    )

  const result = await runQuery(PROFILE_SELECT)
  if (result.error && isMissingPrivilegeColumn(result.error)) {
    const legacyResult = await runQuery(LEGACY_PROFILE_SELECT)
    if (legacyResult.error) {
      return legacyResult
    }
    return {
      data: await loadProfileRelations(legacyResult.data),
      error: null,
    }
  }

  if (result.error) {
    return result
  }

  return {
    data: await loadProfileRelations(result.data),
    error: null,
  }
}

const isSupabaseAuthFailure = (error) => {
  const status = Number(error?.status || error?.statusCode || 0)
  const code = String(error?.code || '').toUpperCase()
  const name = String(error?.name || '')
  const message = String(error?.message || '').toLowerCase()

  return (
    status === 401 ||
    status === 403 ||
    code === 'PGRST301' ||
    code === 'PGRST303' ||
    name === 'AuthApiError' ||
    name === 'AuthSessionMissingError' ||
    message.includes('invalid jwt') ||
    message.includes('jwt expired') ||
    message.includes('session missing') ||
    message.includes('session not found') ||
    message.includes('refresh token') ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  )
}

const isTransientSupabaseAuthFailure = (error) => {
  const name = String(error?.name || '').toLowerCase()
  const message = String(error?.message || '').toLowerCase()

  return (
    name === 'aborterror' ||
    name === 'navigatorlockacquiretimeouterror' ||
    name === 'authserviceunavailableerror' ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('load failed') ||
    message.includes('timed out') ||
    message.includes('internet connection') ||
    message.includes('cors') ||
    message.includes('navigator lockmanager lock') ||
    message.includes('lockmanager lock') ||
    message.includes('unable to reach authentication service')
  )
}

const wait = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms))

const normalizeTransientAuthError = (error) => {
  if (!isTransientSupabaseAuthFailure(error)) {
    return error
  }

  const normalizedError = new Error(AUTH_SERVICE_UNREACHABLE_MESSAGE)
  normalizedError.cause = error
  normalizedError.name = 'AuthServiceUnavailableError'
  return normalizedError
}

const runAuthOperationWithRetry = async (
  label,
  operation,
  { attempts = 2, retryDelayMs = 800, details = {} } = {}
) => {
  let lastError = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptDetails = { ...details, attempt, attempts }

    try {
      const result = await timeAuthOperation(label, attemptDetails, operation)
      if (result?.error && isTransientSupabaseAuthFailure(result.error)) {
        throw result.error
      }
      return result
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isTransientSupabaseAuthFailure(error)) {
        throw normalizeTransientAuthError(error)
      }

      logAuthDiagnostic(label, {
        event: 'retry',
        retryInMs: retryDelayMs * attempt,
        errorMessage: error?.message || '',
        ...attemptDetails,
      })
      await wait(retryDelayMs * attempt)
    }
  }

  throw normalizeTransientAuthError(lastError)
}

const resolveRole = (profile, authUser) =>
  profile?.role || authUser?.app_metadata?.role || authUser?.user_metadata?.role || FALLBACK_ROLE

const resolveDisplayName = (profile, authUser) =>
  profile?.full_name || authUser?.user_metadata?.full_name || authUser?.email || 'Authenticated User'

const scheduleAuthResolution = (callback) => {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback)
    return
  }

  Promise.resolve().then(callback)
}

const hasPasswordRecoveryHint = () => {
  if (typeof window === 'undefined') {
    return false
  }

  const params = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return (
    params.get('mode') === 'recovery' ||
    hash.get('type') === 'recovery' ||
    (window.location.pathname === '/login' && Boolean(params.get('code')))
  )
}

const isPasswordRecoveryEvent = (event) =>
  event === 'PASSWORD_RECOVERY' || (hasPasswordRecoveryHint() && event === 'BOOTSTRAP')

const getPasswordRecoveryCode = () => {
  if (typeof window === 'undefined') {
    return ''
  }

  const params = new URLSearchParams(window.location.search)
  if (params.get('mode') !== 'recovery') {
    return ''
  }

  return params.get('code') || ''
}

const getPasswordRecoveryTokenHash = () => {
  if (typeof window === 'undefined') {
    return ''
  }

  const params = new URLSearchParams(window.location.search)
  if (params.get('mode') !== 'recovery' || params.get('type') !== 'recovery') {
    return ''
  }

  return params.get('token_hash') || ''
}

const clearPasswordRecoverySecretsFromUrl = () => {
  if (typeof window === 'undefined') {
    return
  }

  const params = new URLSearchParams(window.location.search)
  if (!params.has('code') && !params.has('token_hash') && !params.has('type')) {
    return
  }

  params.delete('code')
  params.delete('token_hash')
  params.delete('type')
  const nextQuery = params.toString()
  window.history.replaceState(
    {},
    '',
    `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash || ''}`
  )
}

const isExpiredSession = (activeSession, windowSeconds = 30) => {
  const expiresAt = Number(activeSession?.expires_at || 0)
  if (!expiresAt) {
    return false
  }

  return expiresAt - Math.floor(Date.now() / 1000) <= windowSeconds
}

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState(null)
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [organization, setOrganization] = useState(null)
  const [branch, setBranch] = useState(null)
  const [activeRole, setActiveRoleState] = useState(FALLBACK_ROLE)
  const [loading, setLoading] = useState(true)
  // Set when a password-recovery link's code can't be exchanged for a session
  // (expired, already used, or opened in a different browser than the one
  // that requested it — PKCE requires the same browser). Login.jsx surfaces
  // this instead of leaving the user stuck on a "still verifying" message
  // that would otherwise never resolve.
  const [passwordRecoveryError, setPasswordRecoveryError] = useState('')
  const sessionRef = useRef(null)
  const signInRequestsRef = useRef(new Map())

  useEffect(() => {
    let mounted = true
    let handledInvalidSession = false
    let latestResolutionId = 0
    // Serialize all Supabase auth operations to prevent concurrent Web Lock
    // contention (the gotrue client uses a single lock per storage key).
    let authOperationQueue = Promise.resolve()
    const enqueueAuth = (fn) => {
      authOperationQueue = authOperationQueue
        .then(() => (mounted ? fn() : undefined))
        .catch(() => {})
      return authOperationQueue
    }

    const isCurrentResolution = (resolutionId) =>
      mounted && resolutionId === latestResolutionId

    const setLoadingForCurrentResolution = (resolutionId, value) => {
      if (!isCurrentResolution(resolutionId)) {
        return
      }

      setLoading(value)
    }

    const restoreOfflineAuth = () => {
      const offlineSession = getSavedOfflineStaffSession()
      if (!offlineSession?.user?.id || !offlineSession?.profile?.id) return false
      setCachedSupabaseSession(null)
      setCachedSupabaseUser(null)
      sessionRef.current = offlineSession
      setSession(offlineSession)
      setUser({
        id: offlineSession.user.id,
        email: offlineSession.user.email,
        user_metadata: { full_name: offlineSession.user.fullName },
      })
      setProfile(offlineSession.profile)
      setOrganization(offlineSession.organization || (
        offlineSession.profile.organization_id
          ? { id: offlineSession.profile.organization_id }
          : null
      ))
      setBranch(offlineSession.branch || (
        offlineSession.profile.branch_id
          ? { id: offlineSession.profile.branch_id }
          : null
      ))
      setActiveRoleState(offlineSession.role || offlineSession.profile.role || FALLBACK_ROLE)
      setLoading(false)
      return true
    }

    const clearAuthState = (resolutionId) => {
      if (!isCurrentResolution(resolutionId)) {
        return
      }

      sessionRef.current = null
      setCachedSupabaseSession(null)
      setCachedSupabaseUser(null)
      setSession(null)
      setUser(null)
      setProfile(null)
      setOrganization(null)
      setBranch(null)
      setActiveRoleState(FALLBACK_ROLE)
      storeActiveRole('')
      setLoading(false)
    }

    const keepCurrentAuthState = (resolutionId) => {
      if (!isCurrentResolution(resolutionId)) {
        return
      }

      setLoading(false)
    }

    const getStoredSession = async () => {
      try {
        const sessionResult = await runAuthOperationWithRetry(
          'auth.getStoredSession',
          () => supabase.auth.getSession(),
          { attempts: 2 }
        )
        const {
          data: { session: storedSession },
          error,
        } = sessionResult

        if (error) {
          throw error
        }

        return storedSession || null
      } catch (sessionError) {
        if (!isSupabaseAuthFailure(sessionError) && !isTransientSupabaseAuthFailure(sessionError)) {
          console.warn('Unable to re-check HealthFlow Cloud session:', sessionError)
        }

        return null
      }
    }

    const recoverStoredSession = async (event) => {
      const storedSession = await getStoredSession()
      if (!storedSession?.access_token) {
        return null
      }

      await resolveSessionState(storedSession, {
        event: `${event || 'UNKNOWN'}_RECOVERED`,
      })

      return storedSession
    }

    const refreshStoredSession = async (fallbackSession = null) => {
      try {
        const { session: refreshedSession, error } = await refreshSupabaseSessionOnce()
        if (error) {
          throw error
        }

        return refreshedSession || null
      } catch (refreshError) {
        const isRateLimit = Number(refreshError?.status || refreshError?.statusCode || 0) === 429
        const isTransient = isTransientSupabaseAuthFailure(refreshError)
        if (!isSupabaseAuthFailure(refreshError) && !isRateLimit && !isTransient) {
          console.warn('Unable to refresh HealthFlow Cloud session:', refreshError)
        }

        // On rate limit, the session may still be valid — return it rather than
        // treating the 429 as an auth failure and wiping the stored session.
        if ((isRateLimit || isTransient) && fallbackSession?.access_token && !isExpiredSession(fallbackSession, 0)) {
          return fallbackSession
        }

        const storedSession = await getStoredSession()
        if (
          storedSession?.access_token &&
          storedSession.access_token !== fallbackSession?.access_token &&
          !isExpiredSession(storedSession, 0)
        ) {
          return storedSession
        }

        return null
      }
    }

    const resetInvalidSession = async (
      reason,
      resolutionId,
      { preserveExistingSession = true } = {}
    ) => {
      const storedSession = await getStoredSession()
      if (preserveExistingSession && sessionRef.current && storedSession?.access_token) {
        console.warn('HealthFlow Cloud session check failed transiently; keeping current session.', reason)
        keepCurrentAuthState(resolutionId)
        return
      }

      if (handledInvalidSession) {
        clearAuthState(resolutionId)
        return
      }

      handledInvalidSession = true
      console.warn('Clearing invalid HealthFlow Cloud session.', reason)
      clearSupabaseStoredSession()
      if (!restoreOfflineAuth()) {
        clearAuthState(resolutionId)
      }
    }

    const fetchProfile = async (activeUser) => {
      if (!activeUser) {
        return { profile: null, organization: null }
      }

      const { data, error } = await loadUserProfile(activeUser.id)

      if (error) {
        throw error
      }

      return {
        profile: data?.profile || null,
        organization: data?.organization || null,
        branch: data?.branch || null,
      }
    }

    const reconcileMissingSession = async (resolutionId, event) => {
      const shouldAttemptRecovery =
        event === 'BOOTSTRAP' ||
        event === 'INITIAL_SESSION' ||
        event === 'SIGNED_OUT' ||
        !sessionRef.current

      if (!shouldAttemptRecovery && event !== 'SIGNED_OUT') {
        keepCurrentAuthState(resolutionId)
        return
      }

      const recoveredSession = await recoverStoredSession(event)
      if (recoveredSession?.access_token) {
        return
      }

      if (event === 'SIGNED_OUT') {
        handledInvalidSession = false
      }

      if (
        event !== 'BOOTSTRAP' &&
        event !== 'INITIAL_SESSION' &&
        event !== 'SIGNED_OUT' &&
        sessionRef.current
      ) {
        keepCurrentAuthState(resolutionId)
        return
      }

      if (!restoreOfflineAuth()) {
        clearAuthState(resolutionId)
      }
    }

    const resolveSessionState = async (activeSession, options = {}) => {
      const resolutionId = ++latestResolutionId
      const event = options.event || 'UNKNOWN'

      if (!activeSession) {
        await reconcileMissingSession(resolutionId, event)
        return
      }

      if (activeSession?.access_token) {
        markSupabaseAuthActive()
      }

      handledInvalidSession = false

      let resolvedSession = activeSession
      let activeUser = activeSession?.user ?? null
      let activeProfile = null
      let activeOrganization = null
      let activeBranch = null
      const isRecoverySession = isPasswordRecoveryEvent(event)
      const hasExistingSession = Boolean(sessionRef.current?.access_token)
      const isSwitchingUsers =
        Boolean(activeUser?.id && sessionRef.current?.user?.id) &&
        activeUser.id !== sessionRef.current.user.id
      const shouldShowBlockingLoading =
        !hasExistingSession || isSwitchingUsers || event === 'BOOTSTRAP'

      if (shouldShowBlockingLoading) {
        setLoadingForCurrentResolution(resolutionId, true)
      }

      if (activeUser && isRecoverySession) {
        if (isCurrentResolution(resolutionId)) {
          sessionRef.current = resolvedSession
          setCachedSupabaseSession(resolvedSession)
          setCachedSupabaseUser(activeUser)
          setSession(resolvedSession)
          setUser(activeUser)
          setProfile(null)
          setOrganization(null)
          setBranch(null)
          setLoading(false)
        }
        return
      }

      if (activeUser) {
        if (isExpiredSession(resolvedSession)) {
          const refreshedSession = await refreshStoredSession(resolvedSession)
          if (refreshedSession?.access_token) {
            resolvedSession = refreshedSession
            activeUser = refreshedSession.user || activeUser
          }
        }

        // Skip the extra getUser() network call for page-load events (BOOTSTRAP /
        // INITIAL_SESSION / *_RECOVERED). The Supabase SDK already validated the
        // session when it fired onAuthStateChange, so a second round-trip just
        // holds the internal Web Lock for an extra 100–500 ms and causes lock
        // contention under React Strict Mode's double-mount.  We still validate
        // server-side for interactive sign-in events and old sessions without
        // expiry metadata so revoked/corrupt tokens are caught promptly.
        const sessionHasExpiry = Boolean(Number(resolvedSession?.expires_at || 0))
        const shouldPreserveOnValidationFailure =
          hasExistingSession && !isSwitchingUsers && event !== 'SIGNED_IN'
        const shouldValidateWithServer = !sessionHasExpiry

        if (shouldValidateWithServer) {
          let validateResult
          try {
            validateResult = await runAuthOperationWithRetry(
              'auth.validateUser',
              () => supabase.auth.getUser(),
              {
                attempts: shouldPreserveOnValidationFailure ? 1 : 2,
                details: { event },
              }
            )
          } catch (validationRequestError) {
            validateResult = {
              data: { user: null },
              error: validationRequestError,
            }
          }
          let {
            data: { user: validatedUser },
            error: validateError,
          } = validateResult

          if (validateError && isSupabaseAuthFailure(validateError)) {
            const refreshedSession = await refreshStoredSession(resolvedSession)
            if (refreshedSession?.access_token) {
              resolvedSession = refreshedSession
              activeUser = refreshedSession.user || activeUser

              let retryResult
              try {
                retryResult = await runAuthOperationWithRetry(
                  'auth.validateUserAfterRefresh',
                  () => supabase.auth.getUser(),
                  { attempts: 2, details: { event } }
                )
              } catch (validationRetryError) {
                retryResult = {
                  data: { user: null },
                  error: validationRetryError,
                }
              }
              validatedUser = retryResult.data?.user || null
              validateError = retryResult.error
            } else {
              await resetInvalidSession(validateError, resolutionId, {
                preserveExistingSession: shouldPreserveOnValidationFailure,
              })
              return
            }
          }

          if (validateError && isSupabaseAuthFailure(validateError)) {
            await resetInvalidSession(validateError, resolutionId, {
              preserveExistingSession: shouldPreserveOnValidationFailure,
            })
            return
          }

          if (validateError && isTransientSupabaseAuthFailure(validateError) && shouldPreserveOnValidationFailure) {
            console.warn('HealthFlow Cloud session validation failed transiently; keeping current session.', validateError)
          } else if (validateError) {
            console.error('Unable to validate HealthFlow Cloud user:', validateError)
          }

          if (!validateError && validatedUser) {
            activeUser = validatedUser
            resolvedSession = {
              ...resolvedSession,
              user: validatedUser,
            }
          }
        }

        try {
          const profileData = await fetchProfile(activeUser)
          activeProfile = profileData.profile
          activeOrganization = profileData.organization
          activeBranch = profileData.branch
        } catch (profileError) {
          if (isSupabaseAuthFailure(profileError)) {
            await resetInvalidSession(profileError, resolutionId, {
              preserveExistingSession: event !== 'BOOTSTRAP',
            })
            return
          }
          console.error('Unable to load user profile:', profileError)
        }
      }

      if (activeUser && activeProfile?.is_active === false) {
        clearAuthState(resolutionId)

        const { error: signOutError } = await supabase.auth.signOut()
        if (signOutError) {
          console.error('Unable to sign out inactive user:', signOutError)
        }
        return
      }

      if (isCurrentResolution(resolutionId)) {
        sessionRef.current = resolvedSession
        setCachedSupabaseSession(resolvedSession)
        setCachedSupabaseUser(activeUser)
        setSession(resolvedSession)
        setUser(activeUser)
        setProfile(activeProfile)
        setOrganization(activeOrganization)
        setBranch(activeBranch)
        setLoading(false)
      }
    }

    const bootstrap = async () => {
      if (!isSupabaseConfigured()) {
        if (mounted) {
          if (!restoreOfflineAuth()) {
            sessionRef.current = null
            setCachedSupabaseSession(null)
            setCachedSupabaseUser(null)
            setSession(null)
            setUser(null)
            setProfile(null)
            setOrganization(null)
            setLoading(false)
          }
        }
        return
      }

      // Token-hash recovery is independent of the browser that requested the
      // email, so staff can open the link on their phone. Normal authentication
      // remains PKCE; this explicit verification is only for recovery links.
      const recoveryTokenHash = getPasswordRecoveryTokenHash()
      if (recoveryTokenHash) {
        clearPasswordRecoverySecretsFromUrl()
        const { data, error } = await supabase.auth.verifyOtp({
          token_hash: recoveryTokenHash,
          type: 'recovery',
        })

        if (error || !data?.session) {
          if (mounted) {
            setPasswordRecoveryError(
              'This password reset link could not be verified. It may have expired or already been used. Request a fresh link below.'
            )
          }
          await resolveSessionState(null, { event: 'BOOTSTRAP' })
          return
        }

        setPasswordRecoveryError('')
        await resolveSessionState(data.session, { event: 'PASSWORD_RECOVERY' })
        return
      }

      // Supabase PKCE initialization owns the one-time code exchange when
      // detectSessionInUrl is enabled. Keep this fallback for recovery emails
      // issued before the browser-independent template was activated.
      const recoveryCode = getPasswordRecoveryCode()
      const hasRecoveryHint = hasPasswordRecoveryHint()
      const activeSession = await getStoredSession()
      if (recoveryCode) {
        clearPasswordRecoverySecretsFromUrl()
      }

      // Some legacy recovery redirects arrive with only the recovery hint by
      // the time this app loads (the SDK has already attempted the exchange).
      // getSession() waits for that SDK initialization, so an absent session
      // here is terminal rather than a state the password form can recover
      // from. Report it explicitly instead of allowing Login to retain the
      // misleading "still being verified" state.
      if (hasRecoveryHint && !activeSession && mounted) {
        setPasswordRecoveryError(
          'This password reset link could not be verified. It may have expired or already been used. Request a fresh link below.'
        )
      }
      await resolveSessionState(activeSession, { event: 'BOOTSTRAP' })
    }

    enqueueAuth(bootstrap)

    if (!isSupabaseConfigured()) {
      return undefined
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, activeSession) => {
      scheduleAuthResolution(() => {
        enqueueAuth(() => resolveSessionState(activeSession, { event }))
      })
    })

    const unsubscribeAuthExpired = subscribeSupabaseAuthExpired(() => {
      enqueueAuth(() => {
        const resolutionId = ++latestResolutionId
        return resetInvalidSession('HealthFlow Cloud session expired.', resolutionId, {
          preserveExistingSession: false,
        })
      })
    })

    return () => {
      mounted = false
      unsubscribeAuthExpired()
      subscription.unsubscribe()
    }
  }, [])

  const signIn = (email, password) => {
    if (!isSupabaseConfigured()) {
      return Promise.reject(new Error('HealthFlow Cloud credentials are not configured.'))
    }

    const normalizedEmail = email.trim()
    const requestKey = `${normalizedEmail.toLowerCase()}\u0000${password}`
    const pendingRequest = signInRequestsRef.current.get(requestKey)
    if (pendingRequest) {
      return pendingRequest
    }

    const request = runAuthOperationWithRetry(
      'auth.signInWithPassword',
      () => supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      }),
      { attempts: 2, details: { emailDomain: normalizedEmail.split('@')[1] || '' } }
    ).then(({ data, error }) => {
      if (error) {
        throw normalizeTransientAuthError(error)
      }
      recordSessionActivity(data?.user?.id)
    })

    const trackedRequest = request.finally(() => {
      signInRequestsRef.current.delete(requestKey)
    })
    signInRequestsRef.current.set(requestKey, trackedRequest)
    return trackedRequest
  }

  const signInOffline = async (email, pin) => {
    const offlineSession = await signInToBranchOffline({
      email: email.trim(),
      pin,
    })
    recordSessionActivity(offlineSession.user.id)
    sessionRef.current = offlineSession
    setCachedSupabaseSession(null)
    setCachedSupabaseUser(null)
    setSession(offlineSession)
    setUser({
      id: offlineSession.user.id,
      email: offlineSession.user.email,
      user_metadata: { full_name: offlineSession.user.fullName },
    })
    setProfile(offlineSession.profile)
    setOrganization(offlineSession.organization || null)
    setBranch(offlineSession.branch || null)
    setActiveRoleState(offlineSession.role || offlineSession.profile.role || FALLBACK_ROLE)
  }

  const signOut = async () => {
    clearSavedBranchUserSession()
    if (session?.offline) {
      sessionRef.current = null
      setCachedSupabaseSession(null)
      setCachedSupabaseUser(null)
      setSession(null)
      setUser(null)
      setProfile(null)
      setOrganization(null)
      setBranch(null)
      return
    }
    if (!isSupabaseConfigured()) {
      return
    }

    const { error } = await withTimeout(
      supabase.auth.signOut(),
      'Sign out',
      AUTH_REQUEST_TIMEOUT_MS
    )
    if (error) {
      throw error
    }
    sessionRef.current = null
    setCachedSupabaseSession(null)
    setCachedSupabaseUser(null)
  }

  useEffect(() => {
    if (!session || !user?.id) return undefined

    return startSessionIdleMonitor({
      userId: user.id,
      onIdle: async () => {
        try {
          await signOut()
        } catch (error) {
          console.warn('Unable to reach the authentication service during inactivity logout.', error)
          clearSavedBranchUserSession()
          clearSupabaseStoredSession()
          sessionRef.current = null
          setCachedSupabaseSession(null)
          setCachedSupabaseUser(null)
          setSession(null)
          setUser(null)
          setProfile(null)
          setOrganization(null)
          setBranch(null)
        }
      },
    })
  }, [session, user?.id])

  const requestPasswordReset = async (email) => {
    if (!isSupabaseConfigured()) {
      throw new Error('HealthFlow Cloud credentials are not configured.')
    }

    const normalizedEmail = email.trim()
    if (!normalizedEmail) {
      throw new Error('Email is required.')
    }

    const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: getPasswordRecoveryRedirectUrl(),
    })

    if (error) {
      throw error
    }
  }

  const updatePassword = async (password) => {
    if (!isSupabaseConfigured()) {
      throw new Error('HealthFlow Cloud credentials are not configured.')
    }

    const { error } = await supabase.auth.updateUser({ password })

    if (error) {
      throw error
    }
  }

  const refreshProfile = async () => {
    if (!user?.id || !isSupabaseConfigured()) {
      return null
    }

    const { data, error } = await loadUserProfile(user.id)

    if (error) {
      throw error
    }

    setProfile(data?.profile || null)
    setOrganization(data?.organization || null)
    setBranch(data?.branch || null)
    return data?.profile || null
  }

  const primaryRole = resolveRole(profile, user)
  const assignedRoles = useMemo(
    () => normalizeAssignedRoles(profile?.assigned_roles, primaryRole),
    [primaryRole, profile?.assigned_roles]
  )

  useEffect(() => {
    const storageKey = user?.id ? `healthflow.active-role.${user.id}` : ''
    const storedRole = storageKey ? window.localStorage.getItem(storageKey) : ''
    setActiveRoleState(
      assignedRoles.includes(storedRole) ? storedRole : assignedRoles[0] || primaryRole
    )
  }, [assignedRoles, primaryRole, user?.id])

  const setActiveRole = (nextRole) => {
    const normalizedRole = String(nextRole || '').trim().toLowerCase()
    if (!assignedRoles.includes(normalizedRole)) {
      throw new Error('You can only switch to a role assigned by an administrator.')
    }

    setActiveRoleState(normalizedRole)
    storeActiveRole(normalizedRole)
    if (user?.id) {
      window.localStorage.setItem(`healthflow.active-role.${user.id}`, normalizedRole)
    }
  }
  const currentRole = assignedRoles.includes(activeRole)
    ? activeRole
    : assignedRoles[0] || primaryRole

  useEffect(() => {
    storeActiveRole(currentRole)
  }, [currentRole])

  const value = useMemo(
    () => ({
      session,
      user,
      profile,
      organization,
      branch,
      loading,
      role: currentRole,
      primaryRole,
      assignedRoles,
      setActiveRole,
      displayName: resolveDisplayName(profile, user),
      isAuthenticated: Boolean(session),
      canManageInventory: hasRole(currentRole, INVENTORY_ROLES) || Boolean(profile?.can_manage_inventory),
      canViewReports: hasRole(currentRole, REPORT_ROLES) || Boolean(profile?.can_view_reports),
      canManageClaims:
        currentRole !== 'assistant' &&
        (hasRole(currentRole, CLAIMS_ROLES) || Boolean(profile?.can_manage_claims)),
      canManagePurchases:
        ['admin', 'super_admin'].includes(currentRole) ||
        (Object.prototype.hasOwnProperty.call(profile || {}, 'can_manage_purchases')
          ? Boolean(profile?.can_manage_purchases)
          : hasRole(currentRole, PURCHASES_ROLES)),
      canProcessSales: hasRole(currentRole, SALES_ROLES) || Boolean(profile?.can_process_sales),
      canManagePatients: hasRole(currentRole, PATIENT_ROLES) || Boolean(profile?.can_manage_patients),
      canManageAccounting: hasRole(currentRole, ACCOUNTING_ROLES) || Boolean(profile?.can_manage_accounting),
      canManageEpharmacy: hasRole(currentRole, EPHARMACY_ROLES) || Boolean(profile?.can_manage_epharmacy),
      canViewActivityLog: hasRole(currentRole, ACTIVITY_LOG_ROLES) || Boolean(profile?.can_view_activity_log),
      canAdjustStock: hasRole(currentRole, INVENTORY_ROLES) || Boolean(profile?.can_adjust_stock),
      canApprovePurchases:
        ['admin', 'super_admin'].includes(currentRole) ||
        Boolean(profile?.can_approve_purchases),
      canDeleteNhisClaims:
        currentRole !== 'assistant' &&
        (
          ['admin', 'super_admin'].includes(currentRole) ||
          Boolean(profile?.can_delete_nhis_claims)
        ),
      canManageRestrictedInventory:
        ['super_admin', 'compliance_admin', 'compliance_officer'].includes(currentRole) ||
        (
          ['admin', 'supervisor'].includes(currentRole) &&
          Boolean(profile?.can_manage_restricted_inventory)
        ),
      signIn,
      signInOffline,
      signOut,
      requestPasswordReset,
      updatePassword,
      refreshProfile,
      isConfigured: isSupabaseConfigured(),
      passwordRecoveryError,
    }),
    [session, user, profile, organization, branch, loading, activeRole, assignedRoles, primaryRole, passwordRecoveryError]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
