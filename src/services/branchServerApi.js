const DEFAULT_BRANCH_SERVER_URL = 'http://localhost:4780'
const RUNTIME_CONFIG_KEY = 'healthflow.branchServer.config.v1'

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
  const runtimeConfig = readRuntimeConfig()
  return {
    enabled:
      runtimeConfig.enabled === true ||
      String(import.meta.env.VITE_BRANCH_SERVER_ENABLED || '').toLowerCase() === 'true',
    url: String(
      runtimeConfig.url || import.meta.env.VITE_BRANCH_SERVER_URL || DEFAULT_BRANCH_SERVER_URL
    ).replace(/\/+$/, ''),
    token: String(runtimeConfig.token || import.meta.env.VITE_BRANCH_SERVER_TOKEN || ''),
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
  }
}

export const runBranchSync = async () =>
  await branchFetch('/api/sync/run', {
    method: 'POST',
  })

export const pullBranchInventory = async () =>
  await branchFetch('/api/sync/pull-inventory', {
    method: 'POST',
  })
