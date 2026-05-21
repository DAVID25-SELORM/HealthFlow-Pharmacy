// ✅ OFFLINE-FIRST PATCH START
const DEFAULT_BRANCH_SERVER_URL = 'http://localhost:4780'
const RUNTIME_CONFIG_KEY = 'healthflow.branchServer.config.v1'

const readHostedConfig = () => {
  if (typeof window === 'undefined') return {} as Record<string, unknown>
  return (window as any).__HEALTHFLOW_BRANCH_SERVER__ || {}
}

const readRuntimeConfig = () => {
  if (typeof window === 'undefined') return {} as Record<string, unknown>
  try {
    return JSON.parse(window.localStorage.getItem(RUNTIME_CONFIG_KEY) || '{}')
  } catch {
    return {}
  }
}

const getConnectivityBranchServerConfig = () => {
  const hostedConfig = readHostedConfig()
  const runtimeConfig = readRuntimeConfig()
  const hostedUrl =
    hostedConfig.enabled === true && typeof window !== 'undefined' ? window.location.origin : ''

  return {
    enabled:
      hostedConfig.enabled === true ||
      runtimeConfig.enabled === true ||
      String((import.meta as any).env?.VITE_BRANCH_SERVER_ENABLED || '').toLowerCase() === 'true',
    url: String(
      runtimeConfig.url ||
        hostedConfig.url ||
        hostedUrl ||
        (import.meta as any).env?.VITE_BRANCH_SERVER_URL ||
        DEFAULT_BRANCH_SERVER_URL
    ).replace(/\/+$/, ''),
    token: String(runtimeConfig.token || hostedConfig.token || ''),
    runtimeConfigured: Boolean(runtimeConfig.url && runtimeConfig.token),
  }
}

const fetchBranchHealth = async (url: string, timeoutMs: number) => {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${url}/health`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error('Local branch server health check failed.')
    }
    return await response.json().catch(() => ({}))
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

export const CONNECTIVITY_MODES = {
  ONLINE_CLOUD: 'ONLINE_CLOUD',
  ONLINE_LOCAL_SYNC: 'ONLINE_LOCAL_SYNC',
  OFFLINE_LOCAL: 'OFFLINE_LOCAL',
  OFFLINE_NO_SERVER: 'OFFLINE_NO_SERVER',
} as const

export type ConnectivityMode = (typeof CONNECTIVITY_MODES)[keyof typeof CONNECTIVITY_MODES]

type ConnectivityState = {
  mode: ConnectivityMode
  internetAvailable: boolean
  branchServerAvailable: boolean
  checkedAt: number
}

const listeners = new Set<(state: ConnectivityState) => void>()
let state: ConnectivityState = {
  mode: CONNECTIVITY_MODES.OFFLINE_NO_SERVER,
  internetAvailable: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  branchServerAvailable: false,
  checkedAt: 0,
}
let refreshPromise: Promise<ConnectivityState> | null = null

const logMode = (nextState: ConnectivityState) => {
  const prefix =
    nextState.mode === CONNECTIVITY_MODES.ONLINE_CLOUD
      ? '[CLOUD]'
      : nextState.mode === CONNECTIVITY_MODES.ONLINE_LOCAL_SYNC
        ? '[SYNC]'
        : nextState.mode === CONNECTIVITY_MODES.OFFLINE_LOCAL
          ? '[LOCAL]'
          : '[OFFLINE]'
  console.info(`${prefix} Connectivity mode: ${nextState.mode}`)
}

const resolveMode = (internetAvailable: boolean, branchServerAvailable: boolean): ConnectivityMode => {
  if (branchServerAvailable && internetAvailable) return CONNECTIVITY_MODES.ONLINE_LOCAL_SYNC
  if (branchServerAvailable) return CONNECTIVITY_MODES.OFFLINE_LOCAL
  if (internetAvailable) return CONNECTIVITY_MODES.ONLINE_CLOUD
  return CONNECTIVITY_MODES.OFFLINE_NO_SERVER
}

const publish = (nextState: ConnectivityState) => {
  const changed = state.mode !== nextState.mode ||
    state.internetAvailable !== nextState.internetAvailable ||
    state.branchServerAvailable !== nextState.branchServerAvailable
  state = nextState
  if (changed) {
    logMode(nextState)
    listeners.forEach((listener) => listener(nextState))
  }
}

export const getConnectivityState = () => state

export const refreshConnectivityState = async ({ timeoutMs = 900 } = {}): Promise<ConnectivityState> => {
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    const internetAvailable = typeof navigator === 'undefined' ? true : navigator.onLine !== false
    const branchConfig = getConnectivityBranchServerConfig()
    let branchServerAvailable = false

    if (branchConfig.enabled && branchConfig.url) {
      try {
        await fetchBranchHealth(branchConfig.url, timeoutMs)
        branchServerAvailable = true
      } catch (error) {
        console.info('[OFFLINE] Local branch server health check failed:', error)
      }
    }

    const nextState = {
      mode: resolveMode(internetAvailable, branchServerAvailable),
      internetAvailable,
      branchServerAvailable,
      checkedAt: Date.now(),
    }
    publish(nextState)
    return nextState
  })().finally(() => {
    refreshPromise = null
  })

  return refreshPromise
}

export const subscribeConnectivity = (listener: (state: ConnectivityState) => void) => {
  listeners.add(listener)
  listener(state)
  return () => listeners.delete(listener)
}

export const shouldPreferLocalApi = () => {
  const branchConfig = getConnectivityBranchServerConfig()
  if (!branchConfig.enabled || !branchConfig.url) return false
  if (state.branchServerAvailable) return true
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  return false
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.info('[SYNC] Browser came online; checking HealthFlow routes.')
    void refreshConnectivityState()
  })
  window.addEventListener('offline', () => {
    console.info('[OFFLINE] Browser went offline; checking local branch server.')
    void refreshConnectivityState()
  })
  void refreshConnectivityState()
}
// ✅ OFFLINE-FIRST PATCH END
