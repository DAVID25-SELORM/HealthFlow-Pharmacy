import {
  cancelPurchase,
  completePurchase,
  createPurchase,
  createSupplier,
  getAllPurchases,
  getAllSuppliers,
  getPurchaseCompletionDetails,
  getPurchasesStats,
} from './purchasesService'
import {
  getOfflinePurchasesSummary,
  queueOfflinePurchaseDraft,
  subscribeOfflinePurchasesQueue,
  syncOfflinePurchases,
} from './offlinePurchasesQueue'
import {
  getConnectivityState,
  refreshConnectivityState,
} from './connectivityService'

const createClientId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const isNetworkFailure = (error) => {
  const text = [error?.name, error?.message, error?.code]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return (
    text.includes('failed to fetch') ||
    text.includes('failed to send a request') ||
    text.includes('functionsfetcherror') ||
    text.includes('network') ||
    text.includes('aborted') ||
    text.includes('internet') ||
    text.includes('offline')
  )
}

export const listPurchases = async (filters) => getAllPurchases(filters)

export const listSuppliers = async () => getAllSuppliers()

export const getPurchaseStats = async () => getPurchasesStats()

export const getPurchaseCompletionAudit = async (purchase) =>
  getPurchaseCompletionDetails(purchase)

export const createPurchaseSupplier = async (supplier) => createSupplier(supplier)

export const createPurchaseDraft = async (
  purchaseData,
  items,
  context = {}
) => {
  const purchaseId = purchaseData.id || createClientId()
  const draftData = { ...purchaseData, id: purchaseId }
  try {
    return await createPurchase(draftData, items)
  } catch (error) {
    const connectivity = await refreshConnectivityState({ probeLocal: true })
      .catch(() => getConnectivityState())
    if (
      connectivity.branchServerAvailable === false &&
      isNetworkFailure(error)
    ) {
      const queuedDraft = await queueOfflinePurchaseDraft({
        purchaseId,
        purchaseData: draftData,
        items,
        organizationId: context.organizationId,
        branchId: context.branchId || purchaseData.branchId || null,
        createdBy: context.createdBy || null,
      })
      return {
        id: purchaseId,
        offlineQueued: true,
        queueId: queuedDraft.id,
        syncStatus: queuedDraft.status,
      }
    }
    throw error
  }
}

const requireInternet = async (message) => {
  const connectivity = await refreshConnectivityState({ probeLocal: true })
    .catch(() => getConnectivityState())
  if (!connectivity.internetAvailable) throw new Error(message)
}

export const completePurchaseDraft = async (id, options) => {
  await requireInternet(
    'Completing a purchase requires internet because it posts inventory stock.'
  )
  return completePurchase(id, options)
}

export const cancelPurchaseDraft = async (id) => {
  await requireInternet('Cancelling a purchase requires internet and was not queued.')
  return cancelPurchase(id)
}

export {
  getOfflinePurchasesSummary,
  subscribeOfflinePurchasesQueue,
  syncOfflinePurchases,
}
