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
The whole-application `typecheck` currently fails with 407 diagnostics; this is a
blocking local gate, not waived by the focused check. Imported branch-server
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
requires `public.nhia_tariff_items`; the original tariff table definition/seed
was not found in the repository. Obtain the authoritative schema-only baseline
or original tariff setup before completing this full-schema rehearsal. Do not
substitute a guessed table definition or report this rehearsal as passed.

The latest completed full-app typecheck in this continuation reported 123
diagnostics. This is not a clean
full-app acceptance result. Isolated SQL/CXF tests do not remove either blocker.

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
not authorize deployment or waive the full-app typecheck and schema blockers.

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
