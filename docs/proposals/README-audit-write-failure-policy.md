# Policy decision (not applied): should a failed audit write block an accreditation-date save?

Parked from Codex's `20260921160000_preserve_accreditation_audit_integrity.sql`, which bundled two
changes. Only the safe one was adopted (`20260921170000_audit_actor_from_authenticated_session.sql`:
the actor comes solely from `auth.uid()`, never client-supplied `updated_by`).

The remaining, un-adopted change is: if the audit row cannot be written, **roll back the date save**
(`raise exception` inside the trigger) instead of saving and logging a warning.

- For: no accreditation date can change without a durable audit record.
- Against: an audit-table outage or permission problem would also block Settings saves and
  offline-branch syncs of NHIA configuration, which are operational, not audit, actions.

Codex's original bundled migration and its test are kept locally (uncommitted) beside this note as
`audit-write-failure-blocks-save.proposal.sql` and `audit-write-failure-blocks-save.test.js.proposal`. They are
intentionally not in `supabase/migrations` and not a runnable test; restore them under a new migration
version only if this policy is chosen.
