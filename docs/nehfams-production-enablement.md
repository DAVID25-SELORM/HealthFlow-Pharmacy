# NeHFAMS production enablement: one approved facility at a time

Status: **prepared, not applied, not deployed, not activated.** Branch `feat/nehfams-production-single-facility`. No attendance has been requested through the NeHFAMS API by anyone. The only NHIA call made while preparing this was a read-only `hpinfo` for one facility (see `docs/nehfams-test-integration.md`).

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
Not verified: the edge function under Deno (syntax and type check of the shared modules only), behavior against NHIA's attendance route (no attendance has been requested), the admin screen.

## Not yet done in this branch

- **Admin screen and claim form wiring.** An automated permission check refused these edits, so they are not in the branch. Without them an administrator cannot press "enable production" in the browser and the claim form's Generate button stays disabled for production. The two edits are small: (1) in `src/components/CccIntegrationSettings.jsx` add a `production_configured` status label and, for `form.environment==='production'`, a button calling `connectionAction('activate_nehfams_production')` enabled only when the connection is validated, `data.nehfamsProductionEnabled` is true and `data.nehfamsProductionApproval.remaining > 0`; (2) in `src/pages/Nhis.jsx` treat `cccPolicy.status` of `production_configured` like `test_configured` in `canGenerateNhiaCcCode`. The backend already returns `nehfamsProductionEnabled` and `nehfamsProductionApproval`.
- Updating the protected-file baseline manifest for `tier-access/index.ts` (it already fails on `main`).

## Runbook for the first real attendance (do each step only when you have decided to)

1. **Authorization.** Get NHIA's written confirmation that this facility may generate through the NeHFAMS API in production, and answers to: do `StatusCode=1` / HTTP 400 mean no attendance was created; what a repeated request returns. Keep the reference.
2. **Review and merge** this branch, then apply `20261022090000_nehfams_production_single_facility.sql` (and the earlier NeHFAMS migrations if not yet applied) in the Supabase SQL editor, after diffing the live `reserve_ccc_attendance` and `save_ccc_policy` bodies against the repository.
3. **Deploy** `tier-access` from a clean checkout. Do **not** set `NEHFAMS_PRODUCTION_ATTENDANCE_ENABLED` yet.
4. **Configure and validate** the facility's production connection (API key and secret, expected HPN and exact facility name) in CCC settings; press **Validate saved connection**. It must show the expected mode and OTAC state.
5. **Approve** (as the platform owner, in the SQL editor; replace the placeholders; limit 1 for the first run):
   `select approve_nehfams_production('<facility uuid>', '<your user uuid>', '<NHIA authorization reference>', 1);`
6. **Switch on** the deployment secret `NEHFAMS_PRODUCTION_ATTENDANCE_ENABLED=true`, redeploy if your platform requires it, then **Enable approved production attendance** (after the UI wiring above exists, or call the `activate_nehfams_production` action).
7. **Generate exactly one CCC** for one real patient who is present. If NHIA currently requires an OTAC, the patient provides the four-digit code. Do not retry anything that looks uncertain.
8. **Verify** against the portal's Daily Attendance List: the attendance exists, its CCC equals the one HealthFlow stored (leading zeros kept), and exactly one row was created. Confirm the ledger row is `succeeded`, `environment=production`, and the claim is linked.
9. **Close the window.** The allowance of 1 is now used up. To stop immediately at any time: unset the deployment secret, or `select revoke_nehfams_production('<facility uuid>', '<your user uuid>');`. To return the facility to the existing provider, use CCC settings or `save_ccc_policy` with `existing` (requires no unresolved requests).
10. Only after reviewing the real response against the parser (field names, dates, `newCCC`, error behavior) raise the limit with a new approval, or approve further facilities one at a time.

## Rollback

Unset `NEHFAMS_PRODUCTION_ATTENDANCE_ENABLED` (instant), then revoke the approval, then switch the facility back to the existing provider. None of these touches the legacy provider's configuration, which this change does not modify.
