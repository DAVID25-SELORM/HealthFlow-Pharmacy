import { shouldPreferLocalApi } from './connectivityService'
import { isNetworkRequestError } from '../utils/requestErrors'
import { isGhanaCardNumber, normalizeNhiaMemberNumber } from '../utils/nhiaMemberNumber'
import { supabase } from '../lib/supabase'
import { getStoredActiveRole } from '../utils/activeRole'

const DEFAULT_BRANCH_SERVER_URL = 'http://localhost:4780'
const RUNTIME_CONFIG_KEY = 'healthflow.branchServer.config.v1'
const WORKSTATION_ID_KEY = 'healthflow.workstation.id'
const WORKSTATION_SECRET_KEY = 'healthflow.workstation.secret'
export const BRANCH_TOKEN_STORAGE_KEY = 'healthflow_branch_token'
export const BRANCH_USER_SESSION_STORAGE_KEY = 'healthflow_branch_user_session'
const DEFAULT_BRANCH_REQUEST_TIMEOUT_MS = 1500
const SEARCH_BRANCH_REQUEST_TIMEOUT_MS = 450
const WRITE_BRANCH_REQUEST_TIMEOUT_MS = 8000
const LONG_BRANCH_REQUEST_TIMEOUT_MS = 60000

const captureWorkstationEnrollment = () => {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const id = url.searchParams.get('workstationId') || ''
  const secret = url.searchParams.get('workstationSecret') || ''
  if (!id || !secret) return
  window.localStorage.setItem(WORKSTATION_ID_KEY, id)
  window.localStorage.setItem(WORKSTATION_SECRET_KEY, secret)
  url.searchParams.delete('workstationId')
  url.searchParams.delete('workstationSecret')
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`)
}

captureWorkstationEnrollment()

const readHostedConfig = () => {
  if (typeof window === 'undefined') {
    return {}
  }

  return window.__HEALTHFLOW_BRANCH_SERVER__ || {}
}

const readRuntimeConfig = () => {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    return JSON.parse(window.localStorage.getItem(RUNTIME_CONFIG_KEY) || '{}')
  } catch {
    return {}
  }
}

export const getSavedBranchToken = () => {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(BRANCH_TOKEN_STORAGE_KEY) || ''
}

export const saveBranchToken = (token) => {
  if (typeof window === 'undefined') {
    return ''
  }

  const normalizedToken = String(token || '').trim()
  if (normalizedToken) {
    window.localStorage.setItem(BRANCH_TOKEN_STORAGE_KEY, normalizedToken)
  } else {
    window.localStorage.removeItem(BRANCH_TOKEN_STORAGE_KEY)
  }

  return normalizedToken
}

export const getBranchServerConfig = () => {
  const hostedConfig = readHostedConfig()
  const runtimeConfig = readRuntimeConfig()
  const browserToken = getSavedBranchToken()
  const token = String(browserToken || runtimeConfig.token || hostedConfig.token || '')
  const hostedUrl =
    hostedConfig.enabled === true && typeof window !== 'undefined' ? window.location.origin : ''
  const enabledByHostedConfig = hostedConfig.enabled === true
  const enabledByRuntimeConfig = runtimeConfig.enabled === true && Boolean(token)
  const enabledByBrowserToken = Boolean(browserToken)
  const enabledByBuildConfig =
    String(import.meta.env.VITE_BRANCH_SERVER_ENABLED || '').toLowerCase() === 'true' &&
    Boolean(token)

  return {
    enabled: enabledByHostedConfig || enabledByRuntimeConfig || enabledByBrowserToken || enabledByBuildConfig,
    url: String(
      runtimeConfig.url ||
        hostedConfig.url ||
        hostedUrl ||
        import.meta.env.VITE_BRANCH_SERVER_URL ||
        DEFAULT_BRANCH_SERVER_URL
    ).replace(/\/+$/, ''),
    token,
    organizationId: String(runtimeConfig.organizationId || hostedConfig.organizationId || ''),
    branchId: String(runtimeConfig.branchId || hostedConfig.branchId || ''),
    runtimeConfigured: Boolean(runtimeConfig.url && token),
    cookieAuthenticated: hostedConfig.enabled === true && !token,
  }
}

export const saveBranchServerConfig = ({ enabled = true, url, token }) => {
  if (typeof window === 'undefined') {
    return getBranchServerConfig()
  }

  const config = {
    enabled: Boolean(enabled),
    url: String(url || DEFAULT_BRANCH_SERVER_URL).replace(/\/+$/, ''),
    token: String(token || ''),
  }

  window.localStorage.setItem(RUNTIME_CONFIG_KEY, JSON.stringify(config))
  return getBranchServerConfig()
}

export const getBranchServerUrl = () => getBranchServerConfig().url

const getBranchServerToken = () => getBranchServerConfig().token

const getBranchRequestToken = () => {
  if (typeof window === 'undefined') {
    return getBranchServerToken()
  }

  return window.localStorage.getItem(BRANCH_TOKEN_STORAGE_KEY) || getBranchServerToken()
}

const getBranchApiHeaders = (headers = {}) => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  ...headers,
  'x-branch-token': getBranchRequestToken(),
  ...(typeof window !== 'undefined' && window.localStorage.getItem(WORKSTATION_ID_KEY)
    ? {
        'x-healthflow-workstation-id': window.localStorage.getItem(WORKSTATION_ID_KEY),
        'x-healthflow-workstation-secret': window.localStorage.getItem(WORKSTATION_SECRET_KEY) || '',
      }
    : {}),
})

const readBranchUserSession = () => {
  if (typeof window === 'undefined') return null
  try {
    const value = JSON.parse(window.localStorage.getItem(BRANCH_USER_SESSION_STORAGE_KEY) || 'null')
    if (
      !value?.token ||
      value.role !== getStoredActiveRole() ||
      Number(value.expiresAt || 0) <= Math.floor(Date.now() / 1000) + 30
    ) {
      return null
    }
    return value
  } catch {
    return null
  }
}

export const getSavedOfflineStaffSession = () => {
  const session = readBranchUserSession()
  return session?.offline ? session : null
}

export const clearSavedBranchUserSession = () => {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(BRANCH_USER_SESSION_STORAGE_KEY)
  }
}

const getCurrentSupabaseSession = async () => {
  if (!supabase) {
    throw new Error('A verified staff session is required for local NHIS changes.')
  }
  const { data, error } = await supabase.auth.getSession()
  if (error || !data?.session?.access_token || !data.session.user?.id) {
    throw new Error('Your staff session has expired. Sign in again before changing NHIS records.')
  }
  return data.session
}

const requestBranchUserSession = async (session = null) => {
  const currentSession = session || await getCurrentSupabaseSession()
  const accessToken = currentSession.access_token

  const response = await fetchWithTimeout(`${getBranchServerUrl()}/api/auth/user-session`, {
    method: 'POST',
    headers: getBranchApiHeaders({
      Authorization: `Bearer ${accessToken}`,
    }),
    body: JSON.stringify({ activeRole: getStoredActiveRole() }),
  }, WRITE_BRANCH_REQUEST_TIMEOUT_MS)
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body?.data?.token) {
    throw new Error(body?.error || 'Unable to verify this staff member with the branch server.')
  }

  window.localStorage.setItem(BRANCH_USER_SESSION_STORAGE_KEY, JSON.stringify(body.data))
  return body.data
}

const getVerifiedBranchUserSession = async () => {
  const savedSession = readBranchUserSession()
  if (savedSession) return savedSession
  const currentSession = await getCurrentSupabaseSession()
  return await requestBranchUserSession(currentSession)
}

const getNhiaLookupMemberNumber = (payload = {}) =>
  normalizeNhiaMemberNumber(
    payload.memberNumber ||
      payload.memberNo ||
      payload.member_no ||
      payload.nhisNumber ||
      payload.nhis_number ||
      payload.insuranceId ||
      payload.insurance_id ||
      payload.cardNumber ||
      payload.card_number ||
      ''
  )

export const getNhiaLookupCardType = (memberNumber = '') =>
  isGhanaCardNumber(memberNumber) ? 'GHANACARD' : 'NHISCARD'

export const normalizeNhiaMemberLookupPayload = (payload = {}) => {
  const memberNumber = getNhiaLookupMemberNumber(payload)
  const explicitCardType = String(payload.cardType || payload.card_type || '').trim().toUpperCase()
  return {
    memberNumber,
    cardType: explicitCardType || (memberNumber ? getNhiaLookupCardType(memberNumber) : ''),
  }
}

export const isBranchServerEnabled = () =>
  Boolean(
    getBranchServerConfig().enabled &&
    getBranchServerUrl() &&
    (getBranchServerToken() || getBranchServerConfig().cookieAuthenticated)
  )

const fetchWithTimeout = async (url, options = {}, timeoutMs = DEFAULT_BRANCH_REQUEST_TIMEOUT_MS) => {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
    })
  } catch (error) {
    if (isNetworkRequestError(error)) {
      throw new Error(`Unable to reach local branch server at ${url}. Start the branch server and confirm the local server URL.`)
    }
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

const branchFetch = async (path, options = {}) => {
  if (!isBranchServerEnabled()) {
    throw new Error('Local branch server mode is not enabled.')
  }

  const {
    timeoutMs = DEFAULT_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession = true,
    ...fetchOptions
  } = options
  const userSession = requireUserSession ? await getVerifiedBranchUserSession() : null
  const response = await fetchWithTimeout(`${getBranchServerUrl()}${path}`, {
    ...fetchOptions,
    headers: getBranchApiHeaders({
      ...(fetchOptions.headers || {}),
      ...(userSession?.token ? { 'x-branch-user-session': userSession.token } : {}),
    }),
  }, timeoutMs)

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(body?.error || 'Local branch server request failed.'), {
      status: response.status,
      endpoint: path,
      body,
    })
  }

  return body
}

export const getBranchServerHealth = async (timeoutMs = DEFAULT_BRANCH_REQUEST_TIMEOUT_MS) =>
  await fetchWithTimeout(`${getBranchServerUrl()}/health`, {
    headers: {
      Accept: 'application/json',
      'x-branch-token': getBranchRequestToken(),
    },
  }, timeoutMs).then(async (response) => {
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(body?.error || 'Local branch server health check failed.')
    }

    return body
  })

export const getBranchUpdateStatus = async () => {
  const response = await branchFetch('/api/updates/status')
  return response.data || response
}

export const checkBranchServerUpdates = async () => {
  const response = await branchFetch('/api/updates/check', {
    method: 'POST',
    body: JSON.stringify({}),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || response
}

export const installBranchServerUpdate = async () => {
  const response = await branchFetch('/api/updates/install', {
    method: 'POST',
    body: JSON.stringify({}),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || response
}

const UPDATE_TERMINAL_STATES = new Set(['installed', 'rolled_back', 'failed'])

export const waitForBranchUpdateCompletion = async ({
  expectedVersion = '',
  timeoutMs = 15 * 60 * 1000,
  pollIntervalMs = 2000,
  onStatus = () => {},
} = {}) => {
  const deadline = Date.now() + timeoutMs
  let lastStatus = null
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const status = await getBranchUpdateStatus()
      lastStatus = status
      lastError = null
      onStatus(status)

      const state = String(status?.state || '').toLowerCase()
      if (UPDATE_TERMINAL_STATES.has(state)) {
        if (state !== 'installed') {
          throw new Error(status?.message || `Branch update ended in state: ${state}.`)
        }
        if (expectedVersion && String(status?.currentVersion || '') !== String(expectedVersion)) {
          throw new Error(
            `Branch server restarted on version ${status?.currentVersion || 'unknown'}; expected ${expectedVersion}.`
          )
        }
        return status
      }
    } catch (error) {
      if (UPDATE_TERMINAL_STATES.has(String(lastStatus?.state || '').toLowerCase())) {
        throw error
      }
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  throw new Error(
    lastError?.message ||
      lastStatus?.message ||
      'Timed out waiting for the branch update to complete.'
  )
}

export const signInToBranchOffline = async ({ email, pin, activeRole = '' }) => {
  const response = await branchFetch('/api/auth/offline-login', {
    method: 'POST',
    requireUserSession: false,
    body: JSON.stringify({ email, pin, activeRole }),
  })
  if (!response?.data?.token) {
    throw new Error('The branch server did not return an offline staff session.')
  }
  window.localStorage.setItem(BRANCH_USER_SESSION_STORAGE_KEY, JSON.stringify(response.data))
  return response.data
}

export const enrollBranchOfflinePin = async (pin) => {
  const session = await getCurrentSupabaseSession()
  const response = await branchFetch('/api/auth/offline-pin/enroll', {
    method: 'POST',
    requireUserSession: false,
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ pin, activeRole: getStoredActiveRole() }),
  })
  return response.data || response
}

export const listBranchOfflineAccess = async () => {
  const response = await branchFetch('/api/auth/offline-access', {
    requireUserSession: true,
  })
  return response.data || []
}

export const updateBranchOfflineAccess = async (userId, enabled) => {
  const response = await branchFetch(`/api/auth/offline-access/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    requireUserSession: true,
    body: JSON.stringify({ enabled }),
  })
  return response.data || response
}

export const resetBranchOfflinePin = async (userId) => {
  const response = await branchFetch(`/api/auth/offline-access/${encodeURIComponent(userId)}/reset`, {
    method: 'POST',
    requireUserSession: true,
    body: JSON.stringify({}),
  })
  return response.data || response
}

export const listBranchOfflineAuthAudit = async (limit = 100) => {
  const response = await branchFetch(`/api/auth/offline-audit?limit=${encodeURIComponent(limit)}`, {
    requireUserSession: true,
  })
  return response.data || []
}

export const searchBranchInventory = async ({ term = '', limit = 30 } = {}) => {
  const params = new URLSearchParams()
  if (term) {
    params.set('q', term)
  }
  params.set('limit', String(limit))

  const response = await branchFetch(`/api/inventory/search?${params.toString()}`, {
    timeoutMs: SEARCH_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || []
}

export const getBranchInventory = async ({ branchId = '', limit = 5000 } = {}) => {
  const params = new URLSearchParams()
  if (branchId) {
    params.set('branchId', branchId)
  }
  params.set('limit', String(limit))

  const requestedLimit = Number(limit || 0)
  const response = await branchFetch(`/api/inventory?${params.toString()}`, {
    timeoutMs: requestedLimit >= 1000 ? LONG_BRANCH_REQUEST_TIMEOUT_MS : DEFAULT_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || []
}

export const deleteBranchInventoryDrug = async (id) => {
  const response = await branchFetch(`/api/inventory/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    timeoutMs: DEFAULT_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || null
}

export const searchBranchPatients = async ({ term = '', limit = 8 } = {}) => {
  const params = new URLSearchParams()
  if (term) {
    params.set('searchTerm', term)
  }
  params.set('limit', String(limit))

  const response = await branchFetch(`/api/patients?${params.toString()}`, {
    timeoutMs: SEARCH_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || []
}

export const getBranchRecentSales = async (limit = 8) => {
  const params = new URLSearchParams({ limit: String(limit) })
  const response = await branchFetch(`/api/sales/recent?${params.toString()}`)
  return response.data || []
}

export const getBranchSale = async (id) => {
  const response = await branchFetch(`/api/sales/${encodeURIComponent(id)}`)
  return response.data || null
}

export const getBranchPosBootstrap = async ({
  inventoryTerm = '',
  inventoryLimit = 30,
  patientLimit = 25,
  recentLimit = 8,
} = {}) => {
  const params = new URLSearchParams({
    inventoryLimit: String(inventoryLimit),
    patientLimit: String(patientLimit),
    recentLimit: String(recentLimit),
  })
  if (inventoryTerm) {
    params.set('inventoryTerm', inventoryTerm)
  }

  const response = await branchFetch(`/api/pos/bootstrap?${params.toString()}`, {
    timeoutMs: DEFAULT_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || response
}

// ✅ OFFLINE-FIRST PATCH START
export const preloadBranchData = async ({
  patientLimit = 500,
  inventoryLimit = 5000,
  claimLimit = 500,
  purchaseLimit = 500,
  nhisClaimLimit = 500,
  branchId = '',
} = {}) => {
  const params = new URLSearchParams({
    patientLimit: String(patientLimit),
    inventoryLimit: String(inventoryLimit),
    claimLimit: String(claimLimit),
    purchaseLimit: String(purchaseLimit),
    nhisClaimLimit: String(nhisClaimLimit),
  })
  if (branchId) {
    params.set('branchId', branchId)
  }
  const response = await branchFetch(`/api/preload?${params.toString()}`)
  return response.data || response
}
// ✅ OFFLINE-FIRST PATCH END

export const createBranchSale = async (salePayload) => {
  const response = await branchFetch('/api/sales', {
    method: 'POST',
    body: JSON.stringify(salePayload),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
  })

  return {
    sale: response.sale,
    saleNumber: response.saleNumber || response.sale?.saleNumber || response.sale?.sale_number,
    claim: response.claim || null,
    claimNumber: response.claimNumber || response.claim?.claimNumber || response.claim?.claim_number || null,
    nhiaClaim: response.nhiaClaim || null,
    nhiaClaimNumber:
      response.nhiaClaimNumber ||
      response.nhiaClaim?.claimNumber ||
      response.nhiaClaim?.claim_number ||
      null,
  }
}

export const initiateBranchPayment = async (paymentPayload) => {
  const response = await branchFetch('/api/payments/initiate', {
    method: 'POST',
    body: JSON.stringify(paymentPayload),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
  })

  return response.data || null
}

export const getBranchPaymentStatus = async (reference) => {
  const response = await branchFetch(`/api/payments/status/${encodeURIComponent(reference)}`)
  return response.data || null
}

export const runBranchSync = async () =>
  await branchFetch('/api/sync/run', {
    method: 'POST',
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
  })

export const repairBranchSync = async () =>
  await branchFetch('/api/sync/repair', {
    method: 'POST',
    body: JSON.stringify({ limit: 1000 }),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
  })

export const getBranchSyncStatus = async () => await branchFetch('/api/sync/status')

export const getBranchReportBundle = async (filters = {}) => {
  const params = new URLSearchParams()
  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value))
    }
  })

  const response = await branchFetch(`/api/reports/bundle${params.toString() ? `?${params}` : ''}`, {
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || response
}

// ✅ SYNC POST TOKEN FIX START
const getBranchSyncPostHeaders = () => getBranchApiHeaders()
// ✅ SYNC POST TOKEN FIX END

const branchSyncPost = async (path) => {
  return await branchFetch(path, {
    method: 'POST',
    headers: getBranchSyncPostHeaders(),
    body: JSON.stringify({}),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
  })
}

export const pullBranchInventory = async () =>
  await branchSyncPost('/api/sync/pull-inventory')

export const pullBranchReferenceData = async () =>
  await branchSyncPost('/api/sync/pull-reference-data')

export const getBranchDatabaseStatus = async () => {
  const response = await branchFetch('/api/database/status', {
    timeoutMs: DEFAULT_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || response
}

export const getBranchOfflineReadiness = async () => {
  const response = await branchFetch('/api/offline/readiness', {
    timeoutMs: DEFAULT_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || response
}

export const getBranchTlsStatus = async () => {
  const response = await branchFetch('/api/tls/status')
  return response.data || response
}

export const saveBranchTlsSettings = async (settings) => {
  const response = await branchFetch('/api/tls/settings', {
    method: 'PATCH',
    body: JSON.stringify(settings),
  })
  return response.data || response
}

export const getBranchDeploymentStatus = async () => {
  const response = await branchFetch('/api/deployment/status')
  return response.data || response
}

export const applyBranchCloudConfiguration = async (settings) => {
  const response = await branchFetch('/api/deployment/cloud-config', {
    method: 'POST',
    body: JSON.stringify(settings),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || response
}

export const renewBranchTlsCertificate = async () => {
  const response = await branchFetch('/api/deployment/tls/renew', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return response.data || response
}

export const revokeBranchWorkstation = async (id) => {
  const response = await branchFetch(`/api/deployment/workstations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  return response.data || response
}

export const downloadBranchWorkstationBundle = async () => {
  const session = await getVerifiedBranchUserSession()
  const response = await fetchWithTimeout(`${getBranchServerUrl()}/api/deployment/workstation-bundle`, {
    method: 'POST',
    headers: getBranchApiHeaders({
      Accept: 'application/zip',
      'x-branch-user-session': session.token,
    }),
  }, LONG_BRANCH_REQUEST_TIMEOUT_MS)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body?.error || 'Unable to download workstation enrollment bundle.')
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'HealthFlow-Connect-This-Computer.zip'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export const createBranchDatabaseBackup = async (label = 'manual') => {
  const response = await branchFetch('/api/database/backup', {
    method: 'POST',
    body: JSON.stringify({ label }),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || response
}

export const downloadBranchDatabaseBackup = async (fileName) => {
  if (!isBranchServerEnabled()) {
    throw new Error('Local branch server mode is not enabled.')
  }

  const normalizedFileName = String(fileName || '').trim()
  if (!normalizedFileName) {
    throw new Error('Backup file name is required.')
  }

  const response = await fetchWithTimeout(
    `${getBranchServerUrl()}/api/database/backups/${encodeURIComponent(normalizedFileName)}/download`,
    {
      headers: getBranchApiHeaders({
        Accept: 'application/octet-stream',
        'x-branch-user-session': (await getVerifiedBranchUserSession()).token,
      }),
    },
    LONG_BRANCH_REQUEST_TIMEOUT_MS
  )

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body?.error || 'Unable to download backup file.')
  }

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.setAttribute('download', normalizedFileName)
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export const getNhiaSettings = async () => {
  const response = await branchFetch('/api/nhia-config')
  return response.data || null
}

export const saveNhiaSettings = async (settings) => {
  const response = await branchFetch('/api/nhia-config', {
    method: 'POST',
    body: JSON.stringify(settings || {}),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: true,
  })
  return response.data || null
}

export const testNhiaConfiguration = async () => {
  const response = await branchFetch('/api/nhia-config/test', {
    method: 'POST',
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: true,
  })
  return response.data || null
}

export const generateNhiaCcCode = async (claimContext = {}) => {
  const response = await branchFetch('/api/nhia/cc-code', {
    method: 'POST',
    body: JSON.stringify(claimContext || {}),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: true,
  })
  return response.data || null
}

// Member lookup: single call that returns MobCCC (CC code) + member details from NHIA.
// Use this when patient presents their NHIS card — it verifies eligibility and gets the CC code.
// Calls NHIA genCCC API (https://elig.nhia.gov.gh:5000/api/hmis/genCCC).
// Returns MobCCC (CC code) + member name, HIN, DOB, eligibility dates, status.
// cardType: 'NHISCARD' | 'GHANACARD' — detected from memberNumber if omitted.
export const lookupNhiaMember = async (payload = {}) => {
  const { memberNumber, cardType } = normalizeNhiaMemberLookupPayload(payload)
  if (!memberNumber) {
    throw new Error('memberNumber is required.')
  }

  const response = await branchFetch('/api/nhia/member-lookup', {
    method: 'POST',
    body: JSON.stringify({ memberNumber, cardType }),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: true,
  })
  return response.data || null
}

export const getNhiaSummary = async () => await branchFetch('/api/nhia/summary')

export const listNhiaClaims = async (filters = {}) => {
  const params = new URLSearchParams()
  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value))
    }
  })
  const response = await branchFetch(`/api/nhia/claims${params.toString() ? `?${params}` : ''}`)
  return response.data || []
}

export const submitPendingNhiaClaims = async () =>
  await branchFetch('/api/nhia/submit-pending', {
    method: 'POST',
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: true,
  })

export const submitNhiaDirectPayload = async ({
  payload,
  payloadContent = '',
  contentType = 'application/json',
  claimIds = [],
  action = '',
} = {}) => {
  const response = await branchFetch('/api/nhia/direct-submit', {
    method: 'POST',
    body: JSON.stringify({ payload, payloadContent, contentType, claimIds, action }),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: true,
  })
  return response.data || null
}

export const createNhiaBatch = async ({ claimIds = [], exportFormat = 'json' } = {}) => {
  const response = await branchFetch('/api/nhia/batches', {
    method: 'POST',
    body: JSON.stringify({ claimIds, exportFormat }),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: true,
  })
  return response.data || null
}

export const downloadNhiaBatchExport = async (batchId, format = '') => {
  const params = new URLSearchParams()
  if (format) {
    params.set('format', format)
  }

  const response = await fetch(
    `${getBranchServerUrl()}/api/nhia/batches/${batchId}/export${params.toString() ? `?${params}` : ''}`,
    {
      headers: getBranchApiHeaders({
        Accept: '*/*',
      }),
    }
  )
  const content = await response.text()
  if (!response.ok) {
    let body = {}
    try {
      body = JSON.parse(content || '{}')
    } catch {
      body = {}
    }
    throw new Error(body?.error || 'Unable to export NHIA batch.')
  }

  const disposition = response.headers.get('Content-Disposition') || ''
  const fileNameMatch = disposition.match(/filename="([^"]+)"/)
  return {
    content,
    contentType: response.headers.get('Content-Type') || 'application/octet-stream',
    fileName: fileNameMatch?.[1] || `nhia-claim-batch.${format || 'json'}`,
  }
}

export const submitNhisPharmacyClaim = async (claimData = {}) => {
  const response = await branchFetch('/api/nhis/pharmacy-claim', {
    method: 'POST',
    body: JSON.stringify(claimData),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: true,
  })
  return response.data || null
}

export const shouldUseBranchServer = () => {
  // ✅ OFFLINE-FIRST PATCH START
  if (!isBranchServerEnabled()) {
    return false
  }

  return shouldPreferLocalApi()
  // ✅ OFFLINE-FIRST PATCH END
}

export const listBranchRecords = async (resource, filters = {}) => {
  const params = new URLSearchParams()
  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value))
    }
  })

  const query = params.toString()
  const requestedLimit = Number(filters?.limit || 0)
  const timeoutMs = resource === 'nhis/claims' || requestedLimit >= 1000
    ? LONG_BRANCH_REQUEST_TIMEOUT_MS
    : DEFAULT_BRANCH_REQUEST_TIMEOUT_MS
  const response = await branchFetch(`/api/${resource}${query ? `?${query}` : ''}`, { timeoutMs })
  return response.data || []
}

export const createBranchRecord = async (resource, payload) => {
  const response = await branchFetch(`/api/${resource}`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: ['nhis/claims', 'nhis/prescribers', 'nhis/prescribing-facilities'].includes(resource),
  })
  return response.data
}

export const getBranchPosSession = async () => {
  const response = await branchFetch('/api/pos-sessions/current')
  return response.data || null
}

export const openBranchPosSession = async ({ branchId, openingCash = 0 } = {}) => {
  const response = await branchFetch('/api/pos-sessions/open', {
    method: 'POST',
    body: JSON.stringify({ branchId, openingCash }),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || null
}

export const closeBranchPosSession = async ({ id, countedCash = 0, notes = '' } = {}) => {
  const response = await branchFetch(`/api/pos-sessions/${encodeURIComponent(id)}/close`, {
    method: 'POST',
    body: JSON.stringify({ countedCash, notes }),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || null
}

export const updateBranchRecord = async (resource, id, payload) => {
  const response = await branchFetch(`/api/${resource}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload || {}),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: ['nhis/claims', 'nhis/prescribers', 'nhis/prescribing-facilities'].includes(resource),
  })
  return response.data
}

export const updateBranchNhisClaimMedicines = async (id, payload) => {
  const response = await branchFetch(`/api/nhis/claims/${encodeURIComponent(id)}/medicines`, {
    method: 'PUT',
    body: JSON.stringify(payload || {}),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: true,
  })
  return response.data
}

// Admin / claims officer re-opens the dispensary medication edit window for 12 hours.
export const reopenBranchMcaEditWindow = async (id, reason) => {
  const response = await branchFetch(`/api/nhis/claims/${encodeURIComponent(id)}/reopen-mca-edit`, {
    method: 'POST',
    body: JSON.stringify({ reason: String(reason || '').trim() }),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: true,
  })
  return response.data
}

export const deleteBranchRecord = async (resource, id, payload = {}) => {
  const response = await branchFetch(`/api/${resource}/${id}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
    requireUserSession: resource === 'nhis/claims',
  })
  return response.data || null
}
