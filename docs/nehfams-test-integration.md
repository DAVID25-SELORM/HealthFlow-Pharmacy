# NeHFAMS test integration (local only, not deployed)

Branch `feat/nehfams-connection-preparation`, base `dc37269b`, with uncommitted work. Verified again on 2026-10-20.
The only NHIA request made is one read-only `GET /api/hmis/auth/hpinfo` to the production origin for one facility on 2026-10-20 (section 6). No attendance was requested. No deployment or production migration was made.
Production NeHFAMS attendance remains blocked in three places: the provider gate, the edge function and a database constraint.

Related documents: `docs/nehfams-rollout-audit.md` (earlier audit and prepared test matrix), `docs/nehfams-authorized-test-procedure.md` (operator checklist for the first authorized NHIA test).

## 1. Implemented functionality

- Explicit provider per organization: `existing` (legacy NHIA, unchanged), `otac`, and `nehfams`. No automatic fallback between them.
- NeHFAMS adapter (`_shared/nehfamsAdapter.ts`): documented routes and `x-nhia-apikey` / `x-nhia-apisecret` headers; test origin `https://elig.nhia.gov.gh:5007`, production origin `https://nehfams.nhia.gov.gh` (never used); `redirect: 'error'`, 25 s timeout, one call, no retry; strict response parsing: `StatusCode=0`, 5-digit string `CCC`, 8-digit `UMN`, UUID `AuthID`, boolean `newCCC`, matching `HPName`, and `AttendanceDate` equal to the requested day. Documented field names are matched ignoring case (PascalCase per the workbook, lower-camelCase as NHIA's portal and staff messages show), and `AttendanceDate` may be `YYYY-MM-DD` or the same day at midnight (`T00:00:00`); any other time, any wrong type and any other field name are still rejected.
- **Fresh facility settings per attendance:** before each attendance the provider reads `GET hpinfo` again (read-only) and uses that response, not the saved copy, for the identity check, the authentication mode and whether OTAC is required. NHIA states that OTAC and authentication mode are switched on and off during its rollout. A failed or mismatching lookup, or a missing required OTAC, happens before anything is dispatched, creates no attendance and leaves the request retryable (`not_created`). The claim form always offers the OTAC field for NeHFAMS; only a four-digit code is sent, and only when NHIA currently requires it.
- Connection preparation (`_shared/nehfamsConnection.ts`): per-environment saved credentials, `GET hpinfo` validation, identity (HPN/name) check, supported modes `1FA` and `2FA` with OTAC only; validation is bound to the credential version and lasts 24 hours (a HealthFlow control, not an NHIA lifetime).
- Reservation-first flow (`_shared/cccProvider.ts` + migrations): reserve a ledger row, send once, persist, return. Any ambiguous outcome after dispatch stays `unknown`/`pending` and blocks a second request.
- Database (`20261021090000_nehfams_test_validation_and_linkage.sql`): environment-scoped ledger uniqueness, `nehfams_production_disabled` and `legacy_production_only` constraints, platform-admin-only configuration functions, optional `nhis_claims.ccc_attendance_request_id` with a tenant/branch/member/date/CCC/environment check trigger.
- Test results are labelled `environment=test` and the Generate action does not apply them to the claim form.
- **Added during this verification:** claim saving (`submit_nhis_pharmacy_claim`) no longer auto-generates a CCC when the facility's provider is `nehfams` (see section 7, item 1).

## 2. Tests passed (commands and counts)

All commands run from the repository root with `node node_modules/vitest/vitest.mjs run ...` (the repository's `npm test` / `vitest run`).

| Scope | Result |
|---|---|
| Branch repository and coverage guard: `local-branch-server/src/nhiaRepositoryHospital.test.js`, `offlineRecordsRepository.test.js`, `nhisCccValidation.test.js` | 3 files, 26 passed (12 + 3 + 11) |
| NeHFAMS adapter, connection, SQL (PGlite), credentials, provider, settings UI, NHIS service | 8 files, 325 passed |
| After the claim-save guard: new contract test + provider + adapter + connection | 4 files, 49 passed |
| Full suite (`vitest run`), second run | 1873 passed, 10 failed, 16 skipped of 1899 (failures listed in section 3). The new contract test (2 tests) was added after this run and passed in the targeted run above. |
| TypeScript: `tsc --noEmit --allowJs --strict --noImplicitAny false` on `nehfamsAdapter.ts`, `nehfamsConnection.ts`, `nehfamsCredentials.ts`, `cccProvider.ts` | passed (exit 0) |
| `tier-access/index.ts` | syntax only (TypeScript transpile, 0 diagnostics). Not a Deno type-check: Deno is not installed. |
| `eslint .` | exit 0 |
| `vite build` | succeeded |
| `node scripts/validate-migrations.mjs` | passed, 169 migrations |

Claims from the earlier audit, checked: the fixture change to `importOfflineRecords` is present and `nhisOnlineServing.js` (the coverage guard) is unmodified; the two uncertainty fixes exist in `cccProvider.ts` and each has an explicit test (`marks a cached test result as test even when reconciled result omitted environment`, `retains reconciliation reference when outcome persistence itself throws`). The audit's figure of "20 branch and medication-coverage tests" could not be reproduced as a single number: the two named branch files give 15 passing tests, 26 with the CCC validation suite.

## 3. Tests that failed, and why

Full run: 10 failures, all source-text contract tests, **identical on the clean `dc37269b` worktree** (`D:/APPS/HealthFlow-nehfams-baseline-audit`, 0 changes):
`claimsMobileLayout` (2), `inventoryMobileLayout` (1), `purchasesMobileLayout` (1), `salesMobileLayout` (3), `nhisAssistantServing` (1), `nhisPrescribingProvisioning` (1), `nhisPaginationLayout` (1).
Cause: `core.autocrlf=true` leaves CRLF in the working tree (`git ls-files --eol`: index `lf`, working `crlf`) while these tests search for `\n`. Environmental, not caused by this work, not a NeHFAMS blocker.

First full run also timed out on `cashTopUpDrawerSql` and `nhisDurationIntegritySql` (PGlite start-up exceeded the 5 s limit under load). They passed in the second full run, and both suites pass (13/13) with `--testTimeout=60000` here and on baseline. Timing, not logic.

`node scripts/verify-production-baseline.mjs` fails for `src/services/nhisService.js` and `supabase/functions/tier-access/index.ts`. It also fails on the committed `dc37269b` and on `origin/main`: the protected manifest is stale. Needs a reviewed manifest update; unrelated to NeHFAMS.

## 4. PostgreSQL concurrency and isolation checks performed

Disposable container `hf-nehfams-audit-20261020`, image `public.ecr.aws/supabase/postgres:17.6.1.171` (PostgreSQL 17.6), `--network none`, no published ports, synthetic schema and data, created for this verification and removed afterwards. Independent `psql` sessions were observed waiting on the lock before release.

`scripts/verify-nehfams-postgres.py` (7 PASS): concurrent duplicate reservation blocks then rejects; rolled-back reservation can be retried by the waiting session; injected outcome-write failure leaves a durable pending reservation that blocks duplicates; valid claim linkage accepted and wrong tenant/branch/member/CCC rejected; failed claim save leaves the cached attendance; wrong-tenant and wrong-branch reservations rejected; repeat of the duplicate and rollback scenarios for the NeHFAMS test provider.

`scripts/verify-nehfams-postgres-isolation.py` (new, 6 PASS): `anon` and `authenticated` roles cannot read credentials, the ledger, the policy or the audit table, or call the reservation/configuration functions; production NeHFAMS cannot be enabled by direct write or by the legacy entry point and reservation is refused; stale (>24 h) validation and rotated credentials block generation, and rotation disables the policy; test attendance cannot be linked to a claim; a succeeded test record is not reused as a production attendance for the same member and day; another tenant does not inherit validation, cross-tenant reservations are refused and connections stay per organization.

Not demonstrated: behavior on the full production schema, row-level-security policies of real tables, multi-instance edge-function races, or load. The database proves reservation locking; it does not make the external NHIA call atomic with the database write.

## 5. API behavior verified from documentation only

From the NHIA workbook and the Postman collection: routes, methods, header names, request fields (`CardType`, `CardNo`, conditional four-digit `OTAC`), response fields and the `StatusCode` 0/1 convention, `AuthMode` values `1FA`/`2FA`/`3FA`, `OTACAuthEnabled`, HTTP 200/400/401, the two base URLs. The collection contains no saved responses, so none of the response shapes have been observed. HealthFlow's parser follows the documented PascalCase contract and nothing else.

## 6. API behavior verified against the actual authorized test environment

**One read-only request, on production, for one facility.** On 2026-10-20 at 23:45 UTC, `scripts/nehfams-hpinfo-shape-check.mjs --confirm-production-readonly` made a single `GET https://nehfams.nhia.gov.gh/api/hmis/auth/hpinfo` with the facility's own API account, at the account owner's request. Result, with no values recorded other than the two configuration flags:

- HTTP 200, `application/json`.
- **The field names are lower-camelCase**, not the workbook's PascalCase: `hpn`, `hpName`, `userName`, `deviceType`, `accountType`, `schemeCode`, `userType`, `authMode`, `otacAuthEnabled`. `accountType` is not in the workbook.
- Types: `otacAuthEnabled` is a boolean; the others are strings. The workbook lists `DeviceType`, `SchemeCode` and `UserType` as DATE; they are strings.
- The facility's mode at that time was `1FA` with OTAC disabled, and its facility number and name matched the expected values, so HealthFlow's facility check accepts it.

This confirms the casing risk was real and that the case-insensitive field matching is needed. It says nothing about the attendance response, its date format or its error semantics: **no attendance has been requested through the API.** Nothing here establishes that a live attendance transaction succeeds.

### NHIA guidance from the NHIS Integrations group (WhatsApp; unverified, second-hand)

- A developer reported `authMode` / `otacAuthEnabled` changing between `1FA`/`false` and an OTAC-enabled state for one facility, quoted in lower-camelCase. NHIA (Enoch Affanyi, 25 Sep): switching them on and off is part of the rollout, and implementations must accommodate the settings as they are. This is why the facility settings are now read fresh for every attendance.
- Asked how to handle a facility with OTAC on the phone but not on the API, NHIA said to make sure the **NeHFAMS production API URL** is used. The legacy route in HealthFlow uses a separately configured base URL.
- Claim submission in Claim-IT has no authorisation code; the submitting account must have the insurance officer role (George Amfo).
- A question whether CCCs issued on the test server count for claims was asked on 20 Oct and had no answer in the captured messages. HealthFlow assumes they do not.

### Portal observations (read-only, 2026-10-20; not API verification)

An operator signed in to the NHIA NeHFAMS web portal (`otac.nhia.gov.gh`) and the Daily Attendance List was read. This is a different system from the HMIS API in section 5, so none of this confirms the API's responses. Nothing was generated or submitted.

- Today's attendances created through the legacy HealthFlow route appear with Platform `MobCCC`, Auth. Mode `NONE`, Att. Mode `PRIMARY`, a numeric Att. ID and the API account as App. Client. Attendances created in the web portal appear with Platform `NeHFAMS`, App. Client `NEHFAMSWEB` and a UUID-style Att. ID. The legacy and NeHFAMS identifiers are not interchangeable.
- One member had two attendances on the same day from the two platforms, with **different CCCs**. NHIA does not merge them. If a facility uses both routes (or the portal directly) for one visit, two CCCs exist.
- A repeated same-platform request for that member increased an `Attempts` counter on the existing NeHFAMS row instead of creating a row, and returned the same CCC with `newCCC=false`. This is observed on the web portal only; whether the HMIS API behaves the same is unverified.
- The legacy (`MobCCC`) record carried the card number in the HIN column, while the NeHFAMS record carried a different, real HIN. HealthFlow must not treat a legacy "HIN" as the member's HIN.
- The list is filterable by a single date and shows Card No., HIN, CCC, Att. Type, Auth. Mode, Platform, Att. ID, App. Client, NHIS Status, Start/End Date and Attempts. It is a human-checkable record of what NHIA holds for the facility and can support reconciliation after an uncertain outcome. It is not an API and HealthFlow must not scrape it. Which Platform and App. Client label a HMIS-API-created attendance receives is unknown until the first authorized test.
- The portal's own API serializes attendance dates with a time part and camelCase field names (seen earlier in a portal response), unlike the documented PascalCase `YYYY-MM-DD` HMIS contract. If the HMIS API behaves like the portal, HealthFlow's strict parser will record a real attendance as `unknown`. Confirm with the first read-only call.
- This facility's web attendances showed Auth. Mode `NONE` and no MFA code, consistent with `1FA`; the facility's `AuthMode` in hpinfo is still unconfirmed.

## 7. Remaining risks and limitations

1. **Fixed here:** `submit_nhis_pharmacy_claim` auto-generated a CCC when none was supplied. With the NeHFAMS test provider active it would have created a sandbox attendance and written the test CCC to a production claim row, bypassing the ledger-link check. It now skips generation when the provider is `nehfams`; `src/contracts/nehfamsNoImplicitGeneration.contract.test.js` locks this in (a source-level test, not a behavior test of the Deno function).
2. The `hpinfo` response is confirmed lower-camelCase; the attendance response casing, date serialization, `AttendanceType` values and HTTP-error semantics are still unverified. The parser tolerates documented field names in either case and a midnight timestamp, based on the observed `hpinfo` response and NHIA's portal output, not on an observed attendance response. A format outside that (for example a non-midnight time) still makes a genuinely created attendance appear as `unknown`.
3. HTTP 400, 401 and `StatusCode=1` are all treated as unresolved after dispatch because NHIA documents no no-attendance guarantee. Every rejection therefore needs administrator reconciliation. The legacy provider, by contrast, now treats clear NHIA rejections as retryable. Ask NHIA.
4. For `GHANACARD`, the returned `UMN` is not compared with the requested number (only NHIS cards are cross-checked).
5. A failed repeat validation does not revoke an earlier successful validation until its 24 hours end.
6. The reservation function refuses to reuse an attendance recorded by a different branch of the same facility, even a succeeded one (`Attendance belongs to another branch; reconcile before proceeding`).
7. Manual CCC entry is unlinked by design; nothing technical stops a person typing a test CCC into a production claim.
8. `tier-access` cannot be executed under Deno here. Its authorization checks (organization derived from the authenticated profile, platform-administrator gates) were reviewed by reading, not by an automated test.
9. 3FA and 2FA without OTAC are unsupported. Referrals are unimplemented.
10. The migrations redefine `reserve_ccc_attendance` and `save_ccc_policy`. They must be diffed against the live function bodies before any real database receives them.
11. The protected-file baseline manifest is stale (section 3).

## 8. Steps required before production activation (not before the first test)

1. Complete the authorized test-environment procedure and record the observed contract, including casing, dates, leading zeros, error semantics and duplicate behavior.
2. Resolve the open NHIA questions listed in `docs/nehfams-authorized-test-procedure.md`, especially whether a failed or rejected request can create an attendance and how an uncertain outcome is confirmed.
3. Change the parser only to match observed behavior, with tests.
4. Decide the policy for HTTP 400 and `StatusCode=1` and for revoking validation after a failed re-check.
5. Review the migrations against the live schema and functions; apply to a staging copy first; then a separately approved production migration.
6. Update the protected-file baseline manifest in a reviewed change.
7. Replace the production block (constraint, provider gate, edge function) in a separate, reviewed change; production credentials need NHIA authorization and a facility-specific validation.
8. Keep the legacy provider available and unchanged throughout; roll back by switching the organization's provider back.
