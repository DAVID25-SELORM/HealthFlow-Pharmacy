> **CORRECTED 2026-09-21.** This report assumed the genuine May Claim-IT file was the
> compatibility target. The successful West Point June HealthFlow export (accepted by
> Claim-IT) proves that null signers, `claimType` at position 75, no `cpuType`, populated
> `servVersion`, and populated validation sections are accepted behavior. Sections below
> that mandate May parity (signer gating, claimType order, cpuType, servVersion null,
> submission trigger) are superseded by `claimit-june-baseline-2026-09-21.md`, which also
> records the KEEP/MODIFY/REMOVE audit. The July file analyzed here is HEALTH LIGHT LTD
> (provider 030509386), not West Point.

# Claim-IT compatibility implementation and deployment status

Latest continuation and rollout/access evidence are recorded at the end of this
file and in `claimit-rollout-runbook.md`. Earlier verification counts below are
historical runs, not cumulative results.

This is a prepared implementation, not a production deployment. The linked
Supabase account rejected a read-only count query with HTTP 403 (insufficient
Management API privileges). No production schema, claim, financial row, or export
artifact was modified. The full requested definition of done is therefore not met.

## Evidence and root causes

The genuine May and application July CXFs were read directly from Downloads.
Neither source file nor its patient/attachment data was committed. The checked-in
May contract contains schema, key order, counts, and application-version metadata.

| Check | May reference | July regression |
| --- | --- | --- |
| Claims scanned | 17 | 1 |
| Claims missing signing metadata | 0 | 1 |
| Medicine/service/claim/summary reconciliation failures | 0 | 0 |
| Attachment records / orphan references / missing data | 17 / 0 / 0 | 1 / 0 / 0 |
| Service version | null | 2023-02-01.250531 |
| CPU metadata | x64 | missing |
| Accreditation anomalies | none | generated date in future and equal to expiry |

The exporter unconditionally emitted VALID and explicitly null signing fields.
The export payload defaulted a service version globally before checking whether
the individual claim contained services. Claim type appeared last in both the row
and schema. CPU metadata was missing. Totals used Number accumulation and toFixed.

The current accreditation generated-date getter already reads a separate stored
field and does not fall back to expiry. A historical migration identifies its
meaning as the original external accreditation record's generation date. The
July anomaly is confirmed, but its original data-entry/import cause cannot be
established without authorized production/source-record access. No replacement
date has been guessed. A separate exporter bug guessed expiry from effective date
(or 2099); that fallback has been removed.

## Changed implementation

- `src/claimit/compatibility.js`: 76-field canonical claim order, compatibility
  profile, strict field mapping, exact base-ten amounts, signature and date checks.
- `src/claimit/fieldOrder.js`: reference-derived ordering of all schema tables,
  exported sections, populated rows, metadata, accreditation, and app metadata.
- `src/claimit/may-reference-contract.json`: independent non-patient reference.
- `src/services/nhisService.js`: canonical serialization, stored signing metadata,
  per-claim service version, exact sums, no guessed expiry, authoritative cloud
  export snapshots, export audit before download, controlled re-export reason.
  Also fixes the existing failing pagination error/cancellation/search tests.
- `src/services/claimitLifecycleService.js`: signing, bounded audit, deterministic
  total reconciliation, server export readiness, artifact SHA-256 recording.
- `src/components/ClaimItRemediation.jsx` and `src/pages/Nhis.jsx`: privileged
  review panel, dry-run before persisting flags, date/issue filters, review-and-sign
  action, safe reconciliation action, re-export reason input. Existing unrelated
  user edits in the page and test files have been retained.
- `src/pages/nhisPaginationLayout.test.js`: updated its existing alert contract to
  inspect the already-extracted component instead of expecting inline page markup.
- `scripts/lib/cxf-reader.mjs` and `scripts/compare-cxf.mjs`: byte-correct PHP/CXF
  parser and semantic comparison. Reports structure, schema, ordering, types,
  nullability, versions, signature completeness, totals and attachment references
  without logging patient values or attachments.
- `docs/diagnostics/claimit-legacy-dry-run.sql`: read-only aggregate production audit.

Migration: `supabase/migrations/20260920120000_claimit_signing_and_export_gate.sql`.
It adds immutable signature and export-event tables, a remediation queue, RPCs,
RLS, parent locking for line mutations, and a submission transition guard.
The existing September 18 correction migration is not changed by this work.

## Signing, validation, and repairs

Served remains a dispensing state. VALID is an immutable signed revision of the
claim, represented by `nhis_claim_signatures`, with non-null actor/name/role/time
constraints. The signing RPC derives identity from the authenticated active
same-tenant user, validates the claim, and records validation/signing events in one
transaction. Clinical changes make the stored fingerprint stale. Direct writes to
signature/event/remediation tables are revoked. Submission and settlement status
transitions require a current signature; inserted pre-submitted claims are rejected.

Export checks include eligible lifecycle, current signature, member identifier,
CCC presence, service dates, medicine/service codes, required duration, exact
line-price multiplication, total reconciliation, supported service tariff,
provider/credential configuration, accreditation dates, prescription reference
for pharmacy profiles, and an explicit reason for prior submissions/exports.
The client serializes authoritative rows fetched by RPC, not cached readiness
rows. Recording the artifact rechecks fingerprints before release.

Service rule: only `PVT-PHC-CE` claims with zero service lines force servVersion
to null. Service-bearing claims retain the configured tariff version (default
2023-02-01.250531); other provider contexts retain configured behavior. Mixed
metadata preserves null alongside populated service versions.

Legacy signer backfill: none. General audit logs accept caller-supplied event
names/details and contain no verified signing snapshot contract. Creators,
updaters, dispensing actors, prescription verifiers and current administrators
are not treated as historical claim signers. Such claims are flagged, and an
authorized person may perform a new review/signing event at the actual current
time. No historical timestamp or identity is fabricated.

Automatic financial repair is deliberately narrow: exact stored line totals can
replace a mismatching header only after a matching dry-run fingerprint, valid
line calculations, positive new-lifecycle creation evidence, no recorded exports,
no payment rows, and an eligible unsubmitted state. Old/new totals and source are
audited. Legacy unknown export history or submitted/paid claims require manual
review. Serializer-only fixes are derived during regeneration; old artifacts are
never overwritten. Repair calls and persisted flags are restartable/idempotent.

## Production audit and rollout

Production scanned / unchanged / manual review / errors: **not available** due
to access denial. Production automatically repaired: **0**. Production signer
fields backfilled: **none**. The file audit above must not be mistaken for a
database-wide audit. The July source requires manual signer and accreditation
review; it cannot yet be safely regenerated as a production export.

Before deployment, run the counts-only dry-run SQL with authorized database access
and review an actual backup/snapshot. Apply the new migration only through the
normal explicitly authorized deployment workflow, then deploy matching client
code. Use Preview audit and Save review flags in batches; review underlying
claims before signing. Re-export through the new serializer with a reason.

Do not deploy the client ahead of its migration: CXF operations intentionally fail
closed when the signing RPCs are unavailable. Offline/local-only signing and CXF
export are not implemented; these operations currently require cloud access.

## Verification and remaining limits

Focused run: 281 tests passed across compatibility, lifecycle SQL, UI, service
boundary, and existing NHIS service tests. Expanded SQL run: 7 tests passed,
including migration replay, authorization, atomic signing, stale revisions,
re-export evidence, date anomaly rejection and deterministic total repair.
Genuine May fixture parsing ran locally; CI without the source file uses the
non-patient extracted contract and synthetic fixtures, with the genuine-file test
explicitly skipped. `CLAIMIT_MAY_CXF` selects another authorized local fixture.

Lint passed. Production build passed. Migration protection passed (127 migrations).
There is no configured typecheck script or tsconfig for this JavaScript project;
build/lint must not be described as a TypeScript typecheck.

Outstanding review before claiming the entire request complete:

- Authorized production-wide audit, source accreditation investigation, legacy
  remediation, deployment and postdeployment RLS verification.
- Historical signer restoration only if trustworthy immutable evidence is found;
  the current general audit API is insufficient evidence.
- Independent Claim-IT import acceptance for regenerated files and populated
  service/validation serialized-object semantics (May's corresponding rows are empty).
- Expanded clinical/coding policy checks beyond the existing application checks
  and the new database checks, and offline lifecycle parity.
- Export events retain immutable artifact hashes and signatures, not copies of
  artifact bytes. Durable original/corrected artifact storage needs further work.
  The follow-up atomic export-audit migration closes the partial-audit risk for
  artifacts containing up to 10,000 claims (see continuation below).
- The UI is tenant-scoped; cross-facility administration remains unavailable.
  Date/status filters apply server-side; issue/export-state filters apply to the
  displayed batch. A reason can be entered for single-claim or batch re-export.

## Final verification results

- Full suite: **177 files / 1,184 tests passed**, using
  `npm test -- --silent --reporter=dot --testTimeout=30000`.
  The original five-second run had two native/hash test timeouts, an outdated
  alert-layout assertion, and five pagination failures. Pagination and the
  extracted-component assertion were corrected; the timeout-sensitive tests also
  passed independently. The final run increased only the command-line timeout.
- After the last profile/order consolidation and two additional populated-service
  and invalid-export tests: **270 tests passed** in the serializer/NHIS suites.
- Latest SQL/lifecycle, remediation UI, RPC boundary and pagination-layout run:
  **26 tests passed**. SQL fixture migrations were applied twice. This is local
  database/authorization verification, not production RLS verification.
- Latest lint: passed. Latest production build: passed (2,044 modules).
- Migration protection: passed for 127 migrations. `git diff --check`: passed.
- Typecheck: not configured; no separate typecheck result is claimed.
- Production deployment/migration: **not performed**.
- Production audit/backfill: **blocked by HTTP 403**, zero production repairs.

The full suite completed while final focused refinements were being made; the
affected suites were rerun after those refinements as described above. Do not add
the overlapping test counts together.

## Continuation: atomic export audit

Added `20260920130000_atomic_claimit_export_audit.sql`, leaving the original
signing migration unchanged. The client now records an entire artifact in one
RPC, while the database validates ordered groups of 500 inside that transaction.
A later group's failure rolls back all earlier events. Duplicate/null IDs and
artifacts exceeding 10,000 claims are rejected; the client checks batch shape
before fetching authoritative claim data. Readiness retrieval remains batched.

Updated `src/services/claimitLifecycleService.js` and its tests; added
`src/claimit/exportAtomicSql.test.js`. A 501-claim last-chunk failure test verifies
zero committed events, followed by a successful ordered commit. Migration replay
is covered. This wrapper test isolates transaction behavior; the existing lifecycle
SQL suite verifies the inner RPC's signing, tenant, readiness and fingerprint rules.

Final continuation verification: 14 tests passed across three files, lint/build
passed, and migration protection passed for 128 migrations. Client boundary cases
include duplicate IDs, empty/excessive batches, and a single atomic RPC for 501
claims. The earlier full-suite result is not a new full-suite run.

The counts-only production audit was retried and again rejected with HTTP 403.
Production scanned/flagged counts remain unavailable; production repairs remain
zero. Neither migration has been deployed by this session. Deploy both migrations
before the matching client. The outstanding work listed above remains open.

## Continuation: rollout safeguards and access diagnosis

Added `scripts/claimit-rollout.mjs`, its tested core and runner tests, and
`docs/claimit-rollout-runbook.md`. The runner supplies bounded tenant-scoped
dry-runs, counts and reviewed-preview staging repairs. Exact target checks,
fresh fingerprints, immutable report filenames, no signer calls, no secret/body
logging, and an explicit production-write lock are enforced. Repairable and
manual-review counts may overlap; total repair does not restore missing clinical
evidence. All in-scope organizations must be audited separately.

The locally prepared base migration now also rejects nullable-role authorization,
reports safe repair candidates, mirrors existing surname/folder/prescribing
facility/prescriber/instruction blockers, validates diagnosis structure, and
rejects unsupported ownership/catering mappings rather than labelling every
provider PVT/CE. Export fingerprints now bind provider configuration as well as
the claim revision, detecting configuration changes during serialization.
Signing fingerprints remain clinical-revision evidence. The remediation UI offers
automatic reconciliation only when the database explicitly marks the row safe.
The counts-only inventory now detects null totals/prices/quantities/versions.

These migrations have not been deployed by this session. If another operator has
already applied the earlier draft, do not edit deployed history: reconcile the
actual migration history and create a reviewed forward migration for these changes.

Added TypeScript tooling, a whole-frontend `typecheck` command, and a separate
`typecheck:claimit` for compatibility/order/rollout-core modules. The focused check
passes; it is not a substitute for whole-application typechecking. The whole
frontend check currently reports 407 diagnostics across the application and its
imports (including imported branch-server modules). No diagnostics were suppressed.
Edge Functions and the complete branch server are not typechecked by these commands.
This is a local completion blocker. Existing standalone SQL fixtures now also run
through `src/claimit/projectSql.test.js`: all three pass in separate PGlite databases.

The protected exporter hash was updated only for this authorized change, with
characterization tests and this impact report. Other pending baseline entries and
unrelated user edits were preserved. `protect:baseline` and migration protection
(128 migrations) pass. No deployed baseline or production system was changed.

Read-only CLI evidence: linked and expected production refs both equal
`bcvmiwmhtvtqrvzdovin`. Project listing succeeds but exposes only Yingoh; organization
listing exposes only Gabion Selorm, not HealthFlow's cached organization. The
credential is accepted but lacks effective HealthFlow access. The failing Create
login role endpoint requires Database read-write; owner membership/token scopes
must be checked. Token-owner email cannot be determined from those lists.
Relinking the same ref cannot supply missing permissions. Staging is unidentified.
The runbook provides exact dashboard location and staging link command.

No production counts were obtained, no historical fields were backfilled, and
no production claims or schema were changed. Do not interpret unavailable counts
as zero scanned claims or zero anomalies. Actual automatic production repairs: 0.

Latest full-suite run: **179 files / 1,195 tests passed** (603 seconds), command
`npm test -- --silent --reporter=dot --testTimeout=30000`. The three existing SQL
fixture tests were added after that run started and passed separately. The final
focused run passed **7 files / 36 tests**, covering them and the latest Claim-IT changes; counts overlap and must
not be added together as a claimed single run. Lint, focused typecheck, migration
protection and protected baseline pass. Whole-application typecheck: **FAILED,
407 diagnostics**. No blanket suppressions or exclusions of failing application
files were introduced.
Final production build passed (2,044 modules); this produced local build output
only and did not publish or deploy the application.

Docker is present and responds, but `supabase start` did not finish during the
local attempt and was explicitly stopped. No running Supabase containers were
left by the attempt. Full-schema local Supabase/hosted RLS validation is therefore
**not verified**, despite the passing isolated SQL tests. The first tracked
migration already references pre-existing organizations/branches, so a complete
baseline schema must also be accounted for before a clean full-history rehearsal.

Status: LOCAL incomplete (whole-app typecheck and full-schema rehearsal remain
open, along with the semantic limitations above); STAGING blocked (no identified
authorized staging target); PRODUCTION blocked (staging has not passed, production
403 remains, audit and backup/restore evidence unavailable). Production migrations,
repairs, reconciliation and smoke tests have not been performed.

## Review-branch handoff (2026-09-21)

User requested a push. The task is being handed off on the separate
`codex/claimit-local-rollout` branch, not merged into main or deployed. Unrelated
workspace changes are excluded; selected Claim-IT hunks in the shared NHIS page
are staged independently. Earlier full-suite results describe the working tree
at those times, not a claim that the exact isolated commit passed all gates.

Additional typecheck cleanup: explicit optional UI props and tuple types,
typed receipt props, structured Error metadata, promise normalization, cancellation
before `maybeSingle`, a string draft-recovery key, corrected async import return
documentation, and exact-decimal positive-summary checks. No broad `any` casts or
typecheck suppressions were added. Whole-application typechecking still fails;
407 was the initial count, not a verified final count after these partial fixes.
The latest Claim-IT focused run passes 36 tests. Deployment remains blocked by
the incomplete local gates and the staging/production access conditions above.

### Subsequent local verification, 2026-09-21

This update supersedes the earlier typecheck-failure status above. Full frontend
typechecking now passes with zero diagnostics, with no blanket suppressions or
exclusion of failing application files. Lint, scoped Claim-IT typecheck, build,
128-migration protection and the protected baseline check also pass. The final
full regression run passed 1,200 tests across 180 files with exit 0, using the
thread pool with two workers and a 30-second test timeout. Its saved local report
is `output/verification/local-regression.json`. Results describe the working tree;
the latest typing cleanup is included in the review-branch handoff below.

The tariff prerequisite is resolved: its original schema was recovered from
Git commit `6f3ef88`, and the existing supplied tariff seed loaded all 617 codes
in the disposable database. The resumed schema replay now reaches both Claim-IT
migrations after restoring the documented legacy prerequisites and correcting
the accreditation migration's text-replacement defect. See the rollout runbook
for the limits of this empty-database evidence.
Staging access/reference and production
authorization checks remain unsatisfied; no hosted migration or remediation has
been performed. The genuine May reference was re-audited successfully (17 claims,
17 attachments, no finance or attachment reconciliation issues).

### Final review-branch verification, 2026-09-21

After the accreditation fix, the full working-tree suite passed **1,201 tests
across 181 files**, with zero failures or pending tests. The saved report is
`output/verification/final-claimit-regression.json`. Full/scoped typecheck, lint,
build (2,044 modules), migration protection and baseline verification passed.
Task changes are selectively committed for the review branch; unrelated working
changes remain excluded. This is not an isolated-commit full-suite result.

LOCAL: the reviewed fixes and available checks are finished, but full production
readiness remains incomplete: durable artifact storage, offline lifecycle parity,
and the independent acceptance/semantic limitations documented above remain open.
STAGING: blocked by missing project reference/access and unperformed existing-data
acceptance and recovery checks. PRODUCTION: blocked by staging prerequisites and
the existing access denial; no hosted migrations, repairs or smoke tests occurred.
Do not deploy this client before its matching migrations have passed staging.
