const POS_CACHE_KEY = 'healthflow.offline.pos.snapshots.v1'
const POS_DB_NAME = 'healthflow-offline-pos'
const POS_DB_VERSION = 1
const POS_STORE_NAME = 'snapshots'

const isBrowser = () => typeof window !== 'undefined' && Boolean(window.localStorage)
const canUseIndexedDb = () => typeof window !== 'undefined' && Boolean(window.indexedDB)

let databasePromise = null

const openDatabase = () => {
  if (!canUseIndexedDb()) {
    return Promise.resolve(null)
  }

  if (databasePromise) {
    return databasePromise
  }

  databasePromise = new Promise((resolve) => {
    const request = window.indexedDB.open(POS_DB_NAME, POS_DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(POS_STORE_NAME)) {
        database.createObjectStore(POS_STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      console.warn('Unable to open offline POS IndexedDB cache:', request.error)
      resolve(null)
    }
    request.onblocked = () => resolve(null)
  })

  return databasePromise
}

const readIndexedSnapshot = async (key) => {
  const database = await openDatabase()
  if (!database) {
    return null
  }

  return await new Promise((resolve) => {
    const transaction = database.transaction(POS_STORE_NAME, 'readonly')
    const request = transaction.objectStore(POS_STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => {
      console.warn('Unable to read offline POS IndexedDB cache:', request.error)
      resolve(null)
    }
  })
}

const writeIndexedSnapshot = async (key, snapshot) => {
  const database = await openDatabase()
  if (!database) {
    return false
  }

  return await new Promise((resolve) => {
    const transaction = database.transaction(POS_STORE_NAME, 'readwrite')
    const request = transaction.objectStore(POS_STORE_NAME).put(snapshot, key)
    request.onsuccess = () => resolve(true)
    request.onerror = () => {
      console.warn('Unable to save offline POS IndexedDB cache:', request.error)
      resolve(false)
    }
  })
}

const readSnapshots = () => {
  if (!isBrowser()) {
    return {}
  }

  try {
    return JSON.parse(window.localStorage.getItem(POS_CACHE_KEY) || '{}')
  } catch (error) {
    console.warn('Unable to read offline POS cache:', error)
    return {}
  }
}

const writeSnapshots = (snapshots) => {
  if (!isBrowser()) {
    return
  }

  try {
    window.localStorage.setItem(POS_CACHE_KEY, JSON.stringify(snapshots))
  } catch (error) {
    console.warn('Unable to save offline POS cache:', error)
  }
}

const getSnapshotKey = (userId) => userId || 'anonymous'

const mergeDrugsById = (previousDrugs = [], nextDrugs = []) => {
  const previous = Array.isArray(previousDrugs) ? previousDrugs : []
  const next = Array.isArray(nextDrugs) ? nextDrugs : []

  if (!previous.length || next.length >= previous.length) {
    return next
  }

  const mergedById = new Map(previous.map((drug) => [drug.id, drug]))
  for (const drug of next) {
    if (drug?.id) {
      mergedById.set(drug.id, drug)
    }
  }

  return [...mergedById.values()]
}

const normalizeLookup = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')

const compactLookup = (value = '') => normalizeLookup(value).replace(/\s+/g, '')

export const loadOfflinePosSnapshot = async (userId) => {
  const key = getSnapshotKey(userId)
  const indexedSnapshot = await readIndexedSnapshot(key)
  if (indexedSnapshot) {
    return indexedSnapshot
  }

  const snapshots = readSnapshots()
  return snapshots[key] || null
}

export const saveOfflinePosSnapshot = async (userId, partialSnapshot) => {
  if (!partialSnapshot || typeof partialSnapshot !== 'object') {
    return null
  }

  const snapshots = readSnapshots()
  const key = getSnapshotKey(userId)
  const previous = (await readIndexedSnapshot(key)) || snapshots[key] || {}
  const { drugsCacheMode, ...snapshotPatch } = partialSnapshot
  const shouldReplaceDrugs = drugsCacheMode === 'replace'
  const nextSnapshot = {
    ...previous,
    ...snapshotPatch,
    drugs:
      Object.prototype.hasOwnProperty.call(partialSnapshot, 'drugs')
        ? shouldReplaceDrugs
          ? Array.isArray(partialSnapshot.drugs)
            ? partialSnapshot.drugs
            : []
          : mergeDrugsById(previous.drugs, partialSnapshot.drugs)
        : previous.drugs,
    savedAt: new Date().toISOString(),
  }

  await writeIndexedSnapshot(key, nextSnapshot)

  const compactSnapshot = {
    ...nextSnapshot,
    drugs: Array.isArray(nextSnapshot.drugs) ? nextSnapshot.drugs.slice(0, 100) : nextSnapshot.drugs,
  }
  snapshots[key] = compactSnapshot
  writeSnapshots(snapshots)
  return nextSnapshot
}

export const filterCachedDrugs = (drugs = [], term = '', limit = 30) => {
  const normalizedTerm = normalizeLookup(term)
  const compactTerm = compactLookup(term)
  const source = Array.isArray(drugs) ? drugs : []
  const matches = normalizedTerm
    ? source.filter((drug) =>
        compactTerm && compactLookup(drug.barcode) === compactTerm
          ? true
          : [
          drug.name,
          drug.generic_name,
          drug.brand_name,
          drug.batch_number,
          drug.barcode,
          drug.nhis_code,
        ]
          .filter(Boolean)
          .some((value) => normalizeLookup(value).includes(normalizedTerm))
      )
    : source

  return matches
    .filter((drug) => Number.parseFloat(drug.quantity || 0) > 0)
    .slice(0, limit)
}

export const filterCachedPatients = (patients = [], term = '', limit = 8) => {
  const normalizedTerm = normalizeLookup(term)
  const compactTerm = compactLookup(term)
  const source = Array.isArray(patients) ? patients : []
  const matches = normalizedTerm
    ? source.filter((patient) =>
        [
          patient.full_name,
          patient.phone,
          patient.email,
          patient.insurance_provider,
          patient.insurance_id,
          patient.nhis_member_no,
          patient.nhis_hin,
        ]
          .filter(Boolean)
          .some((value) => {
            const normalizedValue = normalizeLookup(value)
            return normalizedValue.includes(normalizedTerm) ||
              (compactTerm && compactLookup(value).includes(compactTerm))
          })
      )
    : source

  return matches.slice(0, limit)
}
