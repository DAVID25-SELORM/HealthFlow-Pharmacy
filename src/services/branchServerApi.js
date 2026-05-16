const DEFAULT_BRANCH_SERVER_URL = 'http://localhost:4780'
const RUNTIME_CONFIG_KEY = 'healthflow.branchServer.config.v1'

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

export const getBranchServerConfig = () => {
  const hostedConfig = readHostedConfig()
  const runtimeConfig = readRuntimeConfig()
  const hostedUrl =
    hostedConfig.enabled === true && typeof window !== 'undefined' ? window.location.origin : ''

  return {
    enabled:
      hostedConfig.enabled === true ||
      runtimeConfig.enabled === true ||
      String(import.meta.env.VITE_BRANCH_SERVER_ENABLED || '').toLowerCase() === 'true',
    url: String(
      runtimeConfig.url ||
        hostedConfig.url ||
        hostedUrl ||
        import.meta.env.VITE_BRANCH_SERVER_URL ||
        DEFAULT_BRANCH_SERVER_URL
    ).replace(/\/+$/, ''),
    token: String(runtimeConfig.token || hostedConfig.token || ''),
    runtimeConfigured: Boolean(runtimeConfig.url && runtimeConfig.token),
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

export const isBranchServerEnabled = () =>
  Boolean(getBranchServerConfig().enabled && getBranchServerUrl() && getBranchServerToken())

const branchFetch = async (path, options = {}) => {
  if (!isBranchServerEnabled()) {
    throw new Error('Local branch server mode is not enabled.')
  }

  const response = await fetch(`${getBranchServerUrl()}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-branch-token': getBranchServerToken(),
      ...(options.headers || {}),
    },
  })

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(body?.error || 'Local branch server request failed.')
  }

  return body
}

export const getBranchServerHealth = async () =>
  await fetch(`${getBranchServerUrl()}/health`, {
    headers: {
      Accept: 'application/json',
    },
  }).then(async (response) => {
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

  const response = await branchFetch(`/api/inventory/search?${params.toString()}`)
  return response.data || []
}

export const createBranchSale = async (salePayload) => {
  const response = await branchFetch('/api/sales', {
    method: 'POST',
    body: JSON.stringify(salePayload),
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
  })

export const getBranchSyncStatus = async () => await branchFetch('/api/sync/status')

export const pullBranchInventory = async () =>
  await branchFetch('/api/sync/pull-inventory', {
    method: 'POST',
  })

export const pullBranchReferenceData = async () =>
  await branchFetch('/api/sync/pull-reference-data', {
    method: 'POST',
  })

export const getNhiaSettings = async () => {
  const response = await branchFetch('/api/nhia/settings')
  return response.data || null
}

export const saveNhiaSettings = async (settings) => {
  const response = await branchFetch('/api/nhia/settings', {
    method: 'PUT',
    body: JSON.stringify(settings || {}),
  })
  return response.data || null
}

export const generateNhiaCcCode = async (claimContext = {}) => {
  const response = await branchFetch('/api/nhia/cc-code', {
    method: 'POST',
    body: JSON.stringify(claimContext || {}),
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
  })

export const submitNhiaDirectPayload = async ({ payload, claimIds = [], action = '' } = {}) => {
  const response = await branchFetch('/api/nhia/direct-submit', {
    method: 'POST',
    body: JSON.stringify({ payload, claimIds, action }),
  })
  return response.data || null
}

export const createNhiaBatch = async ({ claimIds = [], exportFormat = 'json' } = {}) => {
  const response = await branchFetch('/api/nhia/batches', {
    method: 'POST',
    body: JSON.stringify({ claimIds, exportFormat }),
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
      headers: {
        Accept: '*/*',
        'x-branch-token': getBranchServerToken(),
      },
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

export const shouldUseBranchServer = () =>
  isBranchServerEnabled() && typeof navigator !== 'undefined' && navigator.onLine === false

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
  })
  return response.data
}

export const updateBranchRecord = async (resource, id, payload) => {
  const response = await branchFetch(`/api/${resource}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload || {}),
  })
  return response.data
}
