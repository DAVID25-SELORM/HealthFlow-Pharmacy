import { createPurchase } from './purchasesService'
import {
  getConnectivityState,
  refreshConnectivityState,
} from './connectivityService'
import { decryptJson, encryptJson } from '../utils/browserEncryption'

const DB_NAME = 'healthflow-offline-purchases'
const DB_VERSION = 1
const STORE_NAME = 'offline_purchase_drafts'
let currentSyncPromise = null

export const OFFLINE_PURCHASES_QUEUE_CHANGED_EVENT =
  'healthflow:offline-purchases-queue-changed'

const emptySummary = () => ({
  pending: 0,
  syncing: 0,
  failed: 0,
  synced: 0,
  unsynced: 0,
  total: 0,
})

const createId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `offline-purchase-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const isBrowser = () => typeof window !== 'undefined'

const dispatchQueueChanged = () => {
  if (isBrowser()) {
    window.dispatchEvent(new Event(OFFLINE_PURCHASES_QUEUE_CHANGED_EVENT))
  }
}

const openDb = () =>
  new Promise((resolve, reject) => {
    if (!isBrowser() || !window.indexedDB) {
      reject(new Error('Offline purchase storage is not available on this device.'))
      return
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('status', 'status', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error || new Error('Unable to open offline purchase storage.'))
  })

const runStoreRequest = async (mode, operation) => {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)
    let request
    try {
      request = operation(store)
    } catch (error) {
      reject(error)
      transaction.abort()
      return
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error || new Error('Offline purchase storage request failed.'))
    transaction.onerror = () =>
      reject(transaction.error || new Error('Offline purchase transaction failed.'))
  }).finally(() => db.close())
}

const saveDraft = async (draft) => {
  const savedDraft = { ...draft, updatedAt: new Date().toISOString() }
  const encryptedPayload = await encryptJson(savedDraft)
  await runStoreRequest('readwrite', (store) =>
    store.put({
      id: savedDraft.id,
      status: savedDraft.status || 'pending',
      createdAt: savedDraft.createdAt,
      updatedAt: savedDraft.updatedAt,
      encryptedPayload,
    })
  )
  dispatchQueueChanged()
  return savedDraft
}

const unwrapDraft = async (record) => {
  if (!record?.encryptedPayload) return null
  return decryptJson(record.encryptedPayload)
}

export const queueOfflinePurchaseDraft = async ({
  purchaseId,
  purchaseData,
  items,
  organizationId,
  branchId = null,
  createdBy = null,
}) => {
  if (!organizationId) {
    throw new Error('Organization is required before saving a purchase offline.')
  }
  const now = new Date().toISOString()
  return saveDraft({
    id: createId(),
    purchaseId,
    purchaseData,
    items,
    organizationId,
    branchId,
    createdBy,
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  })
}

export const getOfflinePurchaseDrafts = async () => {
  const records = await runStoreRequest('readonly', (store) => store.getAll())
  const drafts = await Promise.all((records || []).map(unwrapDraft))
  return drafts
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
}

export const getOfflinePurchasesSummary = async ({ organizationId } = {}) => {
  if (!organizationId) return emptySummary()
  try {
    const drafts = (await getOfflinePurchaseDrafts()).filter(
      (draft) => draft.organizationId === organizationId
    )
    return drafts.reduce((summary, draft) => {
      const status = draft.status || 'pending'
      summary[status] = (summary[status] || 0) + 1
      if (status !== 'synced') summary.unsynced += 1
      return summary
    }, { ...emptySummary(), total: drafts.length })
  } catch (error) {
    console.warn('Unable to read offline purchase summary:', error)
    return emptySummary()
  }
}

export const subscribeOfflinePurchasesQueue = (handler) => {
  if (!isBrowser()) return () => {}
  window.addEventListener(OFFLINE_PURCHASES_QUEUE_CHANGED_EVENT, handler)
  return () => window.removeEventListener(OFFLINE_PURCHASES_QUEUE_CHANGED_EVENT, handler)
}

const runSync = async ({ organizationId } = {}) => {
  if (!organizationId) {
    throw new Error('Organization is required before syncing offline purchases.')
  }
  const connectivity = await refreshConnectivityState({ probeLocal: true })
    .catch(() => getConnectivityState())
  if (!connectivity.internetAvailable && !connectivity.branchServerAvailable) {
    return { synced: 0, failed: 0, skipped: true }
  }

  const drafts = (await getOfflinePurchaseDrafts())
    .filter((draft) => draft.organizationId === organizationId)
    .filter((draft) => ['pending', 'failed', 'syncing'].includes(draft.status || 'pending'))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  let synced = 0
  let failed = 0

  for (const draft of drafts) {
    const workingDraft = await saveDraft({
      ...draft,
      status: 'syncing',
      attempts: Number(draft.attempts || 0) + 1,
      lastError: null,
      lastSyncAttemptAt: new Date().toISOString(),
    })
    try {
      const purchase = await createPurchase(
        {
          ...workingDraft.purchaseData,
          id: workingDraft.purchaseId,
          branchId: workingDraft.branchId || workingDraft.purchaseData.branchId,
        },
        workingDraft.items
      )
      await saveDraft({
        ...workingDraft,
        status: 'synced',
        remotePurchaseId: purchase?.id || workingDraft.purchaseId,
        syncedAt: new Date().toISOString(),
        lastError: null,
      })
      synced += 1
    } catch (error) {
      console.error('Offline purchase sync failed:', error)
      await saveDraft({
        ...workingDraft,
        status: 'failed',
        lastError: error.message || 'Unable to sync offline purchase.',
      })
      failed += 1
    }
  }

  return { synced, failed, skipped: false }
}

export const syncOfflinePurchases = async (options = {}) => {
  if (currentSyncPromise) return currentSyncPromise
  currentSyncPromise = runSync(options)
  try {
    return await currentSyncPromise
  } finally {
    currentSyncPromise = null
  }
}
