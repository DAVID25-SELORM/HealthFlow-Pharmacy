import fs from 'node:fs'
import { config, isSupabaseSyncConfigured } from './config.js'
import { getDatabaseStatus } from './db.js'
import { getSyncStatus } from './supabaseSync.js'
import { getUpdateStatus } from './updateManager.js'

const check = (id, label, passed, detail, required = true) => ({
  id,
  label,
  passed: Boolean(passed),
  required,
  detail,
})

export const getOfflineReadiness = ({ frontendIndex }) => {
  const database = getDatabaseStatus()
  const sync = getSyncStatus()
  const updates = getUpdateStatus()
  const inventoryPulledAt = sync.inventory?.lastInventoryImportAt || null
  const referencePulledAt = sync.referenceData?.lastPulledAt || null

  const checks = [
    check('server', 'Local API process', true, `HealthFlow ${updates.currentVersion} is responding.`),
    check(
      'database',
      'Local database integrity',
      database.ok && database.integrity === 'ok',
      database.ok ? `SQLite integrity is ${database.integrity}.` : `SQLite integrity failed: ${database.integrity}`
    ),
    check(
      'frontend',
      'Offline application bundle',
      fs.existsSync(frontendIndex),
      fs.existsSync(frontendIndex) ? 'Offline frontend bundle is installed.' : 'Offline frontend index is missing.'
    ),
    check(
      'sync_credentials',
      'Cloud synchronization credentials',
      isSupabaseSyncConfigured(),
      isSupabaseSyncConfigured()
        ? 'Supabase and branch sync credentials are configured.'
        : 'SUPABASE_URL, SUPABASE_SYNC_KEY, or BRANCH_SYNC_TOKEN is missing.'
    ),
    check(
      'inventory_snapshot',
      'Inventory snapshot',
      Boolean(inventoryPulledAt),
      inventoryPulledAt
        ? `Last inventory pull: ${inventoryPulledAt}`
        : 'Inventory has not completed an initial cloud pull.'
    ),
    check(
      'reference_snapshot',
      'Facility/reference snapshot',
      Boolean(referencePulledAt),
      referencePulledAt
        ? `Last reference pull: ${referencePulledAt}`
        : 'Facility/reference data has not completed an initial cloud pull.'
    ),
    check(
      'signed_updates',
      'Signed automatic updates',
      updates.configured && updates.installerReady,
      updates.configured && updates.installerReady
        ? `Signed ${updates.channel} updates are configured.`
        : 'The signed update manifest, public key, or platform installer is not ready.'
    ),
    check(
      'failed_queue',
      'Failed synchronization queue',
      Number(sync.failed || 0) === 0,
      Number(sync.failed || 0) === 0
        ? 'No failed synchronization events.'
        : `${sync.failed} synchronization event(s) require attention.`,
      false
    ),
  ]

  const requiredChecks = checks.filter((item) => item.required)
  return {
    ready: requiredChecks.every((item) => item.passed),
    checkedAt: new Date().toISOString(),
    version: updates.currentVersion,
    mode: 'offline-branch',
    checks,
    summary: {
      requiredPassed: requiredChecks.filter((item) => item.passed).length,
      requiredTotal: requiredChecks.length,
      warnings: checks.filter((item) => !item.required && !item.passed).length,
    },
    queue: {
      pending: Number(sync.pending || 0),
      failed: Number(sync.failed || 0),
    },
    organizationId: config.organizationId || null,
    branchId: config.branchId || null,
  }
}
