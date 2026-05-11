import { config, isSupabaseSyncConfigured } from './config.js'
import './db.js'
import { pullInventorySnapshot, pullReferenceData, syncPendingOutbox } from './supabaseSync.js'

let lastInventoryPullAt = 0

const runOnce = async () => {
  if (!isSupabaseSyncConfigured()) {
    console.warn('Supabase sync is not configured. Set SUPABASE_URL, SUPABASE_SYNC_KEY, and BRANCH_SYNC_TOKEN.')
    return
  }

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
      `Reference data pulled: ${referenceResult.patients} patient(s), ${referenceResult.claims} claim(s), ${referenceResult.nhisClaims} NHIS claim(s), ${referenceResult.purchases} purchase(s).`
    )
  }
}

if (process.argv.includes('--once')) {
  runOnce().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  console.log(`HealthFlow branch sync worker running every ${config.syncIntervalSeconds}s.`)
  runOnce().catch((error) => console.error(error))
  setInterval(() => {
    runOnce().catch((error) => console.error(error))
  }, config.syncIntervalSeconds * 1000)
}
