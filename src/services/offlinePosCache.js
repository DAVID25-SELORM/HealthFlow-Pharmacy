const POS_CACHE_KEY = 'healthflow.offline.pos.snapshots.v1'

const isBrowser = () => typeof window !== 'undefined' && Boolean(window.localStorage)

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

const normalizeLookup = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')

const compactLookup = (value = '') => normalizeLookup(value).replace(/\s+/g, '')

export const loadOfflinePosSnapshot = async (userId) => {
  const snapshots = readSnapshots()
  return snapshots[getSnapshotKey(userId)] || null
}

export const saveOfflinePosSnapshot = async (userId, partialSnapshot) => {
  if (!partialSnapshot || typeof partialSnapshot !== 'object') {
    return null
  }

  const snapshots = readSnapshots()
  const key = getSnapshotKey(userId)
  const previous = snapshots[key] || {}
  const nextSnapshot = {
    ...previous,
    ...partialSnapshot,
    savedAt: new Date().toISOString(),
  }

  snapshots[key] = nextSnapshot
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
