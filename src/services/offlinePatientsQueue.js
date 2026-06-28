import { addPatient } from './patientService'
import {
  getConnectivityState,
  refreshConnectivityState,
} from './connectivityService'
import { decryptJson, encryptJson } from '../utils/browserEncryption'

const DB_NAME = 'healthflow-offline-patients'
const DB_VERSION = 1
const STORE_NAME = 'offline_patients'
let currentSyncPromise = null

export const OFFLINE_PATIENTS_QUEUE_CHANGED_EVENT =
  'healthflow:offline-patients-queue-changed'

const emptySummary = () => ({
  pending: 0,
  syncing: 0,
  failed: 0,
  synced: 0,
  unsynced: 0,
  total: 0,
})

const isBrowser = () => typeof window !== 'undefined'

const createId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }

  return `offline-patient-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const dispatchQueueChanged = () => {
  if (isBrowser()) {
    window.dispatchEvent(new Event(OFFLINE_PATIENTS_QUEUE_CHANGED_EVENT))
  }
}

const openDb = () =>
  new Promise((resolve, reject) => {
    if (!isBrowser() || !window.indexedDB) {
      reject(new Error('Offline patient storage is not available on this device.'))
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
      reject(request.error || new Error('Unable to open offline patient storage.'))
  })

const runStoreRequest = async (mode, operation) => {
  const db = await openDb()

  return await new Promise((resolve, reject) => {
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
      reject(request.error || new Error('Offline patient storage request failed.'))
    transaction.onerror = () =>
      reject(transaction.error || new Error('Offline patient storage transaction failed.'))
  }).finally(() => db.close())
}

const saveQueuedPatient = async (patient) => {
  const savedPatient = {
    ...patient,
    updatedAt: new Date().toISOString(),
  }
  const encryptedPayload = await encryptJson(savedPatient)
  await runStoreRequest('readwrite', (store) =>
    store.put({
      id: savedPatient.id,
      status: savedPatient.status || 'pending',
      createdAt: savedPatient.createdAt,
      updatedAt: savedPatient.updatedAt,
      encryptedPayload,
    })
  )
  dispatchQueueChanged()
  return savedPatient
}

const unwrapQueuedPatient = async (record) => {
  if (!record?.encryptedPayload) return null
  return decryptJson(record.encryptedPayload)
}

export const queueOfflinePatient = async ({
  patientPayload,
  organizationId,
  branchId = null,
  createdBy = null,
}) => {
  if (!organizationId) {
    throw new Error('Organization is required before saving a patient offline.')
  }

  const now = new Date().toISOString()
  return saveQueuedPatient({
    id: createId(),
    status: 'pending',
    patientPayload,
    organizationId,
    branchId,
    createdBy,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  })
}

export const getOfflinePatientsQueue = async () => {
  const records = await runStoreRequest('readonly', (store) => store.getAll())
  const patients = await Promise.all((records || []).map(unwrapQueuedPatient))
  return patients
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
}

export const getOfflinePatientsSummary = async ({ organizationId } = {}) => {
  if (!organizationId) return emptySummary()

  try {
    const patients = (await getOfflinePatientsQueue()).filter(
      (patient) => !organizationId || patient.organizationId === organizationId
    )
    return patients.reduce(
      (summary, patient) => {
        const status = patient.status || 'pending'
        summary[status] = (summary[status] || 0) + 1
        if (status !== 'synced') summary.unsynced += 1
        return summary
      },
      {
        pending: 0,
        syncing: 0,
        failed: 0,
        synced: 0,
        unsynced: 0,
        total: patients.length,
      }
    )
  } catch (error) {
    console.warn('Unable to read offline patient summary:', error)
    return emptySummary()
  }
}

export const subscribeOfflinePatientsQueue = (handler) => {
  if (!isBrowser()) return () => {}
  window.addEventListener(OFFLINE_PATIENTS_QUEUE_CHANGED_EVENT, handler)
  return () => window.removeEventListener(OFFLINE_PATIENTS_QUEUE_CHANGED_EVENT, handler)
}

const runSync = async ({ organizationId } = {}) => {
  if (!organizationId) {
    throw new Error('Organization is required before syncing offline patients.')
  }

  const connectivity = await refreshConnectivityState({ probeLocal: true })
    .catch(() => getConnectivityState())
  if (!connectivity.internetAvailable && !connectivity.branchServerAvailable) {
    return { synced: 0, failed: 0, skipped: true }
  }

  const patients = await getOfflinePatientsQueue()
  const syncablePatients = patients
    .filter((patient) => patient.organizationId === organizationId)
    .filter((patient) => ['pending', 'failed', 'syncing'].includes(patient.status || 'pending'))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  let synced = 0
  let failed = 0

  for (const patient of syncablePatients) {
    const workingPatient = await saveQueuedPatient({
      ...patient,
      status: 'syncing',
      attempts: Number(patient.attempts || 0) + 1,
      lastError: null,
      lastSyncAttemptAt: new Date().toISOString(),
    })

    try {
      const remotePatient = await addPatient(workingPatient.patientPayload)
      await saveQueuedPatient({
        ...workingPatient,
        status: 'synced',
        remotePatientId: remotePatient?.id || null,
        syncedAt: new Date().toISOString(),
        lastError: null,
      })
      synced += 1
    } catch (error) {
      console.error('Offline patient sync failed:', error)
      await saveQueuedPatient({
        ...workingPatient,
        status: 'failed',
        lastError: error.message || 'Unable to sync offline patient.',
      })
      failed += 1
    }
  }

  return { synced, failed, skipped: false }
}

export const syncOfflinePatients = async (options = {}) => {
  if (currentSyncPromise) return currentSyncPromise
  currentSyncPromise = runSync(options)

  try {
    return await currentSyncPromise
  } finally {
    currentSyncPromise = null
  }
}
