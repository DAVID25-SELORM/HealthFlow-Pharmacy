# NHIS early refill export policy

Date: 2026-11-15

This change replaces the organization duplicate-export opt-in in the Claims Batch
Export window with an organization opt-in for claims held back only by an
"early refill review" alert. It follows a product-owner request ("I want the
checkbox here to rather be for early refill, that when it's checked, early refill
can be exported"); the three open choices were confirmed: replace the duplicate
checkbox, a per-pharmacy administrator setting with an audit trail, and release
only claims worded like "...has early refill review...".

## Behaviour

- During export each claim's medicines go through the active-medication check
  (`check_nhis_active_medication_overlap_batch`). Every alert becomes an
  "Export blocked: ... early refill" blocker. This is unchanged by default.
- A new organization setting `allow_early_refill_exports` (default `false`) lets
  an administrator or super administrator release alerts whose `match_type` is
  `early_refill_review` (7 or more days of the earlier supply remain) or
  `exact_code` ("same medicine code": same medicine, fewer than 7 days remain)
  or `same_ingredient` ("similar active ingredient": same ingredient under
  another code, for example a different pack size, fewer than 7 days remain).
  The check assigns these only when the earlier claim was fully supplied.
  Alerts of the other types (possible completion supply, previous partial
  supply) keep blocking, as does every other export blocker on the claim.
- Amended 2026-11-15: the first version released only `early_refill_review`.
  A shop ticked the box and still saw "Early refill" chip items, which were
  `exact_code` alerts, so `exact_code` was added. No database change.
- Amended again 2026-11-15: West Point's heparin lines (HEPARIIN2 ampoule on
  05 Sept, HEPARIIN3 vial on 07 Sept; the NHIA catalogue lists them as 5000
  units/mL in 1 mL and 5 mL) are labelled `same_ingredient` by migration
  20261009001000, so `same_ingredient` was added. No database change.
- The setting is fail-closed: a missing row, an unreadable policy or a missing
  RPC all mean "blocked".
- Every change to the setting is recorded in
  `nhis_early_refill_export_policy_audit` and as an application audit event
  (`nhis_claim.early_refill_export_policy_changed`). Each export that releases
  claims records `nhis_claim.early_refill_export_allowed` with a compact summary
  (claim numbers and medicines).
- The checkbox is shown to every user and can be changed only by an
  administrator; others see it disabled with an explanation.

## Duplicate claims

The earlier organization duplicate-export opt-in (migration
`20261110090000_add_nhis_duplicate_export_policy.sql`) is retired. The
application no longer reads it: duplicate groups are always blocked pending the
existing per-group review, whatever was saved before. The migration and its two
tables stay in place (history is not rewritten) and can be dropped in a later
cleanup.

## Not changed

- Serving and dispensing guards (the early refill guard before serving).
- The per-group duplicate review workflow.
- The active-medication check itself, its alert types and its wording.
- Offline branch-server exports: that path does not run the active-medication
  check today, so the setting has no effect there.

## Database

New additive migration `20261115090000_add_nhis_early_refill_export_policy.sql`:
two tables, row level security, and two security-definer functions
(`get_nhis_early_refill_export_policy`, `save_nhis_early_refill_export_policy`).
It is applied by hand in the Supabase SQL editor, like earlier migrations.
Rollout order: apply the migration, verify it, then merge the front end. If the
front end is deployed first the setting simply stays blocked and saving shows an
error until the migration is applied.

## Risk

NHIA may reject or reduce payment for an early refill. The checkbox text says so.
Only an administrator can enable the setting, it is per pharmacy, and the
releases are auditable.

## Validation

Unit tests for the alert split and audit summary, service tests that drive the
real export readiness with the setting off, on, mixed with another alert type,
unreadable, and for duplicates, and a contract test for the migration and the
wiring. The protected production baseline is refreshed for `nhisService.js`.

## Rollback

Revert the commit to restore the duplicate opt-in checkbox. The early refill
tables can stay in place unused, or be dropped with the rollback script.
