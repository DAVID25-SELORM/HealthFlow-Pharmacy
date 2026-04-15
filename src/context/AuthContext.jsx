import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

const AuthContext = createContext(null)
const FALLBACK_ROLE = 'assistant'

const isSupabaseAuthFailure = (error) => {
  const status = Number(error?.status || error?.statusCode || 0)
  const code = String(error?.code || '').toUpperCase()
  const name = String(error?.name || '')
  const message = String(error?.message || '').toLowerCase()

  return (
    status === 401 ||
    status === 403 ||
    code === 'PGRST301' ||
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

const resolveRole = (profile, authUser) =>
  profile?.role || authUser?.app_metadata?.role || authUser?.user_metadata?.role || FALLBACK_ROLE

const resolveDisplayName = (profile, authUser) =>
  profile?.full_name || authUser?.user_metadata?.full_name || authUser?.email || 'Authenticated User'

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState(null)
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    const clearAuthState = () => {
      if (!mounted) {
        return
      }

      setSession(null)
      setUser(null)
      setProfile(null)
      setLoading(false)
    }

    const resetInvalidSession = async (reason) => {
      console.warn('Clearing invalid Supabase session.', reason)
      clearAuthState()

      const { error: signOutError } = await supabase.auth.signOut()
      if (signOutError) {
        console.error('Unable to clear invalid session:', signOutError)
      }
    }

    const fetchProfile = async (activeUser) => {
      if (!activeUser) {
        return null
      }

      const { data, error } = await supabase
        .from('users')
        .select('id, email, full_name, role, is_active')
        .eq('id', activeUser.id)
        .maybeSingle()

      if (error) {
        throw error
      }

      return data
    }

    const resolveSessionState = async (activeSession) => {
      let resolvedSession = activeSession
      let activeUser = activeSession?.user ?? null
      let activeProfile = null

      if (mounted) {
        setLoading(true)
      }

      if (activeUser) {
        const {
          data: { user: validatedUser },
          error: validateError,
        } = await supabase.auth.getUser()

        if (validateError && isSupabaseAuthFailure(validateError)) {
          await resetInvalidSession(validateError)
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
          activeProfile = await fetchProfile(activeUser)
        } catch (profileError) {
          if (isSupabaseAuthFailure(profileError)) {
            await resetInvalidSession(profileError)
            return
          }
          console.error('Unable to load user profile:', profileError)
        }
      }

      if (activeUser && activeProfile?.is_active === false) {
        if (mounted) {
          setSession(null)
          setUser(null)
          setProfile(null)
          setLoading(false)
        }

        const { error: signOutError } = await supabase.auth.signOut()
        if (signOutError) {
          console.error('Unable to sign out inactive user:', signOutError)
        }
        return
      }

      if (mounted) {
        setSession(resolvedSession)
        setUser(activeUser)
        setProfile(activeProfile)
        setLoading(false)
      }
    }

    const bootstrap = async () => {
      if (!isSupabaseConfigured()) {
        if (mounted) {
          setSession(null)
          setUser(null)
          setProfile(null)
          setLoading(false)
        }
        return
      }

      const {
        data: { session: activeSession },
      } = await supabase.auth.getSession()

      await resolveSessionState(activeSession)
    }

    void bootstrap()

    if (!isSupabaseConfigured()) {
      return undefined
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, activeSession) => {
      void resolveSessionState(activeSession)
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

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    if (error) {
      throw error
    }
  }

  const signOut = async () => {
    if (!isSupabaseConfigured()) {
      return
    }
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
      loading,
      role: resolveRole(profile, user),
      displayName: resolveDisplayName(profile, user),
      isAuthenticated: Boolean(session),
      signIn,
      signOut,
      requestPasswordReset,
      isConfigured: isSupabaseConfigured(),
    }),
    [session, user, profile, loading]
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
