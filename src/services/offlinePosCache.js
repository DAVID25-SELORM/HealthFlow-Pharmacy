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
  const normalizedTerm = term.trim().toLowerCase()
  const source = Array.isArray(drugs) ? drugs : []
  const matches = normalizedTerm
    ? source.filter((drug) =>
        [
          drug.name,
          drug.generic_name,
          drug.batch_number,
          drug.barcode,
          drug.nhis_code,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalizedTerm))
      )
    : source

  return matches
    .filter((drug) => Number.parseFloat(drug.quantity || 0) > 0)
    .slice(0, limit)
}
