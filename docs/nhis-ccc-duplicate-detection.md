# NHIS CCC/CC duplicate detection — member-aware redesign (2026-10-02)

## Problem

A production-only trigger, `guard_facility_ccc_duplicate()` (added 2026-09-30 directly against
the live database; its source migrations were never committed to this repository — see "Migration
drift" below), blocked any two claims at the same facility that shared a normalized CCC/CC value
within a 7-day window, regardless of which member the claim was for.

The CCC/ClaimCheckCode is issued by NHIA per encounter (via the `genCCC` API for the 5-digit
non-biometric code, or NHIA's OTAC/NeHFAMS portal for the 13-digit biometric code) — it is not a
patient identifier HealthFlow controls, and NHIA does not guarantee it is globally unique. A
5-digit non-biometric code has only 100,000 possible values, so two different members at the same
facility legitimately sharing one within a week is expected, not fraud. The old trigger's message
("This CCC code is already used by another claim in this facility within 7 days of the service
date.") was blocking exactly this legitimate case.

## Migration drift

The buggy trigger and its backing `nhis_ccc_reservations` table exist in the live production
database but have no corresponding migration file on `origin/main` — they were applied directly
through the Supabase SQL editor from a branch (`codex/claimit-local-rollout`) that was never
pushed. This change does not touch that branch; it is a clean, additive migration off
`origin/main` that replaces the same trigger function in place.

## New model

Duplicate detection is now member-aware, classifying every same-CCC or same-member/same-date match
into one of five categories (`src/utils/nhisCccDuplicate.js`):

| Category | Condition | Severity | Blocks? |
|---|---|---|---|
| A — strong duplicate | same member + same CCC + same facility + same service date | `block` | Yes |
| B — strong warning | same member + same CCC + service date within 3 days | `strong_warning` | No |
| C — allow | different member + same CCC | `info` | Never |
| D — possible duplicate encounter | same member + same service date + different CCC | `warning` (promoted to `strong_warning` when the medicine sets overlap ≥ 50%) | No |
| E — review | same member + same CCC + a clearly different service date | `review` | No |

A claim whose status is `rejected` or `failed` is never treated as a live duplicate for categories
A/B/D (it is NHIA's and HealthFlow's own record that the claim did not go through), but a
rejected/failed claim sharing a CCC with a *different* member still raises the informational
category C notice, since that is still NHIA's record of the code.

Medicine overlap (Jaccard ratio over normalized drug codes) is used only as a confidence booster on
an already-raised category D signal — it never creates a signal by itself and never reaches
`block`.

## Database layer

`supabase/migrations/20261002100000_member_aware_ccc_duplicate_detection.sql`:
- Adds a partial unique index on `(organization_id, member key, ccc, service_date_from)` scoped to
  non-voided claims, as the real concurrency guard.
- Replaces `guard_facility_ccc_duplicate()` (`create or replace`, same name/wiring) to raise only
  for category A (same member + same CCC + same date + non-voided conflicting claim).
- Additive: `nhis_ccc_reservations` and its release trigger are left in place, unused by the new
  check, rather than removed in the same change that fixes production.

## Application layer

`src/services/nhisService.js`'s `assertNoDuplicateNhisClaimInStore` was split into the pre-existing
member+date+amount check (unchanged) and a new CCC-aware check (`assertNoCccDuplicateAndWarn`):
blocking signals throw a structured `{ code: 'NHIS_CCC_DUPLICATE', duplicateClaim }` error (checked
with the new `isNhisCccDuplicateError`); non-blocking signals are passed to an optional
`onCccDuplicateSignal(signals)` callback. `createNhisClaim`, `updateNhisClaim` and
`submitNhisClaimDirect` all run the CCC check. `src/pages/Nhis.jsx` wires
`onCccDuplicateSignal` on the create/update paths to `notify()` toasts.

## Deliberately not built (follow-up decision points)

- **Override workflow for category A**: category A remains a hard, non-overridable block — the
  same as before, just correctly scoped to same-member instead of any-claim-at-the-facility. No
  authorized-role override/reason/audit flow was added.
- **Audit fields**: no new audit logging (CCC value, validation outcome, override reason) was
  added beyond what already existed.
- **Rich review UI**: non-blocking signals surface as simple toasts; they are not yet routed
  through the existing duplicate-claim-review modal pattern.

## Scope not touched

Claim-IT serializer, field order, `servVersion`, `cpuType`, accreditation, signer handling, and
export RPCs are unchanged. NHIA/OTAC's own CCC generation and validation are unchanged — this is
purely HealthFlow's own duplicate-detection logic.
