# Offline Mode simplification

## Workflow

Previously the page exposed installation, preparation, readiness internals and a cash-sale acceptance test together. The main flow is now Set Up Offline Mode -> Main Computer -> Connect Facility -> Prepare Offline Mode -> staff PINs -> Test Offline Mode -> Ready.

The guide detects a responding configured server, skips installation when connected, and does not recommend reinstalling an unreachable configured machine. Browser security prevents arbitrary installation discovery: an unconfigured browser must open the installed local shortcut or use the existing installer.

Facility selection uses existing human-readable setup options, confirms the target, and reuses registration and Apply Facility Connection. Existing super-admin registration authorization remains in place. Facility admins needing first registration are directed to their system administrator.

Preparation now uses existing reconnect/reconcile: validate cloud branch identity, upload eligible work, refresh inventory and reference/operational data, cache POS inventory, and check readiness. It does not create a parallel sync engine.

## Status and protection

The main view includes Not Set Up, Installed - Not Connected, Connected - Preparing, Ready to Test, Offline Mode Ready and Attention Required. Daily status shows Online, Offline - Local Server, Synchronizing or Attention Required. Queue counts include pending, syncing and failed work. Data is Ready, Needs Refresh or Action Required using existing server freshness decisions.

Final readiness requires current server checks, matching organization/branch, healthy protection state, fresh snapshots, staff readiness, no failed queue entries, no known compatibility failure and a successful test. Persisted test evidence is presentation only: it cannot bypass current checks or grant authorization. The server currently reports unknown compatibility; the UI cannot certify compatibility beyond available evidence.

Staff see PIN instructions and counts; admins can view names/readiness and open existing staff settings. PIN hashes, sessions, lockouts and audits are unchanged.

Test Offline Mode reads health, readiness, queue and inventory, then validates the cloud connection when internet is available. It creates no financial or stock transactions. An internet outage or failed connection check cannot produce a new final pass. The old controlled cash-sale acceptance workflow remains under Advanced and is not triggered by the normal test.

## Technical changes

- src/components/OfflineModeGuide.jsx and its tests: guided presentation, actions, help and staff summary.
- src/utils/offlineModeSummary.js: conservative presentation mapping.
- src/pages/OfflineSync.jsx and tests: wiring, preparation orchestration, read-only test, scoped evidence and periodic status refresh.
- src/pages/OfflineSync.css: responsive summary, stacked mobile controls and hidden technical content.
- src/services/branchServerApi.js: read-only connection-check client.
- local-branch-server/src/server.js: admin-protected GET /api/sync/connection-check under existing local API authentication.
- local-branch-server/src/supabaseSync.js and tests: expose and test the existing identity validation helper without mutating stock or queues.

No schema changes. The automatic sync worker, retry classification, security controls, backups and signed updates are unchanged. Status refresh observes the worker; it does not start another writer. Advanced retains updates, NHIA settings, raw diagnostics, issues, maintenance and controlled acceptance testing, hidden from ordinary users.

## Limitations

An updated local branch server is needed for the new connection-check endpoint; an older server fails the test safely. No installer was built or installed. Hardware outage, trusted HTTPS workstation enrollment and an actual end-to-end production reconnection were not exercised. Other workstations still require the configured trusted address/enrollment; network discovery is not implemented. Live NHIA checks and online payments still need internet.

Chrome review used the actual guide component in an isolated local fixture, with synthetic data and minimal theme styling. Desktop 1280px and mobile 390px showed no horizontal overflow; this was not a signed-in production smoke test.

Nothing pushed or deployed.

## Final validation

Full regression suite: 150 files, 965 tests passed. This includes local branch-server tests, offline authentication/PIN, sales and stock, sync failure/retry, snapshots, authorization, backups and update protections. Focused guide/page run: 40 tests passed. Read-only connection fixture: 2 tests passed, including tenant/branch rejection and zero local database changes. Earlier assertion/newline failures were corrected before the final run.

Final lint passed. Production build passed (23.49 seconds). Protected baseline verified. All 113 migrations passed validation; no migration was added. Browser fixture checks passed at 1280px and 390px. Full hardware outage and production installation remain untested.

## Second review - 11 September 2026

Found and corrected two presentation issues: backup degradation now has explicit actionable guidance even when snapshots are current; the passing-test message now checks the same facility/branch evidence as the readiness heading. Added regressions for both. Targeted rerun: 47 tests across four files passed. The prior full run of 965 tests passed before these two follow-up fixes; it is not presented as a new full run.

Verified endpoint ordering: the connection-check route follows branch-token, authorized-workstation, signed-user-session and operational-role middleware, then explicitly requires administrator access. The sync worker is started by the local server and remains unchanged.

Access limitation: /offline-sync is restricted to admin, branch_manager and super_admin. General staff cannot access this dashboard; they use existing normal connectivity and PIN flows. Branch managers can see the operational overview but the final cloud test requires an administrator. First registration remains super-admin-only. No roles were broadened. Installer detection remains connection-based, not an operating-system installation scan. These are intentional retained architecture limits, not completed automatic discovery features.

Nothing pushed or deployed. Physical outage, actual installation and multi-workstation enrollment still require a controlled deployment test.
