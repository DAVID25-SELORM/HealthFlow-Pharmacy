import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { clearSupabaseStoredSession, supabase, isSupabaseConfigured } from '../lib/supabase'
import { tryLogAuditEvent } from '../services/auditService'

const AuthContext = createContext(null)
const FALLBACK_ROLE = 'assistant'

const isSupabaseAuthFailure = (error) => {
  const status = Number(error?.status || error?.statusCode || 0)
  const code = String(error?.code || '').toUpperCase()
  const name = String(error?.name || '')
  const message = String(error?.message || '').toLowerCase()

  return (
    status === 401 ||
    code === 'PGRST301' ||
    name === 'AuthApiError' ||
    name === 'AuthSessionMissingError' ||
    message.includes('invalid jwt') ||
    message.includes('jwt expired') ||
    message.includes('session missing') ||
    message.includes('session not found') ||
    message.includes('refresh token') ||
    message.includes('unauthorized')
  )
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

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState(null)
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [organization, setOrganization] = useState(null)
  const [branch, setBranch] = useState(null)
  const [loading, setLoading] = useState(true)
  const sessionRef = useRef(null)

  useEffect(() => {
    let mounted = true
    let handledInvalidSession = false
    let latestResolutionId = 0

    const isCurrentResolution = (resolutionId) =>
      mounted && resolutionId === latestResolutionId

    const setLoadingForCurrentResolution = (resolutionId, value) => {
      if (!isCurrentResolution(resolutionId)) {
        return
      }

      setLoading(value)
    }

    const clearAuthState = (resolutionId) => {
      if (!isCurrentResolution(resolutionId)) {
        return
      }

      sessionRef.current = null
      setSession(null)
      setUser(null)
      setProfile(null)
      setOrganization(null)
      setBranch(null)
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
        const {
          data: { session: storedSession },
          error,
        } = await supabase.auth.getSession()

        if (error) {
          throw error
        }

        return storedSession || null
      } catch (sessionError) {
        if (!isSupabaseAuthFailure(sessionError)) {
          console.warn('Unable to re-check Supabase session:', sessionError)
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

    const resetInvalidSession = async (
      reason,
      resolutionId,
      { preserveExistingSession = true } = {}
    ) => {
      const storedSession = await getStoredSession()
      if (preserveExistingSession && sessionRef.current && storedSession?.access_token) {
        console.warn('Supabase session check failed transiently; keeping current session.', reason)
        keepCurrentAuthState(resolutionId)
        return
      }

      if (handledInvalidSession) {
        clearAuthState(resolutionId)
        return
      }

      handledInvalidSession = true
      console.warn('Clearing invalid Supabase session.', reason)
      clearSupabaseStoredSession()
      clearAuthState(resolutionId)
    }

    const fetchProfile = async (activeUser) => {
      if (!activeUser) {
        return { profile: null, organization: null }
      }

      const { data, error } = await supabase
        .from('users')
        .select(`
          id, 
          email, 
          full_name, 
          role, 
          is_active,
          organization_id,
          branch_id,
          branches (id, name, code, is_main),
          organizations (
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
            license_number
          )
        `)
        .eq('id', activeUser.id)
        .maybeSingle()

      if (error) {
        throw error
      }

      return {
        profile: data,
        organization: data?.organizations || null,
        branch: data?.branches || null,
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

      clearAuthState(resolutionId)
    }

    const resolveSessionState = async (activeSession, options = {}) => {
      const resolutionId = ++latestResolutionId
      const event = options.event || 'UNKNOWN'

      if (!activeSession) {
        await reconcileMissingSession(resolutionId, event)
        return
      }

      handledInvalidSession = false

      let resolvedSession = activeSession
      let activeUser = activeSession?.user ?? null
      let activeProfile = null
      let activeOrganization = null
      let activeBranch = null

      setLoadingForCurrentResolution(resolutionId, true)

      if (activeUser) {
        const {
          data: { user: validatedUser },
          error: validateError,
        } = await supabase.auth.getUser()

        if (validateError && isSupabaseAuthFailure(validateError)) {
          await resetInvalidSession(validateError, resolutionId, {
            preserveExistingSession: event !== 'BOOTSTRAP',
          })
          return
        }

        if (validatedUser) {
          activeUser = validatedUser
          resolvedSession = {
            ...activeSession,
            user: validatedUser,
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
          sessionRef.current = null
          setSession(null)
          setUser(null)
          setProfile(null)
          setOrganization(null)
          setLoading(false)
        }
        return
      }

      const {
        data: { session: activeSession },
      } = await supabase.auth.getSession()

      await resolveSessionState(activeSession, { event: 'BOOTSTRAP' })
    }

    void bootstrap()

    if (!isSupabaseConfigured()) {
      return undefined
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, activeSession) => {
      scheduleAuthResolution(() => {
        void resolveSessionState(activeSession, { event })
      })
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  const signIn = async (email, password) => {
    if (!isSupabaseConfigured()) {
      throw new Error('Supabase credentials are not configured.')
    }

    const normalizedEmail = email.trim()
    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    })

    if (error) {
      throw error
    }

    await tryLogAuditEvent({
      eventType: 'auth',
      entityType: 'session',
      entityId: null,
      action: 'sign_in',
      details: {
        email: data?.user?.email || normalizedEmail,
      },
    })
  }

  const signOut = async () => {
    if (!isSupabaseConfigured()) {
      return
    }

    await tryLogAuditEvent({
      eventType: 'auth',
      entityType: 'session',
      entityId: null,
      action: 'sign_out',
      details: {
        email: user?.email || null,
      },
    })

    const { error } = await supabase.auth.signOut()
    if (error) {
      throw error
    }
  }

  const requestPasswordReset = async (email) => {
    if (!isSupabaseConfigured()) {
      throw new Error('Supabase credentials are not configured.')
    }

    const normalizedEmail = email.trim()
    if (!normalizedEmail) {
      throw new Error('Email is required.')
    }

    const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: `${window.location.origin}/login`,
    })

    if (error) {
      throw error
    }
  }

  const value = useMemo(
    () => ({
      session,
      user,
      profile,
      organization,
      branch,
      loading,
      role: resolveRole(profile, user),
      displayName: resolveDisplayName(profile, user),
      isAuthenticated: Boolean(session),
      signIn,
      signOut,
      requestPasswordReset,
      isConfigured: isSupabaseConfigured(),
    }),
    [session, user, profile, organization, branch, loading]
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
