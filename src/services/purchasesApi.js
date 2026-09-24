import {
  cancelPurchase,
  completePurchase,
  createPurchase,
  createSupplier,
  getAllPurchases,
  getBranchTransferOptions,
  getPurchaseReceipts,
  getReorderInsights,
  getUserDisplayName,
  placePurchase,
  receivePurchaseGoods,
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

// How much of each medicine is already on the way, so a new suggestion doesn't duplicate
// stock that is already coming. Counts every purchase that has not been completed or
// cancelled: a draft counts in full, and a placed or partially received order counts only
// what is still outstanding (ordered - received). Cancelled orders stop counting.
export const OPEN_PURCHASE_STATUSES = ['draft', 'ordered', 'partially_received']

export const getOpenOrderQuantitiesByDrug = async () => {
  const openPurchases = await listPurchases({ statuses: OPEN_PURCHASE_STATUSES })
  const byDrugId = new Map()
  for (const purchase of openPurchases) {
    if (!OPEN_PURCHASE_STATUSES.includes(purchase.status)) continue
    for (const item of purchase.purchase_items || []) {
      if (!item.drug_id) continue
      const outstanding = Math.max(
        0,
        (Number.parseFloat(item.quantity) || 0) - (Number.parseFloat(item.received_quantity) || 0)
      )
      if (outstanding <= 0) continue
      const existing = byDrugId.get(item.drug_id)
      if (existing) {
        existing.quantity += outstanding
        existing.purchaseNumbers.add(purchase.purchase_number)
      } else {
        byDrugId.set(item.drug_id, { quantity: outstanding, purchaseNumbers: new Set([purchase.purchase_number]) })
      }
    }
  }
  return byDrugId
}

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

export const cancelPurchaseDraft = async (id, options) => {
  await requireInternet('Cancelling a purchase requires internet and was not queued.')
  return cancelPurchase(id, options)
}

export const placePurchaseOrder = async (id) => {
  await requireInternet('Placing an order requires internet and was not queued.')
  return placePurchase(id)
}

export const receivePurchaseOrderGoods = async (id, lines, options) => {
  await requireInternet('Receiving goods requires internet because it posts inventory stock.')
  return receivePurchaseGoods(id, lines, options)
}

export const loadReorderInsights = async (drugIds, windowDays) => getReorderInsights(drugIds, windowDays)

export const loadBranchTransferOptions = async (branchId, drugIds) => getBranchTransferOptions(branchId, drugIds)

export const listPurchaseReceipts = async (purchaseId) => getPurchaseReceipts(purchaseId)

export const getPurchaseCreatorName = async (userId) => getUserDisplayName(userId)

export {
  getOfflinePurchasesSummary,
  subscribeOfflinePurchasesQueue,
  syncOfflinePurchases,
}
