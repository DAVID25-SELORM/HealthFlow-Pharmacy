// Presentation only: retain the server's readiness and freshness decisions.
export const getOfflineModeSummary = ({ config = {}, health, readiness, status, organizationId, branchId, busy = '', test, productionVerification, internetAvailable = true } = {}) => {
  const connected = Boolean(health?.ok)
  const configured = Boolean(config.enabled && config.token)
  const identityMatches = Boolean(organizationId && branchId && readiness?.organizationId === organizationId && readiness?.branchId === branchId)
  const failed = Math.max(Number(status?.failed ?? status?.summary?.failed ?? 0), Number(readiness?.queue?.failed ?? 0))
  const syncing = Number(status?.syncing ?? status?.summary?.syncing ?? 0)
  const pending = Math.max(Number(status?.pending ?? status?.summary?.pending ?? 0), Number(readiness?.queue?.pending ?? 0))
  const snapshots = Object.entries(readiness?.snapshots || {}).filter(([key]) => key !== 'backup').map(([, item]) => item)
  const critical = snapshots.some((item) => item.state === 'critical')
  const stale = snapshots.some((item) => item.state === 'degraded')
  const staffReady = readiness?.staff?.offlinePinReady
  const staffMissing = readiness?.staff?.missingOfflinePin
  const checks = readiness?.checks || []
  const failedChecks = checks.filter((item) => item.required && !item.passed)
  const data = !readiness || snapshots.length === 0 || critical ? 'Action Required' : stale ? 'Needs Refresh' : 'Ready'
  const backupNeedsAttention = ['critical', 'degraded'].includes(readiness?.backups?.state || readiness?.snapshots?.backup?.state)
  const compatibilityBlocked = readiness?.compatibility?.compatible === false
  const ready = connected && identityMatches && readiness?.ready === true && readiness.state === 'HEALTHY' && data === 'Ready' && Number(staffReady) > 0 && Number(staffMissing) === 0 && failed === 0 && readiness?.compatibility?.compatible !== false
  const tested = test?.passed && test.organizationId === organizationId && test.branchId === branchId
  // This is distinct from the read-only readiness test. It is set only after
  // the administrator-led controlled outage and reconciliation check.
  const productionVerified = productionVerification?.acceptanceTest?.passed === true
    && productionVerification.organizationId === organizationId
    && productionVerification.branchId === branchId
  const setupStatus = !configured && !connected ? 'Not Set Up' : !connected ? 'Attention Required' : !identityMatches ? 'Installed — Not Connected' : busy === 'prepare-offline' ? 'Connected — Preparing' : ready && tested ? 'Offline Mode Ready' : test && !test.passed ? 'Attention Required' : ready ? 'Ready to Test' : 'Attention Required'
  const dailyStatus = failed ? 'Attention Required' : connected && !internetAvailable ? 'Offline — Local Server' : syncing > 0 || busy === 'sync' || busy === 'prepare-offline' ? 'Synchronizing' : configured && (!connected || (readiness && !ready)) ? 'Attention Required' : internetAvailable ? 'Online' : 'Attention Required'
  return { connected, configured, identityMatches, failed, pending, syncing, data, staffReady, staffMissing, failedChecks, ready, tested, productionVerified, setupStatus, dailyStatus, compatibilityBlocked, backupNeedsAttention }
}

export const offlineCheckMessage = (id) => ({
  inventory_snapshot: 'Inventory data has not been downloaded. Prepare Offline Mode.',
  reference_snapshot: 'Patient and NHIS data need preparation. Prepare Offline Mode.',
  operational_snapshot: 'Staff and facility data need preparation. Prepare Offline Mode.',
  sync_credentials: 'Connect the Main Computer to your facility before preparing data.',
  database: 'The Main Computer needs a database check. Ask your administrator to review Advanced.',
  frontend: 'The offline application needs installation or an update. Ask your administrator.',
  signed_updates: 'Update protection needs configuration. Ask your administrator to review Advanced.',
  offline_session_window: 'Offline staff access needs configuration. Ask your administrator.',
}[id] || 'An offline protection check needs attention. Ask your administrator to review Advanced.')
