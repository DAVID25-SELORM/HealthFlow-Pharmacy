# NHIS duration integrity reassessment ? 2026-09-13

Production investigation used SELECT queries only. No deployment or production record correction performed. The user subsequently authorized committing and pushing this reviewed change. The database migration remains unapplied.

## Provenance of the 17
Read-only HEALTH LIGHT LTD queries found exactly 17 NULL-duration medicines across 12 served claims, matching the screenshot count and its visible claim numbers. All 17 medicines have positive served quantities and fully_served status. Another 14 missing-duration lines belong to pending_serving claims and are outside this served set. The exact selected export month remains unconfirmed.

| Claim | Missing rows | Created |
|---|---:|---|
| NHIS-000004 | 3 | Aug 3 |
| NHIS-000016 | 1 | Aug 5 |
| NHIS-000107 | 2 | Aug 6 |
| NHIS-000108 | 1 | Aug 6 |
| NHIS-000134 | 1 | Aug 9 |
| NHIS-000179 | 1 | Aug 12 |
| NHIS-000180 | 3 | Aug 12 |
| NHIS-000181 | 1 | Aug 12 |
| NHIS-000222 | 1 | Aug 13 |
| NHIS-000237 | 1 | Aug 13 |
| NHIS-000440 | 1 | Aug 23 |
| NHIS-000441 | 1 | Aug 23 |

All 12 claims have nhis_claim.created and nhis_claim.served_directly audit events. Two initially went to dispensary (000016 and 000134) before direct serving. Fifteen medicine rows predate strict duration entry validation (repository commit 51f8650, Aug 21); two postdate it. No app_version/source is recorded in the inspected events, so exact deployed client versions cannot be established. The Aug 23 direct-serve events listed only prescription attachment as incomplete, omitting duration.

Five affected rows across four claims (000016, 000107, 000108, 000134) have subsequent privileged medicine corrections. This establishes editing, not that editing erased a previously valid duration. The before/after duration query could not be completed after browser connection timed out. No positive import/offline/backfill provenance was established. These categories must remain unknown rather than assigning zero as proof of absence. There is no evidence that these are September-created claims.

## Root cause and current bypasses
Current create service previously skipped validation with allowIncompleteReview/reviewOnly. Update skipped it entirely for medicinesOnly, and accepted unchanged invalid historical values via sourceMedicineId. Direct-serve SQL did not check duration. Offline repository had CCC but no duration validation. Live trigger inspection found no duration-referencing trigger on the claim or medicine tables. Together these are current integrity gaps, regardless of the age of the 17 records.

## Canonical field and persistence
Canonical field: public.nhis_claim_medicines.duration (text).
UI medForm.duration -> claimMedicines[].duration -> toNhisClaimMedicineRows -> duration -> insert/serve/correction RPC -> same database column -> nested nhis_claim_medicines selection -> export analyzer.
The UI previously converted valid weeks/months to days before saving. It now preserves the entered value. The existing RPC mappings carry duration, but omitted fields became NULL during delete/recreate. Prospective database enforcement rejects that loss outside incomplete Draft.
Cloud snapshot uses nhis_claim_medicines (*) -> importOfflineRecords stores complete JSON -> local edit/save -> outbox record JSON -> syncRecordUpsert -> branch_sync_upsert_nhis_claim_with_serving_metadata -> duration column. No duration-field omission was found in this mapping. Live cloud sync was not exercised because production writes were prohibited.

## Local changes
- Shared duration validator protects service create/update, offline saves and offline serving queue. Incomplete non-serving Draft can retain missing values. Review-only flags, medicinesOnly and unchanged legacy values cannot bypass progression validation.
- New migration adds parent locking and deferred final-state validation for claim/medicine writes, covering direct serve, correction and sync replacement through their common tables. Existing data is not rewritten. Historical invalid non-Draft claims must be corrected before subsequent writes. The migration remains unapplied.
- Clinical 2 weeks remains 2 weeks. CLAIM-it normalizes it to 14 days in its output only. Bare numbers and malformed values require explicit prescription review; no automatic clinical repair.
- Final export review now distinguishes valid clinical durations, export normalizations (subset of valid; no record changes), reviewed corrections ready, and missing/ambiguous durations. Arbitrary 30/60/90/180-day buttons removed. No unsupported historical-origin inference appears in the UI.
- Existing audited manual day correction RPC and all-or-nothing export checks retained. Valid durations never enter repairRows.

## Verification and limitations
PGlite executes the new migration and verifies Draft exceptions, failed progression/served quantities, persistence after unrelated updates, and atomic rejection of invalid row replacement. Shared validator tests cover NULL/empty/whitespace/bare/malformed values. Real temporary SQLite repository tests cover cloud snapshot import, local edit, outbox preservation and rejected invalid save. Service tests cover bypass flags, legacy edit bypass, dispensing save rejection and non-mutating clinical-to-CXF normalization. UI contract verifies shortcuts are absent.
Full suite run: 1065 passed, one obsolete shortcut assertion failed; assertion corrected; final targeted rerun passed 249 tests across 5 files. Build passed. Final lint, baseline and migration checks passed. Live UI save/serve and full cloud sync were not run. Complete historical causality (whether duration was initially absent versus erased) remains unresolved where snapshots have not been examined.

## Files
src/pages/Nhis.jsx; src/pages/Nhis.css; src/pages/nhisPaginationLayout.test.js; src/services/nhisService.js; src/services/nhisService.test.js; src/services/nhisDurationIntegritySql.test.js; local-branch-server/src/nhisDurationValidation.js; local-branch-server/src/nhisDurationValidation.test.js; local-branch-server/src/offlineRecordsRepository.js; local-branch-server/src/offlineRecordsRepository.test.js; supabase/migrations/20260913160000_enforce_nhis_duration_integrity.sql; config/production-baseline.json; this report.
