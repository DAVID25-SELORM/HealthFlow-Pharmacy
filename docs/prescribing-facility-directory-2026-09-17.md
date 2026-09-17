# Shared Prescribing Facility Directory

## Purpose and existing structures

External hospitals are reference records, not HealthFlow organizations or accounts.
The implementation reuses `nhis_prescribing_facilities`, the existing claim facility
foreign key, and existing name/code snapshot fields. Tenant-private facility and
prescriber registers remain separate. No new prescription or tenant system is added.

## Changes

- Adds `is_shared`, generated `canonical_name`, `aliases`, `area`, and nullable
  `nhis_enabled` to the existing facility table. Existing rows stay private.
- Shared rows have no organization or branch. Canonical names are unique among
  shared rows. Seeds use stable IDs and conflict-safe inserts; repeating the
  migration cannot duplicate or reactivate renamed/deactivated seed entries.
- Seeds Korle Bu Teaching Hospital, Greater Accra Regional Hospital (Ridge Hospital,
  Ridge), 37 Military Hospital, University of Ghana Medical Centre (UGMC), LEKMA
  Hospital, Police Hospital, Ga East Municipal Hospital, Adabraka Polyclinic, and
  Kaneshie Polyclinic. No credentials, provider IDs or NHIS eligibility are invented.
- Adds bounded directory search by name, aliases, area, town and region, preferring
  confirmed NHIS-enabled records. The optional NHIS-only filter excludes unknown
  and disabled eligibility. Initial entries intentionally have unknown eligibility.
- NHIS prescription creation/edit/serving uses a keyboard/mouse searchable picker;
  POS NHIA intake copies the chosen source into its generated NHIS review claim.
  Non-NHIS sources remain selectable. Existing private saved facilities remain
  selectable in the NHIS form. General retail checkout does not gain a new
  prescription workflow.
- Other / Facility not listed stores manual source text in the existing claim
  snapshot fields with a null facility ID. The source-registration trigger no
  longer creates private or shared facility rows from typed names. Existing
  private prescriber auto-registration remains intact.
- Changing a prescriber preserves the selected facility and historical name.
- Platform administration includes directory add/edit, aliases, location/type,
  eligibility, active/inactive status, search and paging. No delete action is offered.
- Branch snapshot imports include own-tenant private facilities plus shared rows.
  Offline search filters before limiting results. Shared cached entries cannot be
  edited through branch record writes. Cloud sync independently rejects such edits.

## Storage and historical safety

Selection saves `prescribing_facility_id` and the existing name/code snapshots.
On a new selection, the database resolves the name/code from the authorized facility.
A directory rename/deactivation does not update existing claims or snapshots.
Inactive facilities remain referenced by old claims but cannot be newly selected.
Shared deletion/privatization is rejected. Manual text remains a separate unlisted
source. The migration performs no claim backfill or clinical-data update.
Existing CCC, medicine duration, export scope, pricing and CLAIM-it serialization
are unchanged.

## Security

Active authenticated users can read shared reference rows. Shared writes require
an active primary `super_admin` role, including when a SECURITY DEFINER branch-sync
function bypasses RLS. Private facility policies and claim/patient policies remain
unchanged. Claim validation accepts a same-tenant private facility or a shared
facility, never another pharmacy's private row.

## Deployment order and status

Implemented on `feature/shared-prescribing-directory`, in the isolated
`D:/APPS/HealthFlow-facility-directory` worktree. Unrelated performance work in the
original workspace is untouched. Production migration and deployment have not run.

1. Apply `supabase/migrations/20260917190000_shared_prescribing_facility_directory.sql`
   to the intended database before publishing the new app or branch server.
2. Publish the app and update branch servers. Refresh branch snapshots so the nine
   shared entries become available offline. An older branch cache cannot search
   entries it has not downloaded; unlisted source entry remains available.
3. Verify a pharmacy can search Ridge/UGMC, save/reopen a draft with its facility ID,
   and see the original name after a directory rename. Verify platform-only editing.
4. Keep a sample June-compatible CLAIM-it export in the deployment smoke checks.

## Validation

- Database migration executed successfully in isolated PGlite fixtures, including
  existing private-register policies, repeat application, tenant isolation,
  stable snapshots, manual entry, inactive selection and branch-sync attack checks.
- Broad contract/NHIS service/export run: 40 files, 418 tests passed.
- Focused UI/admin/service/database run: 5 files, 29 tests passed.
- Focused directory/offline run: 5 files, 18 tests passed (overlaps the runs above).
- Push reconfirmation: 30 focused tests passed; 6 admin/service tests passed after
  ensuring admin searches always use the cloud directory, including on branch PCs.
- Lint, production build, migration-name checks and protected baseline passed.
- Exact-source contract tests required LF-normalized working files on Windows;
  this made no semantic changes to unrelated source files.

These are local checks, not a claim of production migration or live-browser acceptance.
No existing West Point clinical records or production database records were modified.
