import { createClient } from '@supabase/supabase-js'

// Get environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY

const getDefaultStorageKey = (url) => {
  try {
    const hostname = new URL(url).hostname
    const [projectRef = ''] = hostname.split('.')
    return projectRef ? `sb-${projectRef}-auth-token` : ''
  } catch {
    return ''
  }
}

// Check if credentials are properly configured
const hasValidCredentials =
  supabaseUrl &&
  supabaseKey &&
  !supabaseUrl.includes('your_supabase') &&
  !supabaseKey.includes('your_supabase') &&
  supabaseUrl.startsWith('http')

export const supabaseAuthStorageKey = hasValidCredentials
  ? getDefaultStorageKey(supabaseUrl)
  : ''

const SUPABASE_AUTH_EXPIRED_EVENT = 'healthflow:supabase-auth-expired'
let authExpired = false
let refreshSessionPromise = null

const dispatchAuthExpired = () => {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent(SUPABASE_AUTH_EXPIRED_EVENT))
}

export const subscribeSupabaseAuthExpired = (handler) => {
  if (typeof window === 'undefined') {
    return () => {}
  }

  window.addEventListener(SUPABASE_AUTH_EXPIRED_EVENT, handler)
  return () => window.removeEventListener(SUPABASE_AUTH_EXPIRED_EVENT, handler)
}

let supabaseClient = null

const isSupabaseAuthRequest = (url) => {
  try {
    return new URL(url).pathname.includes('/auth/v1/')
  } catch {
    return false
  }
}

const cloneHeadersWithToken = (headers, accessToken) => {
  const nextHeaders = new Headers(headers || {})
  nextHeaders.set('Authorization', `Bearer ${accessToken}`)
  return nextHeaders
}

const createExpiredAuthResponse = () =>
  new Response(JSON.stringify({ message: 'Your session has expired. Please sign in again.' }), {
    status: 401,
    statusText: 'Unauthorized',
    headers: {
      'Content-Type': 'application/json',
    },
  })

const markAuthExpired = () => {
  authExpired = true
  dispatchAuthExpired()
}

export const markSupabaseAuthActive = () => {
  authExpired = false
}

const refreshSessionOnce = async () => {
  if (!supabaseClient) {
    return null
  }

  if (!refreshSessionPromise) {
    refreshSessionPromise = supabaseClient.auth
      .refreshSession()
      .then(({ data, error }) => {
        if (error || !data?.session?.access_token) {
          markAuthExpired()
          return null
        }

        authExpired = false
        return data.session
      })
      .catch(() => {
        markAuthExpired()
        return null
      })
      .finally(() => {
        refreshSessionPromise = null
      })
  }

  return refreshSessionPromise
}

const authRetryFetch = async (input, init = {}) => {
  const requestUrl = typeof input === 'string' ? input : input?.url
  if (authExpired && !isSupabaseAuthRequest(requestUrl)) {
    return createExpiredAuthResponse()
  }

  const response = await fetch(input, init)

  if (
    response.status !== 401 ||
    !supabaseClient ||
    isSupabaseAuthRequest(requestUrl)
  ) {
    return response
  }

  const refreshedSession = await refreshSessionOnce()
  const accessToken = refreshedSession?.access_token

  if (!accessToken) {
    return createExpiredAuthResponse()
  }

  const retryInit = {
    ...init,
    headers: cloneHeadersWithToken(init.headers || input?.headers, accessToken),
  }

  return await fetch(input, retryInit)
}

// Create Supabase client only if credentials are valid
export const supabase = hasValidCredentials
  ? (supabaseClient = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: supabaseAuthStorageKey,
      },
      global: {
        fetch: authRetryFetch,
      },
    }))
  : null

export const clearSupabaseStoredSession = () => {
  if (typeof window === 'undefined' || !supabaseAuthStorageKey) {
    return
  }

  const keys = [
    supabaseAuthStorageKey,
    `${supabaseAuthStorageKey}-code-verifier`,
    `${supabaseAuthStorageKey}-user`,
  ]

  for (const key of keys) {
    try {
      window.localStorage.removeItem(key)
      window.sessionStorage.removeItem(key)
    } catch (error) {
      console.warn('Unable to clear stored Supabase session key:', key, error)
    }
  }
}

const FUNCTION_TOKEN_REFRESH_WINDOW_SECONDS = 60
const USER_TOKEN_REFRESH_WINDOW_SECONDS = 30

const isExpiredSession = (session, windowSeconds = 0) => {
  const expiresAt = Number(session?.expires_at || 0)
  if (!expiresAt) {
    return false
  }

  return expiresAt - Math.floor(Date.now() / 1000) <= windowSeconds
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
    message.includes('token is expired') ||
    message.includes('session missing') ||
    message.includes('session not found') ||
    message.includes('refresh token') ||
    message.includes('unauthorized')
  )
}

const invokeFunctionWithToken = (name, options, accessToken) =>
  supabase.functions.invoke(name, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    },
  })

const isUnauthorizedFunctionError = (error) =>
  error?.name === 'FunctionsHttpError' && Number(error?.context?.status || 0) === 401

const getFunctionErrorMessage = async (error) => {
  const response = error?.context
  if (!response || typeof response.clone !== 'function') {
    return ''
  }

  try {
    const cloned = response.clone()
    const contentType = String(cloned.headers.get('Content-Type') || '').toLowerCase()

    if (contentType.includes('application/json')) {
      const body = await cloned.json()
      return body?.error || body?.message || ''
    }

    return (await cloned.text()) || ''
  } catch {
    return ''
  }
}

const getCurrentAuthSession = async () => {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession()

  if (sessionError) {
    throw sessionError
  }

  return session || null
}

const refreshFunctionSession = async (fallbackSession = null) => {
  const { data, error } = await supabase.auth.refreshSession()
  if (!error) {
    if (data?.session?.access_token) {
      return data.session
    }

    if (fallbackSession?.access_token && !isExpiredSession(fallbackSession)) {
      return fallbackSession
    }

    return null
  }

  const currentSession = await getCurrentAuthSession().catch(() => null)
  if (currentSession?.access_token && !isExpiredSession(currentSession)) {
    return currentSession
  }

  if (fallbackSession?.access_token && !isExpiredSession(fallbackSession)) {
    return fallbackSession
  }

  throw error
}

const getValidFunctionSession = async (forceRefresh = false) => {
  const session = await getCurrentAuthSession()

  if (forceRefresh) {
    return refreshFunctionSession(session)
  }

  if (!session?.access_token) {
    return null
  }

  const expiresAt = Number(session.expires_at || 0)
  const now = Math.floor(Date.now() / 1000)
  if (expiresAt && expiresAt - now <= FUNCTION_TOKEN_REFRESH_WINDOW_SECONDS) {
    return refreshFunctionSession(session)
  }

  return session
}

const getValidUserSession = async () => {
  const session = await getCurrentAuthSession()
  if (!session?.access_token) {
    return null
  }

  if (isExpiredSession(session, USER_TOKEN_REFRESH_WINDOW_SECONDS)) {
    return refreshFunctionSession(session)
  }

  return session
}

export const getCurrentSupabaseUser = async () => {
  if (!supabase) {
    throw new Error('Supabase credentials are not configured.')
  }

  const session = await getValidUserSession()
  if (!session?.access_token) {
    return null
  }

  let {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error && isSupabaseAuthFailure(error)) {
    const refreshedSession = await refreshFunctionSession(session).catch(() => null)
    if (!refreshedSession?.access_token) {
      throw error
    }

    const retryResult = await supabase.auth.getUser()
    user = retryResult.data?.user || null
    error = retryResult.error
  }

  if (error) {
    throw error
  }

  return user || null
}

export const invokeSupabaseFunction = async (name, options = {}) => {
  if (!supabase) {
    throw new Error('Supabase credentials are not configured.')
  }

  const session = await getValidFunctionSession()
  if (!session?.access_token) {
    throw new Error('Your session has expired. Please sign in again.')
  }

  let result = await invokeFunctionWithToken(name, options, session.access_token)
  if (!result.error) {
    return result
  }

  if (isUnauthorizedFunctionError(result.error)) {
    const refreshedSession = await getValidFunctionSession(true).catch(() => null)
    if (!refreshedSession?.access_token) {
      throw new Error('Your session has expired. Please sign in again.')
    }

    result = await invokeFunctionWithToken(name, options, refreshedSession.access_token)
    if (!result.error) {
      return result
    }

    if (isUnauthorizedFunctionError(result.error)) {
      throw new Error('Your session has expired. Please sign in again.')
    }
  }

  const functionErrorMessage = await getFunctionErrorMessage(result.error)
  if (functionErrorMessage) {
    return {
      ...result,
      error: new Error(functionErrorMessage),
    }
  }

  return result
}

// Warning message in development
if (!hasValidCredentials && import.meta.env.DEV) {
  console.warn(
    'Supabase credentials not configured. Using sample data. Update your .env file to enable database features.'
  )
}

// Helper function to check if Supabase is configured
export const isSupabaseConfigured = () => {
  return supabase !== null
}
