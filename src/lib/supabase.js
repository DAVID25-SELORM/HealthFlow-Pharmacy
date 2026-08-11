import { createClient } from '@supabase/supabase-js'
import { getErrorMessage, isNetworkRequestError } from '../utils/requestErrors'
import { logRequestFailure } from '../utils/requestDiagnostics'
import { logAuthDiagnostic, timeAuthOperation } from '../utils/authDiagnostics'

// Get environment variables
const normalizeUrl = (url) => String(url || '').trim().replace(/\/+$/, '')

const providerSupabaseUrl = normalizeUrl(import.meta.env.VITE_SUPABASE_URL)
const healthflowCloudUrl = normalizeUrl(import.meta.env.VITE_HEALTHFLOW_CLOUD_URL)
const supabaseUrl = healthflowCloudUrl || providerSupabaseUrl
const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY

const isConfiguredUrl = (url) =>
  Boolean(url) &&
  !url.includes('your_supabase') &&
  url.startsWith('http')

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
  isConfiguredUrl(supabaseUrl) &&
  supabaseKey &&
  !supabaseKey.includes('your_supabase')

const storageKeySourceUrl = isConfiguredUrl(providerSupabaseUrl)
  ? providerSupabaseUrl
  : supabaseUrl

export const getConfiguredCloudUrl = () => supabaseUrl
export const getConfiguredSupabaseKey = () => supabaseKey
export const getConfiguredSupabaseStorageUrl = () => {
  const sourceUrl = isConfiguredUrl(providerSupabaseUrl) ? providerSupabaseUrl : supabaseUrl
  try {
    const url = new URL(sourceUrl)
    if (url.hostname.endsWith('.supabase.co') && !url.hostname.includes('.storage.')) {
      const [projectRef = ''] = url.hostname.split('.')
      if (projectRef) {
        url.hostname = `${projectRef}.storage.supabase.co`
      }
    }
    return normalizeUrl(url.toString())
  } catch {
    return normalizeUrl(sourceUrl)
  }
}

export const supabaseAuthStorageKey = hasValidCredentials
  ? getDefaultStorageKey(storageKeySourceUrl)
  : ''

logAuthDiagnostic('supabase.init', {
  hasUrl: Boolean(supabaseUrl),
  usesHealthFlowGateway: Boolean(healthflowCloudUrl),
  hasPublishableKey: Boolean(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY),
  hasAnonKey: Boolean(import.meta.env.VITE_SUPABASE_ANON_KEY),
  hasValidCredentials: Boolean(hasValidCredentials),
  cloudHost: (() => {
    try {
      return supabaseUrl ? new URL(supabaseUrl).hostname : ''
    } catch {
      return ''
    }
  })(),
})

const SUPABASE_AUTH_EXPIRED_EVENT = 'healthflow:supabase-auth-expired'
let authExpired = false
let refreshSessionPromise = null
let cachedAuthSession = null
let cachedAuthUser = null

const cacheAuthSession = (session) => {
  cachedAuthSession = session?.access_token ? session : null
  cachedAuthUser = cachedAuthSession?.user?.id ? cachedAuthSession.user : null
  return cachedAuthSession
}

export const setCachedSupabaseSession = (session) => cacheAuthSession(session)
export const getCachedSupabaseSession = () => cachedAuthSession
export const setCachedSupabaseUser = (user) => {
  cachedAuthUser = user?.id ? user : null
  return cachedAuthUser
}
export const getCachedSupabaseUser = () => cachedAuthUser

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
  cacheAuthSession(null)
  setCachedSupabaseUser(null)
  dispatchAuthExpired()
}

export const markSupabaseAuthActive = () => {
  authExpired = false
}

export const refreshSupabaseSessionOnce = async () => {
  if (!supabaseClient) {
    return { session: null, error: null }
  }

  if (!refreshSessionPromise) {
    refreshSessionPromise = timeAuthOperation(
      'supabase.auth.refreshSession',
      {},
      () => supabaseClient.auth.refreshSession()
    )
      .then(({ data, error }) => {
        if (error) {
          return { session: null, error }
        }

        if (!data?.session?.access_token) {
          cacheAuthSession(null)
          return { session: null, error: null }
        }

        authExpired = false
        cacheAuthSession(data.session)
        return { session: data.session, error: null }
      })
      .catch((error) => {
        return { session: null, error }
      })
      .finally(() => {
        refreshSessionPromise = null
      })
  }

  return refreshSessionPromise
}

const isRateLimitError = (error) =>
  Number(error?.status || error?.statusCode || 0) === 429

const refreshSessionOnce = async () => {
  const { session, error } = await refreshSupabaseSessionOnce()

  if (!session?.access_token) {
    if (!isRateLimitError(error)) {
      markAuthExpired()
    }
    return null
  }

  return session
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
        detectSessionInUrl: true,
        flowType: 'pkce',
        storageKey: supabaseAuthStorageKey,
      },
      global: {
        fetch: authRetryFetch,
      },
    }))
  : null

export const clearSupabaseStoredSession = () => {
  cacheAuthSession(null)
  setCachedSupabaseUser(null)

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
      console.warn('Unable to clear stored HealthFlow Cloud session key:', key, error)
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

const invokeFunctionWithToken = async (name, options, accessToken) => {
  const body = options?.body && typeof options.body === 'object' ? options.body : {}
  const diagnostics = {
    functionName: name,
    action: body.action,
    activeRole: body.activeRole,
    organizationId: body.organizationId || body.organization_id,
    branchId: body.branchId || body.branch_id,
  }

  try {
    return await timeAuthOperation('supabase.function.invoke', diagnostics, () =>
      supabase.functions.invoke(name, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${accessToken}`,
        },
      })
    )
  } catch (error) {
    return {
      data: null,
      error: isNetworkRequestError(error)
        ? new Error(`Unable to reach the HealthFlow Cloud service "${name}". Check internet access and cloud configuration, then try again.`)
        : error,
    }
  }
}

const PUBLIC_FUNCTION_ACTIONS = {
  'tenant-signup': new Set(['check_subdomain', 'register_signup']),
}

const assertPublicFunctionAllowed = (name, options = {}) => {
  const action = options?.body && typeof options.body === 'object' ? options.body.action : ''
  const allowedActions = PUBLIC_FUNCTION_ACTIONS[name]

  if (!allowedActions?.has(action)) {
    throw new Error(`HealthFlow Cloud service "${name}" does not allow anonymous access for this action.`)
  }
}

const isUnauthorizedFunctionError = (error) =>
  error?.name === 'FunctionsHttpError' && Number(error?.context?.status || 0) === 401

const getFunctionErrorMessage = async (error) => {
  const response = error?.context
  if (!response || typeof response.clone !== 'function') {
    return null
  }

  try {
    const cloned = response.clone()
    const contentType = String(cloned.headers.get('Content-Type') || '').toLowerCase()
    const status = Number(cloned.status || error?.status || error?.statusCode || 0)

    if (contentType.includes('application/json')) {
      const body = await cloned.json()
      return {
        message: getErrorMessage(body, ''),
        status,
        body,
      }
    }

    return {
      message: (await cloned.text()) || '',
      status,
      body: null,
    }
  } catch {
    return null
  }
}

const getCurrentAuthSession = async () => {
  if (cachedAuthSession?.access_token && !isExpiredSession(cachedAuthSession, FUNCTION_TOKEN_REFRESH_WINDOW_SECONDS)) {
    return cachedAuthSession
  }

  const {
    data: { session },
    error: sessionError,
  } = await timeAuthOperation('supabase.auth.getSession', {}, () => supabase.auth.getSession())

  if (sessionError) {
    throw sessionError
  }

  return cacheAuthSession(session) || null
}

const refreshFunctionSession = async (fallbackSession = null) => {
  const { session, error } = await refreshSupabaseSessionOnce()
  if (session?.access_token) {
    return session
  }

  if (!error) {
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
  const session = forceRefresh ? await getCurrentAuthSession() : cachedAuthSession || await getCurrentAuthSession()

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
    throw new Error('HealthFlow Cloud credentials are not configured.')
  }

  const session = await getValidUserSession()
  if (!session?.access_token) {
    return null
  }

  if (cachedAuthUser?.id && session.user?.id === cachedAuthUser.id) {
    return cachedAuthUser
  }

  if (session.user?.id) {
    return setCachedSupabaseUser(session.user)
  }

  let {
    data: { user },
    error,
  } = await timeAuthOperation('supabase.auth.getUser', {}, () => supabase.auth.getUser())

  if (error && isSupabaseAuthFailure(error)) {
    const refreshedSession = await refreshFunctionSession(session).catch(() => null)
    if (!refreshedSession?.access_token) {
      throw error
    }

    const retryResult = await timeAuthOperation('supabase.auth.getUser.retry', {}, () => supabase.auth.getUser())
    user = retryResult.data?.user || null
    error = retryResult.error
  }

  if (error) {
    throw error
  }

  return setCachedSupabaseUser(user) || null
}

const finalizeFunctionResult = async (result) => {
  if (!result.error) {
    return result
  }

  const functionError = await getFunctionErrorMessage(result.error)
  if (functionError?.message) {
    const error = new Error(functionError.message)
    error.status = functionError.status
    error.statusCode = functionError.status
    error.body = functionError.body
    error.details = functionError.body?.details || functionError.body?.received || ''
    error.missingFields = functionError.body?.missingFields || functionError.body?.missing_fields || []
    return {
      ...result,
      error,
    }
  }

  return result
}

export const invokeSupabaseFunction = async (name, options = {}) => {
  if (!supabase) {
    throw new Error('HealthFlow Cloud credentials are not configured.')
  }

  const session = await getValidFunctionSession()
  if (!session?.access_token) {
    throw new Error('Your session has expired. Please sign in again.')
  }

  const startedAt = performance.now()
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

  const finalized = await finalizeFunctionResult(result)
  if (finalized.error) {
    const body = options?.body && typeof options.body === 'object' ? options.body : {}
    logRequestFailure(`edge-function:${name}`, finalized.error, {
      endpoint: `/functions/v1/${name}`,
      method: 'POST',
      organizationId: body.organizationId || body.organization_id || null,
      branchId: body.branchId || body.branch_id || null,
      durationMs: performance.now() - startedAt,
    })
  }
  return finalized
}

// For calls that must work before a user has a session at all (e.g. subdomain
// availability checks and account registration during signup). The target
// action must not require caller identity -- it must authorize itself using
// the service-role key server-side instead of trusting the caller's JWT.
export const invokeSupabaseFunctionPublic = async (name, options = {}) => {
  if (!supabase) {
    throw new Error('HealthFlow Cloud credentials are not configured.')
  }

  assertPublicFunctionAllowed(name, options)

  const result = await invokeFunctionWithToken(name, options, supabaseKey)
  return finalizeFunctionResult(result)
}

export const invokeSupabaseFunctionResponse = async (name, options = {}) => {
  if (!supabase) {
    throw new Error('HealthFlow Cloud credentials are not configured.')
  }

  const createRequest = (accessToken) => {
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    }

    const init = {
      method: options.method || 'POST',
      headers,
    }

    if (options.body !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json'
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    }

    return fetch(`${supabaseUrl}/functions/v1/${name}`, init)
  }

  const session = await getValidFunctionSession()
  if (!session?.access_token) {
    throw new Error('Your session has expired. Please sign in again.')
  }

  let response = await createRequest(session.access_token)
  if (response.status === 401) {
    const refreshedSession = await getValidFunctionSession(true).catch(() => null)
    if (!refreshedSession?.access_token) {
      throw new Error('Your session has expired. Please sign in again.')
    }
    response = await createRequest(refreshedSession.access_token)
  }

  if (!response.ok) {
    let message = ''
    try {
      const contentType = String(response.headers.get('Content-Type') || '').toLowerCase()
      if (contentType.includes('application/json')) {
        const body = await response.clone().json()
        message = body?.error || body?.message || ''
      } else {
        message = await response.clone().text()
      }
    } catch {
      message = ''
    }

    const error = new Error(message || `HealthFlow Cloud service "${name}" failed with status ${response.status}.`)
    error.status = response.status
    error.statusCode = response.status
    throw error
  }

  return response
}

// Warning message in development
if (!hasValidCredentials && import.meta.env.DEV) {
  console.warn(
    'HealthFlow Cloud credentials not configured. Using sample data. Update your .env file to enable cloud features.'
  )
}

// Helper function to check if Supabase is configured
export const isSupabaseConfigured = () => {
  return supabase !== null
}
