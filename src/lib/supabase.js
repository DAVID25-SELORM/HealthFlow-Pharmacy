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

// Create Supabase client only if credentials are valid
export const supabase = hasValidCredentials
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: supabaseAuthStorageKey,
      },
    })
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
    return data?.session || fallbackSession || null
  }

  const currentSession = await getCurrentAuthSession().catch(() => null)
  if (currentSession?.access_token) {
    return currentSession
  }

  if (fallbackSession?.access_token) {
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
