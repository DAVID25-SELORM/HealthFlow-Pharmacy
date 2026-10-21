# NeHFAMS production enablement: one approved facility at a time

Status: **migrations and backend/frontend deployed on 2026-10-21; Ayisam approval recorded with limit 1; Ayisam connection validated and activated.** Branch `feat/nehfams-production-single-facility`. No NeHFAMS attendance request is recorded in this implementation work. The only NHIA call made while preparing this was a read-only `hpinfo` for one facility (see `docs/nehfams-test-integration.md`).

## What this change adds

A facility can generate CCCs through NeHFAMS in production only when **all** of the following are true. Removing any one of them stops generation.

| Safeguard | Where | Effect |
|---|---|---|
| Deployment switch `NEHFAMS_PRODUCTION_ATTENDANCE_ENABLED=true` | edge function secret | Kill switch. Unset it and production generation stops for every facility immediately, independent of the database. Separate from `NEHFAMS_TEST_ATTENDANCE_ENABLED`; neither enables the other. |
| Per-facility approval with an NHIA authorization reference and a hard attendance limit (1-100, default 1) | table `nehfams_production_approval` | A trigger on `organization_ccc_policy` rejects enabling production NeHFAMS for a facility without an unrevoked approval that still has allowance left. |
| Validated production connection | `organization_nehfams_connection` | `hpinfo` must have been validated for the current credential version within 24 hours; changing credentials disables the policy. |
| Fresh facility settings before every attendance | `cccProvider.ts` | OTAC and authentication mode are read from NHIA each time, so rollout toggles are honoured. A failed or mismatching read sends no attendance. |
| Allowance consumed atomically | `reserve_ccc_attendance` | Each new production reservation uses one approved attendance in the same transaction. A rolled-back reservation does not use it; concurrent reservations cannot exceed it; a cached repeat does not use it. |
| Existing guarantees | unchanged | One call, no retry, no fallback to another provider, uncertain outcomes stay unresolved, claim linkage checks tenant/branch/member/date/CCC/environment. |

Approving, activating and revoking are platform-administrator-only and service-role-only. Approval is deliberately **not** in the browser UI: it is a database action performed by the platform owner.

## Verification performed (isolated PostgreSQL 17.6, no network, synthetic data)

`scripts/verify-nehfams-postgres-production.py`, 10 checks passed: no route enables production without approval; approval needs an administrator, an NHIA reference and a limit of 1-100 and is audited; activation needs a validated production connection; limit of 1 allows one new reservation, serves repeats from cache and refuses the next member; re-approval resets the allowance, a rolled-back reservation does not consume it; two independent sessions cannot exceed the limit (the second waited on the lock, then was refused); revocation disables generation at once and blocks reactivation; an unapproved facility cannot enable production; switching back to the existing provider still works; `anon` and `authenticated` roles cannot approve, activate, revoke or read approvals.
The original `scripts/verify-nehfams-postgres.py` still passes 7 of 7 against all four migrations.
JavaScript: 57 tests in the provider and adapter suites pass, including that production is allowed only with its own switch, goes only to `https://nehfams.nhia.gov.gh`, is labelled `production`, and never reaches the attendance route when NHIA now requires an OTAC that was not supplied.
Not verified: the edge function under Deno (syntax and type check of the shared modules only), behavior against NHIA's attendance route (no attendance has been requested), and the deployed admin screen.

## Current readiness (reviewed 2026-10-21)

Local recheck: 71 tests passed across five files (provider, request, connection, settings component and no-implicit-generation contract) using Vitest process workers. The first thread-worker run passed 63 tests but failed to start the settings worker; it is not counted as a successful run. These are local mocked checks, not live attendance verification.

The administrator activation control and claim-form production status support are implemented in commit 1ca0fa89. They still require validated credentials, the deployment switch and an approved remaining allowance. The earlier note that these UI edits were absent is obsolete.

The CI dependency installation is separately prepared in b00fba55 on fix/ci-install-branch-server. Keep CI repairs separate from facility activation. Main's historical branch test fixture must use the cloud-history import path; the corrected fixture is already in this integration branch. Neither CI success nor the read-only hpinfo response proves attendance generation succeeds.

Remaining rollout work: review the full migration chain against the target schema, verify CI on its actual Node version, deploy only with explicit authorization, configure the selected facility, then conduct one explicitly approved production attendance with a limit of one. The legacy provider must remain available for other facilities. Do not replay an uncertain attendance.

## Runbook for the first real attendance (do each step only when you have decided to)

1. **Authorization.** Get NHIA's written confirmation that this facility may generate through the NeHFAMS API in production, and answers to: do `StatusCode=1` / HTTP 400 mean no attendance was created; what a repeated request returns. Keep the reference.
2. **Review and merge** this branch, then apply `20261022090000_nehfams_production_single_facility.sql` (and the earlier NeHFAMS migrations if not yet applied) in the Supabase SQL editor, after diffing the live `reserve_ccc_attendance` and `save_ccc_policy` bodies against the repository.
3. **Deploy** `tier-access` from a clean checkout. Do **not** set `NEHFAMS_PRODUCTION_ATTENDANCE_ENABLED` yet.
4. **Configure and validate** the facility's production connection (API key and secret, expected HPN and exact facility name) in CCC settings; press **Validate saved connection**. It must show the expected mode and OTAC state.
5. **Approve** (as the platform owner, in the SQL editor; replace the placeholders; limit 1 for the first run):
   `select approve_nehfams_production('<facility uuid>', '<your user uuid>', '<NHIA authorization reference>', 1);`
6. **Switch on** the deployment secret `NEHFAMS_PRODUCTION_ATTENDANCE_ENABLED=true`, redeploy if your platform requires it, then **Enable approved production attendance** (or call the `activate_nehfams_production` action).
7. **Generate exactly one CCC** for one real patient who is present. If NHIA currently requires an OTAC, the patient provides the four-digit code. Do not retry anything that looks uncertain.
8. **Verify** against the portal's Daily Attendance List: the attendance exists, its CCC equals the one HealthFlow stored (leading zeros kept), and exactly one row was created. Confirm the ledger row is `succeeded`, `environment=production`, and the claim is linked.
9. **Close the window.** The allowance of 1 is now used up. To stop immediately at any time: unset the deployment secret, or `select revoke_nehfams_production('<facility uuid>', '<your user uuid>');`. To return the facility to the existing provider, use CCC settings or `save_ccc_policy` with `existing` (requires no unresolved requests).
10. Only after reviewing the real response against the parser (field names, dates, `newCCC`, error behavior) raise the limit with a new approval, or approve further facilities one at a time.

## Rollback

Unset `NEHFAMS_PRODUCTION_ATTENDANCE_ENABLED` (instant), then revoke the approval, then switch the facility back to the existing provider. None of these touches the legacy provider's configuration, which this change does not modify.


## Rollout execution â€” 2026-10-21

- Applied migrations 20261021090000 and 20261022090000 atomically after comparing live reservation/policy functions; recorded both in migration history.
- Deployed tier-access to bcvmiwmhtvtqrvzdovin.
- Promoted commit 1ca0fa89 using production environment build; Vercel deployment 9FEgE7ffqxe9CjxTKhTBwDLaYg5G is Ready and assigned healthflowcloud.com. Git main remains dc37269b; avoid deploying old main over this release.
- Verified user reconciliation of Ayisam legacy timeout request: not_created.
- Recorded Ayisam-only approval, limit 1, referencing user-confirmed NHIA authorization. No attendance created by this rollout yet.
- Tests: 71 focused tests plus 308 additional tests passed; production build passed; isolated PostgreSQL production and reservation checks passed. Initial PostgreSQL attempt occurred before startup completed; rerun passed after readiness.
- Ayisam connection credentials absent; user asked to enter them securely in Tenant Admin. Validation, deployment switch, activation and first attendance remain pending.

### Activation completed
- User saved Ayisam credentials through Tenant Admin. Backend hpinfo validation confirmed HPN 15115, AYISAM T CHEMIST LTD, 1FA, OTAC not required.
- Set NEHFAMS_PRODUCTION_ATTENDANCE_ENABLED=true and activated only Ayisam using the existing platform administrator identity.
- Database verification: provider=nehfams, environment=production, enabled=true, limit=1, used=0.
- No attendance creation was performed during activation. First real CCC response and ledger/claim persistence remain to be verified.

### Routine production rollout — 2026-10-21
User authorized routine production for Ayisam and administrator-controlled activation for other organizations. Migration 20261023090000 adds an explicit routine_enabled approval flag (default false); activation validates the connection and rejects unresolved records atomically. Existing usage counters are preserved. Reservation limits continue for limited approvals; routine approvals retain duplicate/branch/tenant checks and revocation. Other organizations are not automatically switched.
PostgreSQL 17.6 disposable verification passed all baseline checks plus routine permission, cap removal, usage preservation, duplicate reuse, isolation, revocation and failed-activation rollback checks. Focused provider/adapter tests: 67 passed. Production build passed. Migration and tier-access deployed; Ayisam verified enabled with routine_enabled=true and usage preserved at 3. No attendance created during rollout.
Rollback: revoke routine facility approval using revoke_nehfams_production; reconcile unresolved requests before switching providers. Do not restore capped SQL while leaving routine approvals active. Frontend publication tracked separately.

Frontend production deployment 3BRzqfzeSErGgffWqjYwnZLgq8BZ (commit 26ac4faa) verified Ready on healthflowcloud.com. Branch pushed; main remains unchanged. TypeScript no-emit check passed. Exactly one facility has routine approval (Ayisam); no other organization was activated.

### Daily operation and claim linkage follow-up
Removed the age-only reservation/backend block for previously validated, unchanged credential versions. Each attendance still performs fresh read-only NHIA facility validation before POST; failures send no attendance. Initial activation still requires recent validation. Public connection state now reflects validated version rather than a daily expiry.
Fixed member changes retaining a previous attendance ledger ID, and explicit clearing now writes null to the claim payload. Synthetic claim mapping tests and PostgreSQL linkage safeguards cover persistence; no real patient claim is fabricated for verification.
Added the reviewed branch-package CI installation from b00fba55. Updated protected fingerprints for nhisService.js (ledger mapping) and tier-access (routine activation) with their regression coverage. This change is intended to fast-forward main so older main cannot replace the deployed frontend.
