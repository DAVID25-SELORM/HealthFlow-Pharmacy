# NHIS serving and Ayisam setup

## Code change

Apply `supabase/migrations/20261002110000_check_coverage_before_nhis_serving.sql`
through the normal migration deployment. It reuses the existing coverage calculation
when an authenticated cloud session inserts a served medicine or changes its served
quantity, medicine, date, claim or serving status. Both direct serving and the
dispensary replacement RPC pass through this trigger. Failure rolls back the serving
transaction before its inventory effect. It does not depend on CCC matching or an
attached prescription. Existing branch replication remains on its separate protocol;
this migration does not add an offline coverage engine.

Deploy the frontend change to show the inventory policy in the serving review and
explain the accreditation issue-date requirement in the export error.

## Ayisam inventory activation

An Ayisam administrator must open Settings → NHIS Inventory and enable
“Deduct NHIS medicines from stock when served”, then save. This uses the existing
audited activation flow, including its historical served-quantity baseline. Do not
enable the policy across other facilities or retroactively deduct historic claims.
If activation reports an outdated active branch server, update that branch first.
Confirm the setting persists after reload before telling staff it is active.

The existing inventory trigger handles both Serve Directly and dispensary serving.
No stock-policy defaults were changed by this patch. Ayisam's live inventory
deduction was enabled through its administrator session on 2 October 2026 and
verified checked after a settings-page reload. The live direct-serving inventory
trigger was also confirmed installed and enabled.

## Ayisam CXF export

The supplied screenshot reports a missing accreditation generated/issue date.
The user supplied **2026-06-01 (1 June 2026)** as Ayisam's accreditation
generated/issue date. It was saved to the live Accreditation Generated / Issue Date
field on 2 October 2026, together with CLAIM-it CXF Export mode. Both persisted
after reload. The effective date (2026-06-01) and expiry date (2027-06-01) were
unchanged. A completed CXF download has not yet been verified.
Use the existing downloadable CLAIM-it CXF export; direct API credentials are not a
substitute for the required accreditation metadata. Retry the export after saving
the verified date and address any other readiness errors reported by the export.

## Verification

`src/services/nhisServingCoverageMigration.test.js` executes the coverage calculation,
new migration, and existing Serve Directly RPC in PGlite. It covers a 14-day supply
on the 7th followed by a repeat on the 14th, expired coverage, different members,
different medicines, equivalent ingredients, cancelled claims, pending entry,
dispensary inserts, and multi-line transaction rollback.

## Deployment status on 3 October 2026

291 targeted tests, lint, migration validation, and the production build passed.
The coverage guard was deployed to HealthFlow production on 3 October 2026 through
the SQL editor, with its migration-history entry in the same transaction. A
subsequent read-only query confirmed the medicine trigger is enabled, migration
20261002110000 is recorded, and anonymous execution of the trigger function is
revoked. The dashboard warning misinterpreted PL/pgSQL `SELECT ... INTO STRICT`
as creating a table called `strict`; no table was created and no table RLS changed.
No real patient claim was served for verification. Frontend release status is
tracked by the commit containing this document.
