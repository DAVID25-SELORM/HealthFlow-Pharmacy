# Activity Log implementation - 13 September 2026

## Problem and result

The previous Activity Log flattened every audit `details` entry (including nested JSON) into a single truncated cell. The paging RPC omitted `entity_id` and performed no subject resolution. Create/update claims often recorded `patient_name` and `claim_number`, while status events could record only a status and entity ID. Thus the person or prescription was either buried in metadata or absent from the response.

The table now displays an affected-record column, readable actor/role and action labels, and an in-app details dialog. A Select Month date mode exposes Year and All Months / January-December. The previous From/To controls remain available and switch to Custom range when edited. All dates remains the existing unbounded default; Select Month defaults to the current Ghana year and All Months. Current month, Previous month, and Today presets are also available.

## Read path and database change

`resolveActivityLogPeriod` validates calendar dates on the Edge server and resolves month/year to dates. September 2026 becomes September 1-30; PostgreSQL converts that into `[2026-09-01 00:00 Africa/Accra, 2026-10-01 00:00 Africa/Accra)`. Custom and preset modes are exclusive. Month, actor ID, activity type, and authorized-reference search compose before counting and pagination.

The additive migration `20260913120000_activity_log_subjects_and_scope.sql` adds `get_activity_log_view`. It returns the page, full filtered count, scoped actor options, and event options in one statement. Empty later pages retain the true count. Actor options are grouped by immutable ID, include inactive historical actors, and are searchable by name/email in the UI. Existing write functions, old migrations, business actions, audit payloads and timestamps are not modified.

Only service_role can execute the new RPC. tier-access retains its existing activity-access guard and constructs organization, branch and record permissions from the authenticated profile. Browser-supplied scope and permission overrides are ignored. The existing table RLS policies are unchanged. Because this is a service-role read path, the function explicitly enforces tenant/branch scope and the authorized output projection before search, totals and paging; it does not rely on service_role honoring table RLS.

## Available identifiers and projection

The implementation uses actual `audit_logs` columns: organization_id, actor_user_id, actor_email, entity_type, entity_id, event_type, action, details, created_at. Existing payload fields include patient_name, claim_number, active_role, status and rejection_reason. The allowlist also recognizes readable medicine, sale, staff, setting, attachment, payment and report references when recorded. Status before/after values and reasons are shown where permitted; arbitrary nested JSON and clinical data are not exposed.

Tenant-scoped current-record lookups use entity_id against nhis_claims, patients, drugs, sales and users. Claims can supply surname/other_names, claim_number and prescription_reference; medicines supply name and strength where available; sales supply sale_number; patients/staff supply full_name. Snapshots take precedence over live names. The UI labels current or mixed snapshot/current references so live values are not represented as historical facts. Generic event types do not become fake prescriptions.

## Historical and privacy limitations

- A deleted record remains readable if its identifying snapshot was recorded. Missing identifiers display ?Record details unavailable?; no historical values are fabricated or backfilled.
- Tenant views omit legacy logs whose organization_id is null. The previous RPC inferred ownership from the actor's present employer, which cannot safely prove historical tenancy.
- Branch-scoped views require an identifiable record branch or recorded branch_id. Unscoped history is omitted; a current staff assignment is not used to guess the branch of an old event. This can reduce totals relative to the old tenant-only query.
- Audit permission alone does not grant access to claim/patient identifiers or reasons. Restricted values are absent from the response and cannot be discovered through search counts. Tenant-scoped joins cannot resolve another tenant's records or staff names.
- The platform-wide super-admin view remains a minimal audit listing without subject details. Choose a facility for reference search. The platform path now applies actor/event filters rather than silently ignoring them.
- This implementation does not invent missing actor roles or add unrestricted raw-metadata access. It shows ?Not recorded? when a role snapshot is absent.

## Performance and validation

Existing organization/created_at and organization/actor/created_at indexes are retained. Subject joins use primary-key IDs and explicit tenant conditions. No speculative indexes were added. PostgreSQL EXPLAIN ANALYZE was executed against the complete query in a synthetic fixture. This validates the executable plan, not production-scale latency. Exact totals, options and reference search necessarily inspect the permitted matching scope; production query timing must be assessed separately before any later rollout.

Automated tests execute the SQL migration and query in PGlite (PostgreSQL), covering September boundaries, leap years, month/year validation, filter composition, officer activity beyond page one, full counts on empty later pages, snapshots/current references, deleted records, medicine display, inactive staff, tenant/branch restrictions, clinical search non-disclosure, grants and unchanged audit hashes. Edge tests execute the actual read handler and access guard to reject unauthorized staff and forged browser scope/permissions. React tests cover controls, paging and the app-native details dialog.

The full suite passed 158 files / 1,045 tests before final presentation refinements and the added query-plan/access-boundary tests. Final focused tests, lint, build, migration validation and protected-baseline validation are recorded in the final response. Browser QA used the current component with synthetic local records; no live clinical data or production migration was required. Desktop controls and the centered details dialog were visually checked.

## Files and baseline impact

- src/pages/ActivityLog.jsx, ActivityLog.css, ActivityLog.test.jsx: date modes, officer search, subject display and dialog.
- supabase/functions/_shared/activityLogPeriod.ts and its test: server calendar resolution.
- supabase/functions/tier-access/index.ts: authorized read RPC and minimal platform projection.
- supabase/functions/tier-access/activityLogSql.test.js and activityLogAccess.test.js: executable database and Edge authorization coverage.
- supabase/migrations/20260913120000_activity_log_subjects_and_scope.sql: additive service-only read function.
- package.json / package-lock.json: PGlite as a development-only PostgreSQL test dependency.
- config/production-baseline.json and this report: fingerprint and impact documentation for the authorized tier-access edit. Other protected fingerprints and historical baseline identity remain unchanged; the pending-change metadata identifies this change.

## Rollout status

Implementation was validated locally. The user subsequently authorized reconfirmation, commit and push on 13 September 2026. No live database migration or deployment has been performed by this task. A later authorized rollout must apply the additive migration before the updated tier-access function and frontend. The old read functions remain available for compatibility/rollback. No production business records were changed.

Final verification: 52 focused tests across seven files passed after the final changes. Lint, production build, all 118 migration protection checks, protected baseline verification and git diff whitespace checks passed. The earlier complete suite passed 1,045 tests across 158 files.
