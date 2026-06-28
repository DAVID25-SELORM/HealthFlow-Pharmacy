import {
  addDrug,
  getDrugById,
  updateDrug,
} from './drugService'
import {
  getConnectivityState,
  refreshConnectivityState,
} from './connectivityService'
import { decryptJson, encryptJson } from '../utils/browserEncryption'

const DB_NAME = 'healthflow-offline-inventory'
const DB_VERSION = 1
const STORE_NAME = 'offline_inventory_operations'
let currentSyncPromise = null

export const OFFLINE_INVENTORY_QUEUE_CHANGED_EVENT =
  'healthflow:offline-inventory-queue-changed'

const emptySummary = () => ({
  pending: 0,
  syncing: 0,
  failed: 0,
  conflicted: 0,
  synced: 0,
  unsynced: 0,
  total: 0,
})

const isBrowser = () => typeof window !== 'undefined'

const createId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `offline-inventory-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const dispatchQueueChanged = () => {
  if (isBrowser()) {
    window.dispatchEvent(new Event(OFFLINE_INVENTORY_QUEUE_CHANGED_EVENT))
  }
}

const openDb = () =>
  new Promise((resolve, reject) => {
    if (!isBrowser() || !window.indexedDB) {
      reject(new Error('Offline inventory storage is not available on this device.'))
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
      reject(request.error || new Error('Unable to open offline inventory storage.'))
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
      reject(request.error || new Error('Offline inventory storage request failed.'))
    transaction.onerror = () =>
      reject(transaction.error || new Error('Offline inventory transaction failed.'))
  }).finally(() => db.close())
}

const saveOperation = async (operation) => {
  const savedOperation = {
    ...operation,
    updatedAt: new Date().toISOString(),
  }
  const encryptedPayload = await encryptJson(savedOperation)
  await runStoreRequest('readwrite', (store) =>
    store.put({
      id: savedOperation.id,
      status: savedOperation.status || 'pending',
      createdAt: savedOperation.createdAt,
      updatedAt: savedOperation.updatedAt,
      encryptedPayload,
    })
  )
  dispatchQueueChanged()
  return savedOperation
}

const unwrapOperation = async (record) => {
  if (!record?.encryptedPayload) return null
  return decryptJson(record.encryptedPayload)
}

export const queueOfflineInventoryOperation = async ({
  operation,
  drugId = null,
  drugPayload,
  expectedUpdatedAt = null,
  organizationId,
  branchId = null,
  createdBy = null,
}) => {
  if (!['create', 'update'].includes(operation)) {
    throw new Error('Only inventory create and update operations can be queued offline.')
  }
  if (!organizationId) {
    throw new Error('Organization is required before saving inventory changes offline.')
  }

  const now = new Date().toISOString()
  if (operation === 'update' && drugId) {
    const existingOperation = (await getOfflineInventoryQueue()).find(
      (queuedOperation) =>
        queuedOperation.organizationId === organizationId &&
        queuedOperation.operation === 'update' &&
        queuedOperation.drugId === drugId &&
        ['pending', 'failed'].includes(queuedOperation.status || 'pending')
    )
    if (existingOperation) {
      return saveOperation({
        ...existingOperation,
        drugPayload,
        expectedUpdatedAt: existingOperation.expectedUpdatedAt || expectedUpdatedAt,
        branchId,
        createdBy,
        status: 'pending',
        attempts: 0,
        lastError: null,
      })
    }
  }

  return saveOperation({
    id: createId(),
    operation,
    drugId,
    drugPayload,
    expectedUpdatedAt,
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

export const getOfflineInventoryQueue = async () => {
  const records = await runStoreRequest('readonly', (store) => store.getAll())
  const operations = await Promise.all((records || []).map(unwrapOperation))
  return operations
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
}

export const getOfflineInventorySummary = async ({ organizationId } = {}) => {
  if (!organizationId) return emptySummary()

  try {
    const operations = (await getOfflineInventoryQueue()).filter(
      (operation) => operation.organizationId === organizationId
    )
    return operations.reduce((summary, operation) => {
      const status = operation.status || 'pending'
      summary[status] = (summary[status] || 0) + 1
      if (status !== 'synced') summary.unsynced += 1
      return summary
    }, { ...emptySummary(), total: operations.length })
  } catch (error) {
    console.warn('Unable to read offline inventory summary:', error)
    return emptySummary()
  }
}

export const subscribeOfflineInventoryQueue = (handler) => {
  if (!isBrowser()) return () => {}
  window.addEventListener(OFFLINE_INVENTORY_QUEUE_CHANGED_EVENT, handler)
  return () => window.removeEventListener(OFFLINE_INVENTORY_QUEUE_CHANGED_EVENT, handler)
}

export const discardOfflineInventoryConflicts = async ({ organizationId } = {}) => {
  if (!organizationId) {
    throw new Error('Organization is required before discarding inventory conflicts.')
  }

  const conflicts = (await getOfflineInventoryQueue()).filter(
    (operation) =>
      operation.organizationId === organizationId &&
      operation.status === 'conflicted'
  )
  for (const conflict of conflicts) {
    await runStoreRequest('readwrite', (store) => store.delete(conflict.id))
  }
  if (conflicts.length > 0) dispatchQueueChanged()
  return conflicts.length
}

const hasUpdateConflict = async (operation) => {
  if (operation.operation !== 'update' || !operation.expectedUpdatedAt) return false
  const currentDrug = await getDrugById(operation.drugId)
  const currentUpdatedAt = String(currentDrug?.updated_at || '')
  return Boolean(currentUpdatedAt && currentUpdatedAt !== operation.expectedUpdatedAt)
}

const runSync = async ({ organizationId } = {}) => {
  if (!organizationId) {
    throw new Error('Organization is required before syncing offline inventory changes.')
  }

  const connectivity = await refreshConnectivityState({ probeLocal: true })
    .catch(() => getConnectivityState())
  if (!connectivity.internetAvailable) {
    return { synced: 0, failed: 0, conflicted: 0, skipped: true }
  }

  const operations = (await getOfflineInventoryQueue())
    .filter((operation) => operation.organizationId === organizationId)
  const existingConflicts = operations.filter(
    (operation) => operation.status === 'conflicted'
  ).length
  const syncableOperations = operations
    .filter((operation) => ['pending', 'failed', 'syncing'].includes(operation.status || 'pending'))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  let synced = 0
  let failed = 0
  let conflicted = existingConflicts

  for (const operation of syncableOperations) {
    const workingOperation = await saveOperation({
      ...operation,
      status: 'syncing',
      attempts: Number(operation.attempts || 0) + 1,
      lastError: null,
      lastSyncAttemptAt: new Date().toISOString(),
    })

    try {
      if (await hasUpdateConflict(workingOperation)) {
        await saveOperation({
          ...workingOperation,
          status: 'conflicted',
          lastError: 'Inventory changed in the cloud after this offline edit. Review it manually.',
        })
        conflicted += 1
        continue
      }

      const result = workingOperation.operation === 'create'
        ? await addDrug(workingOperation.drugPayload)
        : await updateDrug(workingOperation.drugId, workingOperation.drugPayload)
      await saveOperation({
        ...workingOperation,
        status: 'synced',
        remoteDrugId: result?.id || workingOperation.drugId || null,
        syncedAt: new Date().toISOString(),
        lastError: null,
      })
      synced += 1
    } catch (error) {
      console.error('Offline inventory sync failed:', error)
      await saveOperation({
        ...workingOperation,
        status: 'failed',
        lastError: error.message || 'Unable to sync offline inventory change.',
      })
      failed += 1
    }
  }

  return { synced, failed, conflicted, skipped: false }
}

export const syncOfflineInventory = async (options = {}) => {
  if (currentSyncPromise) return currentSyncPromise
  currentSyncPromise = runSync(options)

  try {
    return await currentSyncPromise
  } finally {
    currentSyncPromise = null
  }
}
