import fs from 'node:fs'
import { config, isSupabaseSyncConfigured } from './config.js'
import { createId, db, getBranchMeta, getDatabaseStatus, nowIso, setBranchMeta } from './db.js'
import { getSyncStatus } from './supabaseSync.js'
import { getUpdateStatus } from './updateManager.js'
import { getPublicTlsStatus, inspectTlsRuntime } from './tlsSettings.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const ageMs = (value) => value ? Math.max(0, Date.now() - Date.parse(value)) : null
const ageLabel = (value) => {
  const age = ageMs(value)
  if (age === null || Number.isNaN(age)) return 'never'
  return age < HOUR ? `${Math.floor(age / MINUTE)} min ago` : `${Math.floor(age / HOUR)} hr ago`
}
const freshness = (timestamp, degradedAfterMs, id) => {
  const age = ageMs(timestamp)
  if (age === null || Number.isNaN(age)) return { id, state: 'critical', timestamp: null, age: null, detail: 'No completed snapshot.' }
  return { id, state: age > degradedAfterMs ? 'degraded' : 'healthy', timestamp, age, detail: `Last refreshed ${ageLabel(timestamp)}.` }
}
const check = (id, label, passed, detail, required = true) => ({ id, label, passed: Boolean(passed), required, detail })

const recordTransition = (state, detail) => {
  const previous = getBranchMeta('offline_readiness_state')
  if (previous === state) return
  db.prepare('INSERT INTO readiness_events (id, previous_state, current_state, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(createId(), previous, state, detail, nowIso())
  setBranchMeta('offline_readiness_state', state)
}

export const getOfflineReadiness = ({ frontendIndex }) => {
  const database = getDatabaseStatus()
  const sync = getSyncStatus()
  const updates = getUpdateStatus()
  const inventoryPulledAt = sync.inventory?.lastInventoryImportAt || null
  const referencePulledAt = sync.referenceData?.lastPulledAt || null
  const operationalPulledAt = getBranchMeta('operational_data_last_pulled_at')
  const tls = getPublicTlsStatus(inspectTlsRuntime())
  const staff = db.prepare(`SELECT COUNT(*) AS active,
    SUM(CASE WHEN offline_access_enabled = 1 AND offline_pin_hash IS NOT NULL AND offline_pin_salt IS NOT NULL THEN 1 ELSE 0 END) AS pin_ready
    FROM users WHERE is_active = 1`).get()
  const latestBackup = database.latestBackups?.[0] || null
  const inventory = freshness(inventoryPulledAt, 15 * MINUTE, 'inventory')
  const staffSnapshot = freshness(operationalPulledAt, 6 * HOUR, 'staff')
  const patients = freshness(referencePulledAt, 24 * HOUR, 'patients')
  const reference = freshness(referencePulledAt, 24 * HOUR, 'nhis_reference')
  const facility = freshness(operationalPulledAt, 6 * HOUR, 'facility_settings')
  const backupAge = ageMs(latestBackup?.modifiedAt)
  const backupState = !latestBackup || backupAge > 72 * HOUR ? 'critical' : backupAge > 24 * HOUR ? 'degraded' : 'healthy'
  const failed = Number(sync.failed || 0)
  const checks = [
    check('server', 'Local API process', true, `HealthFlow ${updates.currentVersion} is responding.`),
    check('database', 'Local database integrity', database.ok && database.integrity === 'ok' && database.foreignKeysEnabled, database.ok ? `SQLite integrity is ${database.integrity}; WAL ${database.journalMode}; foreign keys ${database.foreignKeysEnabled ? 'enabled' : 'disabled'}.` : `SQLite integrity failed: ${database.integrity}`),
    check('frontend', 'Offline application bundle', fs.existsSync(frontendIndex), fs.existsSync(frontendIndex) ? 'Offline frontend bundle is installed.' : 'Offline frontend index is missing.'),
    check('sync_credentials', 'Cloud synchronization credentials', isSupabaseSyncConfigured(), isSupabaseSyncConfigured() ? 'Supabase and branch sync credentials are configured.' : 'SUPABASE_URL, SUPABASE_SYNC_KEY, or BRANCH_SYNC_TOKEN is missing.'),
    check('inventory_snapshot', 'Inventory snapshot', inventory.state !== 'critical', inventory.detail),
    check('reference_snapshot', 'Facility/reference snapshot', reference.state !== 'critical', reference.detail),
    check('operational_snapshot', 'Historical sales and staff snapshot', staffSnapshot.state !== 'critical', staffSnapshot.detail),
    check('offline_session_window', 'Long-outage staff session window', config.offlineSessionHours >= 24 * 7, `Verified staff sessions remain valid locally for ${config.offlineSessionHours} hours.`),
    check('signed_updates', 'Signed automatic updates', updates.configured && updates.installerReady, updates.configured && updates.installerReady ? `Signed ${updates.channel} updates are configured.` : 'The signed update manifest, public key, or platform installer is not ready.'),
    check('facility_tls', 'Facility HTTPS certificate', tls.ready, tls.ready ? `TLS is ready at ${tls.publicUrl || 'the configured LAN address'}.` : tls.warning, false),
    check('failed_queue', 'Failed synchronization queue', failed === 0, failed === 0 ? 'No failed synchronization events.' : `${failed} synchronization event(s) require attention.`, false),
  ]
  const requiredChecks = checks.filter((item) => item.required)
  const snapshots = { inventory, staff: staffSnapshot, patients, reference, facility, backup: { state: backupState, timestamp: latestBackup?.modifiedAt || null, detail: latestBackup ? `Latest backup ${ageLabel(latestBackup.modifiedAt)}.` : 'No local backup.' } }
  const hasCritical = Object.values(snapshots).some((item) => item.state === 'critical') || !database.ok || !database.foreignKeysEnabled
  const hasDegraded = failed > 0 || Object.values(snapshots).some((item) => item.state === 'degraded') || (sync.lastSuccessfulCloudSyncAt && ageMs(sync.lastSuccessfulCloudSyncAt) > 10 * MINUTE)
  const state = !isSupabaseSyncConfigured() ? 'OFFLINE' : hasCritical ? 'ACTION_REQUIRED' : hasDegraded ? 'DEGRADED' : 'HEALTHY'
  recordTransition(state, `pending=${sync.pending || 0}; failed=${failed}`)
  return {
    ready: requiredChecks.every((item) => item.passed), state, checkedAt: nowIso(), version: updates.currentVersion, mode: 'offline-branch', checks,
    summary: { requiredPassed: requiredChecks.filter((item) => item.passed).length, requiredTotal: requiredChecks.length, warnings: checks.filter((item) => !item.required && !item.passed).length },
    queue: { pending: Number(sync.pending || 0), failed, oldestPendingEventAt: sync.oldestPendingEventAt, oldestFailedEventAt: sync.oldestFailedEventAt, lastSuccessfulCloudSyncAt: sync.lastSuccessfulCloudSyncAt },
    snapshots,
    staff: { active: Number(staff.active || 0), offlinePinReady: Number(staff.pin_ready || 0), missingOfflinePin: Math.max(0, Number(staff.active || 0) - Number(staff.pin_ready || 0)) },
    backups: { latest: latestBackup, latestVerified: null, backupAgeMs: backupAge, count: database.backupCount, state: backupState },
    database: { integrity: database.integrity, wal: database.wal, shm: database.shm, database: database.database, foreignKeysEnabled: database.foreignKeysEnabled, journalMode: database.journalMode },
    compatibility: { status: 'unknown', compatible: null, branchServerVersion: updates.currentVersion },
    organizationId: config.organizationId || null, branchId: config.branchId || null,
  }
}
