import {
  CONNECTIVITY_MODES,
  getConnectivityState,
  refreshConnectivityState,
  shouldPreferLocalApi,
} from './connectivityService'

// ✅ OFFLINE-FIRST PATCH START
export const API_MODES = CONNECTIVITY_MODES

export const getApiMode = () => getConnectivityState().mode

export const shouldRouteToLocal = async () => {
  await refreshConnectivityState().catch((error) => {
    console.info('[OFFLINE] Unable to refresh connectivity before routing:', error)
  })

  return shouldPreferLocalApi()
}

const isNetworkLikeError = (error: unknown) => {
  const text = [
    (error as any)?.name,
    (error as any)?.message,
    (error as any)?.code,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return (
    text.includes('failed to fetch') ||
    text.includes('network') ||
    text.includes('edge function') ||
    text.includes('aborted') ||
    text.includes('internet') ||
    text.includes('offline')
  )
}

export const routeRead = async <T>({
  label,
  local,
  cloud,
  fallback = [] as T,
}: {
  label: string
  local: () => Promise<T>
  cloud: () => Promise<T>
  fallback?: T
}) => {
  if (await shouldRouteToLocal()) {
    console.info(`[LOCAL] Reading ${label} from local branch server.`)
    return local()
  }

  if (!getConnectivityState().internetAvailable) {
    console.warn(`[OFFLINE] No route available for ${label}.`)
    return fallback
  }

  try {
    console.info(`[CLOUD] Reading ${label} from Supabase.`)
    return await cloud()
  } catch (error) {
    if (isNetworkLikeError(error)) {
      console.warn(`[OFFLINE] Cloud read failed for ${label}; checking fallback route.`, error)
      if (shouldPreferLocalApi()) {
        await refreshConnectivityState({ probeLocal: true }).catch(() => null)
      }
      if (shouldPreferLocalApi()) {
        return local()
      }
      return fallback
    }
    throw error
  }
}

export const routeWrite = async <T>({
  label,
  local,
  cloud,
}: {
  label: string
  local: () => Promise<T>
  cloud: () => Promise<T>
}) => {
  if (await shouldRouteToLocal()) {
    console.info(`[LOCAL] Writing ${label} to local branch server queue.`)
    return local()
  }

  if (!getConnectivityState().internetAvailable) {
    console.warn(`[OFFLINE] Writing ${label} locally because cloud is unavailable.`)
    return local()
  }

  try {
    console.info(`[CLOUD] Writing ${label} to Supabase.`)
    return await cloud()
  } catch (error) {
    if (isNetworkLikeError(error)) {
      console.warn(`[SYNC] Cloud write failed for ${label}; queueing locally.`, error)
      return local()
    }
    throw error
  }
}
// ✅ OFFLINE-FIRST PATCH END
