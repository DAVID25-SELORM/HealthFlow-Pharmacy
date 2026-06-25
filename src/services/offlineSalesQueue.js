import { createClaim } from './claimsService'
import { createSale } from './salesService'
import { decryptJson, encryptJson } from '../utils/browserEncryption'

const DB_NAME = 'healthflow-offline'
const DB_VERSION = 1
const OFFLINE_SALES_STORE = 'offline_sales'
let currentSyncPromise = null

export const OFFLINE_SALES_QUEUE_CHANGED_EVENT = 'healthflow:offline-sales-queue-changed'

const isBrowser = () => typeof window !== 'undefined'

const createId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }

  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const dispatchQueueChanged = () => {
  if (!isBrowser()) {
    return
  }

  window.dispatchEvent(new Event(OFFLINE_SALES_QUEUE_CHANGED_EVENT))
}

const openOfflineDb = () =>
  new Promise((resolve, reject) => {
    if (!isBrowser() || !window.indexedDB) {
      reject(new Error('Offline storage is not available on this device.'))
      return
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(OFFLINE_SALES_STORE)) {
        const store = db.createObjectStore(OFFLINE_SALES_STORE, { keyPath: 'id' })
        store.createIndex('status', 'status', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Unable to open offline storage.'))
  })

const runStoreRequest = async (mode, operation) => {
  const db = await openOfflineDb()

  return await new Promise((resolve, reject) => {
    const transaction = db.transaction(OFFLINE_SALES_STORE, mode)
    const store = transaction.objectStore(OFFLINE_SALES_STORE)
    let request

    try {
      request = operation(store)
    } catch (error) {
      reject(error)
      transaction.abort()
      return
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Offline storage request failed.'))
    transaction.onerror = () =>
      reject(transaction.error || new Error('Offline storage transaction failed.'))
  }).finally(() => {
    db.close()
  })
}

const saveOfflineSale = async (sale) => {
  const savedSale = {
    ...sale,
    updatedAt: new Date().toISOString(),
  }
  const protectedSale = {
    id: savedSale.id,
    status: savedSale.status || 'pending',
    createdAt: savedSale.createdAt,
    updatedAt: savedSale.updatedAt,
    encryptedPayload: await encryptJson(savedSale),
  }
  await runStoreRequest('readwrite', (store) => store.put(protectedSale))
  dispatchQueueChanged()
  return savedSale
}

const unwrapOfflineSale = async (record) => {
  if (!record?.encryptedPayload) {
    return record
  }

  return await decryptJson(record.encryptedPayload)
}

const appendUniqueLine = (value, line) => {
  if (!line) {
    return value || null
  }

  const text = String(value || '').trim()
  if (text.includes(line)) {
    return text
  }

  return [text, line].filter(Boolean).join('\n')
}

const replaceOfflineReference = (value, offlineSaleNumber, remoteSaleNumber) => {
  if (!value || !offlineSaleNumber || !remoteSaleNumber) {
    return value
  }

  return String(value).split(offlineSaleNumber).join(remoteSaleNumber)
}

export const createOfflineSaleNumber = () => {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '')
  const randomPart = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `OFF-${datePart}-${randomPart}`
}

export const queueOfflineSale = async ({
  salePayload,
  claimPayload = null,
  receiptData,
  organizationId = null,
  branchId = null,
  createdBy = null,
}) => {
  if (!salePayload?.items?.length) {
    throw new Error('At least one sale item is required before queueing offline.')
  }

  const offlineSaleNumber = receiptData?.saleNumber || createOfflineSaleNumber()
  const now = new Date().toISOString()
  const offlineReference = `Offline reference: ${offlineSaleNumber}`
  const queuedSale = {
    id: createId(),
    status: 'pending',
    offlineSaleNumber,
    salePayload: {
      ...salePayload,
      saleDate: salePayload.saleDate || now,
      notes: appendUniqueLine(salePayload.notes, offlineReference),
    },
    claimPayload,
    receiptData: receiptData || null,
    organizationId,
    branchId,
    createdBy,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }

  return await saveOfflineSale(queuedSale)
}

export const getOfflineSalesQueue = async () => {
  const records = await runStoreRequest('readonly', (store) => store.getAll())
  const sales = await Promise.all((records || []).map((record) => unwrapOfflineSale(record)))
  return sales
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export const getOfflineSalesSummary = async () => {
  try {
    const sales = await getOfflineSalesQueue()
    const summary = sales.reduce(
      (result, sale) => {
        const status = sale.status || 'pending'
        result[status] = (result[status] || 0) + 1
        if (status !== 'synced') {
          result.unsynced += 1
        }
        return result
      },
      { pending: 0, syncing: 0, failed: 0, synced: 0, unsynced: 0, total: sales.length }
    )

    return summary
  } catch (error) {
    console.warn('Unable to read offline sales summary:', error)
    return { pending: 0, syncing: 0, failed: 0, synced: 0, unsynced: 0, total: 0 }
  }
}

export const subscribeOfflineSalesQueue = (handler) => {
  if (!isBrowser()) {
    return () => {}
  }

  window.addEventListener(OFFLINE_SALES_QUEUE_CHANGED_EVENT, handler)
  return () => window.removeEventListener(OFFLINE_SALES_QUEUE_CHANGED_EVENT, handler)
}

const buildClaimPayloadForSync = (claimPayload, offlineSaleNumber, remoteSaleNumber) => {
  if (!claimPayload) {
    return null
  }

  return {
    ...claimPayload,
    notes: appendUniqueLine(
      replaceOfflineReference(claimPayload.notes, offlineSaleNumber, remoteSaleNumber),
      offlineSaleNumber && remoteSaleNumber && offlineSaleNumber !== remoteSaleNumber
        ? `Offline reference: ${offlineSaleNumber}`
        : null
    ),
  }
}

const runOfflineSalesSync = async () => {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { synced: 0, failed: 0, skipped: true }
  }

  const sales = await getOfflineSalesQueue()
  const syncableSales = sales
    .filter((sale) => ['pending', 'failed', 'syncing'].includes(sale.status || 'pending'))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))

  let synced = 0
  let failed = 0

  for (const sale of syncableSales) {
    const attempt = Number(sale.attempts || 0) + 1
    let workingSale = await saveOfflineSale({
      ...sale,
      status: 'syncing',
      attempts: attempt,
      lastError: null,
      lastSyncAttemptAt: new Date().toISOString(),
    })

    try {
      if (!workingSale.remoteSaleId && !workingSale.remoteSaleNumber) {
        const saleResult = await createSale(workingSale.salePayload)
        workingSale = await saveOfflineSale({
          ...workingSale,
          remoteSaleId: saleResult?.sale?.id || null,
          remoteSaleNumber: saleResult?.saleNumber || saleResult?.sale?.sale_number || null,
        })
      }

      const claimPayload = buildClaimPayloadForSync(
        workingSale.claimPayload,
        workingSale.offlineSaleNumber,
        workingSale.remoteSaleNumber
      )

      if (claimPayload && !workingSale.claimSyncedAt) {
        await createClaim(claimPayload)
        workingSale = await saveOfflineSale({
          ...workingSale,
          claimSyncedAt: new Date().toISOString(),
        })
      }

      await saveOfflineSale({
        ...workingSale,
        status: 'synced',
        syncedAt: new Date().toISOString(),
        lastError: null,
      })
      synced += 1
    } catch (error) {
      console.error('Offline sale sync failed:', error)
      await saveOfflineSale({
        ...workingSale,
        status: 'failed',
        lastError: error.message || 'Unable to sync offline sale.',
      })
      failed += 1
    }
  }

  return { synced, failed, skipped: false }
}

export const syncOfflineSales = async () => {
  if (currentSyncPromise) {
    return currentSyncPromise
  }

  currentSyncPromise = runOfflineSalesSync()

  try {
    return await currentSyncPromise
  } finally {
    currentSyncPromise = null
  }
}
