# Claim-IT gated rollout (2026-09-20)

No hosted migration or claim repair has been executed by this work. A local test
result is not staging acceptance, and a file comparison is not a database audit.

## Access diagnosis

- Linked project: `bcvmiwmhtvtqrvzdovin` (HealthFlow Pharmacy).
- Expected production: same ref, independently recorded in `.env` URL host,
  `.github/workflows/production-health.yml`, and `docs/production-baseline-2026-08.md`.
- CLI `projects list` succeeds but returns only `mcbfqgyosdklnzbagobp` (Yingoh).
- CLI `orgs list` succeeds but returns only `oyeakcsadbhfecibtnrd` (Gabion Selorm).
  HealthFlow's cached linked organization is `ftivxjkomsceomatjwki`.
- The current credential is accepted for project/organization listing; it is not
  globally expired or invalid. Its effective access does not include HealthFlow.
- `npx supabase db query --linked "select 1 as access_check"` returns
  `LegacyDbConfigLoginRoleStatusError`, HTTP 403, insufficient endpoint privileges.
  This CLI can exit zero even when its output contains an error: inspect results,
  not just process exit status.
- Account email/user identity cannot be established from these CLI outputs.
  An organization name is not the token owner's identity. Do not infer identity
  from the Windows username or an unrelated application session.
- Membership vs restricted token scope cannot be distinguished with present
  access. An authorized organization owner must check both. Relinking to the same
  production ref will not grant permissions. Do not relink to Yingoh.

Supabase's [permission table](https://supabase.com/docs/guides/platform/personal-access-tokens)
requires **Database read-write** for Create login role (the failing CLI setup
step); read-only query access alone does not grant this. Eventual deployment also
needs the applicable Migrations read-write permission. The token must include
HealthFlow and its owner's role must permit these operations. See
[access control](https://supabase.com/docs/guides/platform/access-control).
Use an account with the required project access, accept any pending invitation,
and run `npx supabase login` privately. Never paste a token or database password
into chat, a command captured in logs, or this repository. Then repeat listing
and the harmless query. Do not disable RLS, switch to service-role credentials,
or change security settings to bypass the 403.

## Obtain staging

No staging project ref was found in the checked repository/configuration, and
the sole accessible unrelated project is not assumed to be staging. In the
Supabase Dashboard, open the intended staging project and copy the ref from
`https://supabase.com/dashboard/project/<PROJECT_REF>` (also Project Settings,
General, Project ID). An owner must provision/identify staging if none exists.

```powershell
npx supabase login
npx supabase link --project-ref <STAGING_PROJECT_REF>
npx supabase migration list --linked
npx supabase db push --linked --dry-run
```

Use a separate staging worktree/configuration so linking staging does not silently
change the production deployment workspace. Review the entire pending list;
`db push` is not restricted to the new Claim-IT migrations. Resolve schema drift
and prerequisites before applying. The prepared Claim-IT migrations, in order:

1. `20260920120000_claimit_signing_and_export_gate.sql`
2. `20260920130000_atomic_claimit_export_audit.sql`

Only after target verification and review, run `npx supabase db push --linked` in
that staging workspace. Record migration SHA-256 hashes and deployed history.

## Staging dry-run and remediation

The runner uses a real active application user's short-lived JWT and the project's
publishable key. The database enforces tenant and role restrictions. Management
API personal access tokens are **not** application JWTs. Supply
`CLAIMIT_SUPABASE_URL`, `CLAIMIT_PUBLISHABLE_KEY`, and `CLAIMIT_USER_ACCESS_TOKEN`
through approved private environment/secret tooling; never embed values in scripts.

```powershell
node scripts/claimit-rollout.mjs audit <STAGING_PROJECT_REF> output/claimit/staging-preview.json
# Review the report and counts before executing this separate command:
node scripts/claimit-rollout.mjs apply-staging <STAGING_PROJECT_REF> output/claimit/staging-preview.json
```

Reports are sensitive operational records even though patient/claim names and
clinical values are omitted. Use a restricted, encrypted folder; `mode: 0600`
does not configure Windows ACLs. Reports never overwrite an existing filename.
The audit covers **only the authenticated user's organization**. Repeat with
authorized actors for every in-scope organization and reconcile organization
coverage against the read-only inventory; never call it a project-wide audit
after scanning just one tenant.

Counts: scanned, repairable, unchanged, manual_review_required, errors.
Repairable and manual review can overlap: a provable header-total repair does
not cure a missing signer or accreditation field. A clean dry-run means complete
coverage, zero errors, and every anomaly reviewed/classified, not invented values
to make all claims pass. The runner stops if pagination/results are incomplete.

Apply requires the same actor/project, a preview under one hour old, and identical
fresh audit rows/fingerprints. The server repeats eligibility checks under lock.
Only positively new, unexported, unpaid claims with valid authoritative lines can
receive total repairs. Unknown historical export history is never proof of safety.
No signer, prescriber, coding, NHIS, accreditation, price, or quantity is inferred.
The runner saves manual-review flags after repairs and produces an `.after.json`
reconciliation. Repairs are per-claim atomic, not one all-project transaction.
If interrupted, previously completed repairs remain audited; run a new dry-run
and inspect before retrying. Never blindly replay a stale report.

For unresolved claims, authorized staff must review original evidence, correct
only substantiated values, and sign anew at the actual current time. This is not
historical signer restoration. Generate CXFs through the application; compare:

```powershell
node scripts/compare-cxf.mjs "<GENUINE_MAY_CXF_PATH>" "<STAGING_GENERATED_CXF_PATH>"
npm test -- --silent --reporter=dot --testTimeout=30000
npm run test:claimit
npm run typecheck
npm run typecheck:claimit
npm run lint
npm run build
npm run protect:migrations
```

Comparison output requires review; differences in legitimate claim counts and
service contexts are not necessarily incompatibilities. Independently import
the staged artifact in Claim-IT before recording acceptance. Test actual hosted
RLS/storage/attachment access and complete migration history, not only PGlite
fixtures. `typecheck:claimit` covers the new compatibility/order and rollout-core
JavaScript modules, **not the entire existing application or Edge Functions**.
The whole-application `typecheck` now passes after the local typing cleanup.
Keep running it as an independent acceptance gate. Imported branch-server
modules are traversed by that check, but it is not a complete branch-server or
Edge Function typecheck. Existing standalone SQL fixtures also run through
`src/claimit/projectSql.test.js` in separate PGlite databases; this does not prove
the complete hosted schema is reproducible from migration history.

## Production gate (not yet satisfied)

### Additional local rehearsal, 2026-09-21

A disposable, network-isolated PostgreSQL 17 container was used with the
repository mounted read-only. No staging or production database was changed.
The legacy base schema, multi-tenant steps, branches, staff privileges, NHIS,
purchases and branch-sync RPC prerequisites were applied. The official Storage
API v1.72.1 tenant migrations were also applied using its supported
`storage.install_roles=false` setting because platform roles already existed.

Tracked migrations succeeded through
`20260618150500_allow_nhis_serving_workflow_statuses.sql`. The next migration,
`20260620120000_enforce_nhis_catalog_pricing.sql`, rolled back because
`public.nhis_claim_services` was absent. Its original legacy creation script
requires `public.nhia_tariff_items`. This prerequisite has now been recovered
from Git history; the tariff was not missing from the user's supplied data.
See the recovery evidence below. Do not describe the full rehearsal as passed.

The subsequent local typing pass resolved all 123 remaining diagnostics:
`npm run typecheck` now exits successfully with zero diagnostics. Lint, scoped
Claim-IT typecheck and build also pass. This does not remove the full-schema
rehearsal blocker or establish staging acceptance.

Verification in this continuation: lint, scoped Claim-IT typecheck, production
build (2,044 modules), and all 36 Claim-IT tests across seven files passed.
The first Claim-IT run had worker-startup timeouts; a single-worker retry passed.
The disposable database container was stopped and retained for resuming the
rehearsal. No database or historical claim data was deleted.

The full regression run completed with 178 passing files and two failing files:
1,196 tests passed; three tests hit the default five-second timeout (two in
`OfflineSync.test.jsx`, one in `nhisDurationIntegritySql.test.js`). The focused
single-worker retry with a 30-second timeout passed all 54 tests across six files,
including the two failing suites and the patient, receivables, receipt and
production-metrics services. Do not describe the original full run as all passing.

Pre-push reconfirmation: 319 targeted tests across 12 files passed, including
Claim-IT, NHIS service, and the changed patient/receipt/receivables/metrics services.
Lint, scoped Claim-IT typecheck and build passed again. The NHIS service protected
hash was refreshed for the reviewed error-metadata and typing cleanup; this does
not authorize deployment or waive rollout gates.

The subsequent typing pass preserves query projections as literal strings,
documents optional form/browser fields, returns void from connectivity cleanup,
and keeps modern/legacy medicine query results separate. Staff fallback checks
use the PostgREST response status rather than nonexistent error properties.
Clinical signing, tenant authorization and historical repair rules are unchanged.
Protected hashes for the NHIS, settings and installer-release services were
updated with this local review. No remote schema or clinical data was changed.
Migration protection passed for all 128 migrations and the working-tree protected
baseline check passed. The genuine May reference was re-read: all 17 claims had
zero finance reconciliation errors and all 17 attachments had no missing data or
orphan references. This reference audit is not a repaired-staging comparison.

The next full fork-pool regression run reported 1,185 passes, one stale source
assertion for the sales click wrapper, and a Reports worker-startup timeout.
The source contract was updated without weakening the explicit-confirmation
gate; its four tests passed on retry. Reports also passed all 14 tests in an
isolated retry. These retries are not an all-passing full run.

The final full thread-pool run passed **1,200 tests across 180 files**, exit 0,
with no failures. Command:
`npm test -- --pool=threads --maxWorkers=2 --testTimeout=30000 --reporter=default --reporter=json --outputFile=output/verification/local-regression.json`.
The saved local JSON report confirms success. Typecheck, lint, scoped typecheck,
build, migration protection and protected baseline were rechecked successfully.
These results describe the current working tree, including preserved pre-existing
changes, not an isolated new commit. The latest typing cleanup remains local.
The full application suite is verified as above; subsequent database replay
results are recorded below. STAGING and PRODUCTION remain blocked as above.

### Tariff provenance recovered, 2026-09-21

The supplied tariff is already in
`20260629160000_private_primary_care_hospital_exclusive_tariff_feb_2023.sql`:
617 G-DRG codes from `Private Primary Care Hospital (Catering Exclusive) Tariff JAN 2023 (1).pdf`,
effective February 2023. The application reads `nhia_tariff_items` and has an
existing fallback to this schedule. This is code/seed evidence, not a new hosted
database read.

Commit `6505aaa` originally added the table setup; commit `0590b62` removed the
old seed files. The last pre-removal revision is
`6f3ef88eb4bb450a7b2c87f027e9b593f4081014`, file
`supabase-claimit-2025-base-data/00-setup-reset-and-versions.sql`.
Its schema section was recovered to `tests/staging/legacy-tariff-schema.sql`.
Whitespace-normalized equivalence against the original was verified. The old
seed DELETE, old tariff prices and version writes were not restored.

In the network-isolated disposable PostgreSQL database, the recovered schema and
existing claim-service schema applied successfully. Tracked migrations then
passed through `20260625110000_add_nhis_total_claim_value.sql`. The next stopped
on missing `sales.branch_id`, an unrelated accounting baseline prerequisite.
Separately, the existing June 29 tariff migration loaded 617 rows/617 distinct
codes successfully (GHS 2.20–2,613.87). This isolated catalog validation was ahead
of the remaining ordered migration replay; it is not full-schema acceptance.
No new tariff upload or user-provided schema is required for the resolved tariff
issue. Do not apply this local rehearsal fixture to production.

### Resumed database replay, 2026-09-21

The empty, network-isolated PostgreSQL rehearsal now reaches and applies
`20260920130000_atomic_claimit_export_audit.sql`, including the preceding
Claim-IT signing gate. Verified: signing/export RPCs and signature table exist,
617 tariff rows remain, and the claim table contains zero rows. This is schema
application evidence, not existing-claim remediation or a hosted acceptance test.

Additional original legacy prerequisites used during the resumed replay:

1. `supabase-migration-accounting.sql`
2. `supabase-patch-shift-system.sql`
3. `supabase-patch-accounting-hardening.sql`
4. `supabase-migration-branch-inventory-transfers.sql`
5. `supabase-patch-organization-type.sql`
6. `supabase-patch-nhis-pharmacy-levels.sql`
7. `supabase-patch-organization-module-privileges.sql`
8. `supabase-patch-commercial-billing-controls.sql`

All are under `supabase/legacy`. They were applied only to the disposable empty
baseline at the relevant dependency failures. Do not run these historical
backfills on production as part of Claim-IT rollout.

Two replay defects were corrected locally:

- The August 11 accreditation migration globally replaced a column-name suffix,
  corrupting its UPDATE assignment. Its replacement now matches INSERT column
  lines only and skips already-updated function definitions on replay. This edits
  historical migration bytes for fresh replay; do not rerun it on production
  merely because the file changed. Inspect hosted migration history/function
  definitions first, and prepare an additive repair only if needed.
- Removed a stray leading slash from the locally edited September 6 learned-dose
  migration comment; the function body and clinical rules were unchanged.

The accreditation regression test checks SQL compilation, repeated application,
and preservation of a stored generated date when an older client omits it.
All 37 Claim-IT tests across eight files passed after this fix, including the new
regression. The final full working-tree run then passed 1,201 tests across 181
files, with zero failed or pending tests. Report:
`output/verification/final-claimit-regression.json`; command:
`npm test -- --pool=threads --maxWorkers=2 --testTimeout=30000 --reporter=json --outputFile=output/verification/final-claimit-regression.json`.
Full and scoped typecheck, lint, build (2,044 modules), 128-migration protection,
and protected baseline checks also passed. These results cover the working tree,
not an isolated checkout of the selectively staged review branch.
Project access was rechecked: the CLI still lists only Yingoh
(`mcbfqgyosdklnzbagobp`), not HealthFlow. Staging reference/access remains absent.
Local verification still does not authorize production: staging existing-data,
security, CXF and recovery checks must pass first.

The runner deliberately rejects production apply. Do not remove that guard merely
because production credentials become available. First complete and retain all
staging acceptance evidence, including offline/clinical/export-artifact limitations
listed in `claimit-compatibility-2026-09-20.md`.

After staging acceptance, use this sequence:

1. Verify expected project ref, authenticated access, and migration history.
2. Before changing schema, execute `docs/diagnostics/claimit-legacy-dry-run.sql`
   through authorized read-only access and report counts/anomalies. This inventory
   is not proof that historical claims are automatically repairable.
3. Protect affected data using the existing strategy in
   `production-baseline-2026-08.md`: record a verified backup/PITR identity,
   retention/recovery window, immutable deployment commit, migration hashes,
   affected rows and audit/export evidence. Restore-test in isolated staging.
   Database backups do not substitute for protecting external artifact bytes.
   The existing August rollback rehearsal explicitly did not verify DB restoration.
4. Apply only migration bytes already accepted on staging; inspect other pending
   migrations instead of deploying them implicitly.
5. Repeat the authenticated per-tenant dry-run against the deployed functions,
   review all counts, then separately authorize execution of the reviewed plan
   under the user's existing conditional production authorization.
6. Deterministic repairs only; flag unsafe claims. Preserve before/after audit
   and original exports. Reconcile every tenant and financial aggregate.
7. Compare regenerated CXFs, re-run regression/security/database tests, and smoke
   test login, tenant isolation, dispensing, reviewed signing, export, re-export,
   submission, payments, and unrelated core application workflows.

Production is not fixed until these steps actually succeed. Credential recovery
alone does not satisfy deployment or remediation.
