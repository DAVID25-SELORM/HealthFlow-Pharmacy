# Controlled outage acceptance record

Status: isolated software test passed; facility acceptance pending.

## Verified locally

Run: npx vitest run local-branch-server/src/outageRecovery.test.js

Uses a temporary SQLite database, the actual local sale repository and actual queue synchronization code. All outbound HTTP is intercepted; no real cloud or production data is used.

- Cash sale of 2 units from 10 leaves local stock at 8.
- Simulated cloud 503 retains the sale and marks the event transient.
- Retry before its deadline does not transmit the event.
- Advancing the test clock to the retry deadline permits recovery.
- Cloud simulation receives the same local sale ID once.
- Subsequent sync sends nothing; one local sale exists and stock remains 8.

This does not verify cloud-side idempotency after an acknowledgement is lost, automatic worker scheduling, real network loss, PIN login, or multiple workstations. Those require the facility test below. No production acceptance pass is inferred.

## Facility test - not executed

Record the facility, branch, Main Computer, workstation names, installed version, tester and approved test stock. Prefer a separate test branch. Confirm a backup is available. Use only agreed test transactions; do not create patient or financial production records for demonstration without a defined test plan.

1. While online, record local/cloud stock, record counts, receipt identifiers and pending/failed counts. Resolve unrelated failed work first.
2. On each workstation, confirm the local app and individual PIN access are ready.
3. Disconnect the internet uplink while leaving the facility router/LAN and Main Computer on. The facility operator performs this step.
4. Sign in locally from each workstation. Perform one uniquely identified agreed cash transaction on test stock; record receipt ID and expected stock. Verify supported patient/claim test records separately if included in scope.
5. Confirm local receipts and stock are correct and saved work is queued. Record failures without deleting or resetting queues.
6. Restore internet. Allow normal automatic synchronization first, without clicking Sync Now. Record completion time and pending/failed counts.
7. Verify each receipt and supported record in the cloud by ID. Compare totals and local/cloud stock against the baseline minus the test quantities.
8. Wait for another automatic sync cycle. Verify counts and stock remain unchanged: no duplicate receipts or repeated stock deductions.
9. Record each workstation as pass/fail, with evidence. Investigate any mismatch before rollout. Follow the agreed test-data cleanup procedure; do not silently delete financial history.

Pass requires every planned workstation and workflow to pass. Capture cloud acknowledgement-loss/retry idempotency in a separate controlled test if needed; the local simulation does not establish it.

## Current blockers

The standard HealthFlowOfflineServer Windows service was not found in this workspace environment. The facility/Main Computer and a test branch have not yet been identified. No real internet connection was disabled. No installer was deployed. Nothing pushed.
