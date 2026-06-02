import { shouldPreferLocalApi } from './connectivityService'
import { isNetworkRequestError } from '../utils/requestErrors'

const DEFAULT_BRANCH_SERVER_URL = 'http://localhost:4780'
const RUNTIME_CONFIG_KEY = 'healthflow.branchServer.config.v1'
export const BRANCH_TOKEN_STORAGE_KEY = 'healthflow_branch_token'
export const DEFAULT_BRANCH_TOKEN = 'hf_local_90d8db19-5b4e-4252-ab25-afb6d9f136a6_6e5832df-72b9-4578-a705-e01a6f96c6db'
const DEFAULT_BRANCH_REQUEST_TIMEOUT_MS = 1500
const SEARCH_BRANCH_REQUEST_TIMEOUT_MS = 450
const WRITE_BRANCH_REQUEST_TIMEOUT_MS = 8000
const LONG_BRANCH_REQUEST_TIMEOUT_MS = 60000

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

  const savedToken = window.localStorage.getItem(BRANCH_TOKEN_STORAGE_KEY)
  if (savedToken) {
    return savedToken
  }

  window.localStorage.setItem(BRANCH_TOKEN_STORAGE_KEY, DEFAULT_BRANCH_TOKEN)
  return DEFAULT_BRANCH_TOKEN
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
  const buildToken = String(import.meta.env.VITE_BRANCH_TOKEN || '')
  const token = String(browserToken || buildToken || runtimeConfig.token || hostedConfig.token || '')
  const hostedUrl =
    hostedConfig.enabled === true && typeof window !== 'undefined' ? window.location.origin : ''
  const enabledByHostedConfig = hostedConfig.enabled === true && Boolean(token)
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
    runtimeConfigured: Boolean(runtimeConfig.url && token),
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

const getBranchServerUrl = () => getBranchServerConfig().url

const getBranchServerToken = () => getBranchServerConfig().token

const getBranchRequestToken = () => {
  if (typeof window === 'undefined') {
    return getBranchServerToken()
  }

  return window.localStorage.getItem(BRANCH_TOKEN_STORAGE_KEY) || getSavedBranchToken()
}

const getBranchApiHeaders = (headers = {}) => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  ...headers,
  'x-branch-token': getBranchRequestToken(),
})

export const isBranchServerEnabled = () =>
  Boolean(getBranchServerConfig().enabled && getBranchServerUrl() && getBranchServerToken())

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

  const { timeoutMs = DEFAULT_BRANCH_REQUEST_TIMEOUT_MS, ...fetchOptions } = options
  const response = await fetchWithTimeout(`${getBranchServerUrl()}${path}`, {
    ...fetchOptions,
    headers: getBranchApiHeaders(fetchOptions.headers || {}),
  }, timeoutMs)

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(body?.error || 'Local branch server request failed.'), {
      status: response.status,
      endpoint: path,
    })
  }

  return body
}

export const getBranchServerHealth = async (timeoutMs = DEFAULT_BRANCH_REQUEST_TIMEOUT_MS) =>
  await fetchWithTimeout(`${getBranchServerUrl()}/health`, {
    headers: {
      Accept: 'application/json',
    },
  }, timeoutMs).then(async (response) => {
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(body?.error || 'Local branch server health check failed.')
    }

    return body
  })

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

  const response = await branchFetch(`/api/inventory?${params.toString()}`, {
    timeoutMs: DEFAULT_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || []
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

export const getBranchSyncStatus = async () => await branchFetch('/api/sync/status')

const getBranchSyncPostHeaders = () => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'x-branch-token':
    typeof window === 'undefined'
      ? ''
      : window.localStorage.getItem(BRANCH_TOKEN_STORAGE_KEY) || '',
})

const branchSyncPost = async (path) => {
  if (!isBranchServerEnabled()) {
    throw new Error('Local branch server mode is not enabled.')
  }

  const response = await fetchWithTimeout(`${getBranchServerUrl()}${path}`, {
    method: 'POST',
    headers: getBranchSyncPostHeaders(),
  }, LONG_BRANCH_REQUEST_TIMEOUT_MS)

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(body?.error || 'Local branch server request failed.'), {
      status: response.status,
      endpoint: path,
    })
  }

  return body
}

export const pullBranchInventory = async () =>
  await branchSyncPost('/api/sync/pull-inventory')

export const pullBranchReferenceData = async () =>
  await branchSyncPost('/api/sync/pull-reference-data')

export const getNhiaSettings = async () => {
  const response = await branchFetch('/api/nhia-config')
  return response.data || null
}

export const saveNhiaSettings = async (settings) => {
  const response = await branchFetch('/api/nhia-config', {
    method: 'POST',
    body: JSON.stringify(settings || {}),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || null
}

export const generateNhiaCcCode = async (claimContext = {}) => {
  const response = await branchFetch('/api/nhia/cc-code', {
    method: 'POST',
    body: JSON.stringify(claimContext || {}),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || null
}

// Member lookup: single call that returns MobCCC (CC code) + member details from NHIA.
// Use this when patient presents their NHIS card — it verifies eligibility and gets the CC code.
// Calls NHIA genCCC API (https://elig.nhia.gov.gh:5000/api/hmis/genCCC).
// Returns MobCCC (CC code) + member name, HIN, DOB, eligibility dates, status.
// cardType: 'NHISCARD' | 'GHANACARD' — auto-detected from memberNumber if omitted.
export const lookupNhiaMember = async ({ memberNumber, cardType = '' } = {}) => {
  const response = await branchFetch('/api/nhia/member-lookup', {
    method: 'POST',
    body: JSON.stringify({ memberNumber, cardType }),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
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
  })

export const submitNhiaDirectPayload = async ({ payload, claimIds = [], action = '' } = {}) => {
  const response = await branchFetch('/api/nhia/direct-submit', {
    method: 'POST',
    body: JSON.stringify({ payload, claimIds, action }),
    timeoutMs: LONG_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data || null
}

export const createNhiaBatch = async ({ claimIds = [], exportFormat = 'json' } = {}) => {
  const response = await branchFetch('/api/nhia/batches', {
    method: 'POST',
    body: JSON.stringify({ claimIds, exportFormat }),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
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
  const response = await branchFetch(`/api/${resource}${query ? `?${query}` : ''}`)
  return response.data || []
}

export const createBranchRecord = async (resource, payload) => {
  const response = await branchFetch(`/api/${resource}`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data
}

export const updateBranchRecord = async (resource, id, payload) => {
  const response = await branchFetch(`/api/${resource}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload || {}),
    timeoutMs: WRITE_BRANCH_REQUEST_TIMEOUT_MS,
  })
  return response.data
}
