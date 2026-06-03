import { config, isSupabaseSyncConfigured } from './config.js'
import './db.js'
import { submitPendingNhiaClaims } from './nhiaRepository.js'
import { pullInventorySnapshot, pullReferenceData, syncPendingOutbox } from './supabaseSync.js'

let lastInventoryPullAt = 0
let syncInterval = null
// ✅ SQLITE CORRUPTION FIX START
let isSyncRunning = false
let activeSyncPromise = null
// ✅ SQLITE CORRUPTION FIX END

const runSyncWorkerBody = async () => {
  try {
    const nhiaResult = await submitPendingNhiaClaims()
    if (nhiaResult.checked > 0 || nhiaResult.failed > 0) {
      console.log(
        `NHIA checked ${nhiaResult.checked} claim(s): ${nhiaResult.submitted} submitted, ${nhiaResult.failed} failed.`
      )
    }
  } catch (error) {
    console.error('NHIA pending submission failed:', error)
  }

  if (!isSupabaseSyncConfigured()) {
    console.warn('Supabase sync is not configured. Set SUPABASE_URL, SUPABASE_SYNC_KEY, and BRANCH_SYNC_TOKEN.')
    return
  }

  try {
    const result = await syncPendingOutbox()
    if (result.total > 0) {
      console.log(
        `Sync checked ${result.total} event(s): ${result.synced} synced, ${result.failed} failed.`
      )
    }

    const now = Date.now()
    if (now - lastInventoryPullAt >= config.inventoryPullIntervalSeconds * 1000) {
      const [inventoryResult, referenceResult] = await Promise.all([
        pullInventorySnapshot(),
        pullReferenceData(),
      ])
      lastInventoryPullAt = now
      console.log(
        `Inventory snapshot imported ${inventoryResult.imported} drug(s) at ${inventoryResult.importedAt}.`
      )
      console.log(
        `Reference data pulled: ${referenceResult.patients} patient(s), ${referenceResult.claims} claim(s), ${referenceResult.nhisClaims} NHIS claim(s), ${referenceResult.nhiaConfigurations} NHIA config(s), ${referenceResult.purchases} purchase(s).`
      )
    }
  } catch (error) {
    console.error('Supabase branch sync failed:', error)
  }
}

export const runSyncWorkerOnce = async () => {
  // ✅ SQLITE CORRUPTION FIX START
  if (isSyncRunning) {
    console.log('Sync skipped: previous run still active.')
    return { skipped: true }
  }

  isSyncRunning = true
  activeSyncPromise = runSyncWorkerBody()
  try {
    return await activeSyncPromise
  } finally {
    isSyncRunning = false
    activeSyncPromise = null
  }
  // ✅ SQLITE CORRUPTION FIX END
}

export const startSyncWorker = () => {
  if (syncInterval) {
    return
  }

  console.log(`HealthFlow branch sync worker running every ${config.syncIntervalSeconds}s.`)
  runSyncWorkerOnce().catch((error) => console.error(error))
  syncInterval = setInterval(() => {
    runSyncWorkerOnce().catch((error) => console.error(error))
  }, config.syncIntervalSeconds * 1000)
}

// ✅ SQLITE CORRUPTION FIX START
export const stopSyncWorker = () => {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
}

export const waitForSyncWorkerIdle = () => activeSyncPromise || Promise.resolve()
// ✅ SQLITE CORRUPTION FIX END

const isCliEntry = process.argv[1] && /(^|\/)syncWorker\.js$/.test(process.argv[1].replace(/\\/g, '/'))

if (isCliEntry && process.argv.includes('--once')) {
  runSyncWorkerOnce().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
} else if (isCliEntry) {
  startSyncWorker()
}
