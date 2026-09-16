# Claim recycling and Activity Log identifiers

## Changes

The September serving tables introduced RESTRICT foreign keys to NHIS claims.
The August recycle function did not handle serving events, including events
recorded while inventory deduction was disabled. The new recycle migration
archives event-only serving history with the claim, then removes its active
events before the parent. Restore reinstates the original event IDs, timestamps,
payload hashes and idempotency keys atomically. Old snapshots remain compatible.

Claims with any inventory ledger history remain protected, even when reversing
movements produce a zero net balance. They now receive an actionable correction
message before deletion starts. No ledger rows, stock quantities, constraints,
or clinical validation triggers are changed. This fix permits recycling claims
without inventory effects; it does not introduce deletion of dispensed stock
history. Inactive or absent users are rejected, with existing tenant and role
checks retained.

Activity Log now includes a permitted claim's membership number alongside its
patient name and claim/prescription references. Recorded membership identifiers
take precedence over current values. If a claim is recycled, the read projection
can resolve its identifiers and branch from the same tenant's recycle snapshot.
This fallback describes the archived record, not a reconstruction of every
historical event. It does not rewrite audit payloads. Existing clinical-access
checks also govern membership search, totals and returned fields.

## Rollout

Commit/push contains only these two fixes, their database tests and this note.
The pending workload changes and unrelated clinical migration edit are excluded.

Apply these two files, in order, in the affected Supabase project's SQL Editor:

1. `supabase/migrations/20260916060000_fix_nhis_recycle_serving_events.sql`
2. `supabase/migrations/20260916061000_activity_log_membership_and_recycled_claims.sql`

Each file is transactional and reloads PostgREST's schema. Neither file deletes
existing business records when applied; recycling only happens when requested.
Pushing Git does not apply these SQL files to the database. The existing Activity
Log frontend renders the new field without a frontend or Edge Function change.

After applying, check an authorized staff member's Activity Log and membership
search. Verify a disposable test claim's recycle/restore cycle before asking the
client to retry their affected claim. Claims already associated with stock
movements should display the correction message and remain intact.

## Verification and rollback

Executable PostgreSQL tests use synthetic fixtures. They cover event round trips,
old snapshots, idempotency conflicts with atomic rollback, authorization and
inventory-history protection. Activity tests cover membership search, snapshot
precedence, recycle fallback, tenant/branch isolation, permission non-disclosure,
unchanged audit hashes and service-only grants. Fixtures are not a complete
production schema; hosted acceptance remains necessary.

The Activity Log projection can be reverted using the previous function body in
`20260913120000_activity_log_subjects_and_scope.sql`. Do not restore the old
recycle/restore functions while new snapshots contain serving events: the old
restore function ignores that history. Keep the new restore function and pause
recycling if a rollout problem requires investigation.
