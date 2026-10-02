# NHIS CCC duplicate detection (2026-10-02)

## Trace and root cause

Manual entry is `nhis-ccc-code` in `src/pages/Nhis.jsx`. NHIA member lookup / CCC
verification applies the returned `ccCode` to the same `claimForm.cccNo`; hosted
`generateHostedNhiaCcCode` and the existing branch `genCCC` route are unchanged.
Both paths save `ccc_no` through `createNhisClaim` / `updateNhisClaim` in
`src/services/nhisService.js`. Direct submission also checks the existing claim.

The original production-source function `guard_facility_ccc_duplicate` compared
organization, digit-normalized CCC and service dates within six days either side,
without comparing the member. Its reservation table serialized writes on
organization + CCC. That reservation key was not a patient identifier. Source for
these drift migrations is in the separate `codex/claimit-local-rollout` worktree;
this work did not query or change the live database. There was no corresponding
claim-table CCC uniqueness migration on the main branch used for this change.

The original UI and service additionally blocked equal member/date/total claims,
with a name fallback. The first redesign left those checks in place, queried only
same-CCC candidates, omitted medicine data, and showed warnings as transient toasts.
The old error-only Find existing claim link also missed the new message.

## Final behavior

All comparisons are facility scoped. Member numbers and HIN are digit normalized;
a stable patient ID is used only when both records lack member identity. Patient
names never establish duplicate identity. Manual and NHIA-generated codes have
identical handling. No global uniqueness assumption is made about an NHIA code.

| Context | Behavior |
| --- | --- |
| Same member + same CCC + same service day | Block, even if totals/medicines differ |
| Same member + same CCC within 3 days | Strong warning, explicit review required |
| Different member + same CCC | Allow; informational notice |
| Same member + same day + different/pending CCC | Warning, explicit review required |
| Same member + same CCC on a more distant day | Review required, no automatic block |

The three-day threshold is named and configurable at the shared classifier boundary.
Dates are actual service calendar days. Draft, pending-serving, served, submitted,
and paid records remain active. Rejected, failed, cancelled/canceled and voided
records do not block on either side. Recognizing inactive values does not expand
which statuses the database permits. Reactivation is checked again by the trigger
and unique index. Incomplete claims without a CCC still receive same-member/day
review and retain existing CCC progression requirements.

Jaccard overlap over normalized medicine codes adds confidence: 50% or greater
promotes an existing different-CCC same-member/day warning to strong warning.
Medicine overlap never establishes identity or independently blocks a claim.

## Implementation and review

- Shared pure classifier: `local-branch-server/src/nhisCccDuplicate.js`, re-exported
  by `src/utils/nhisCccDuplicate.js` for the frontend.
- `src/services/nhisCccDuplicateService.js` reads all lookup pages, awaits explicit
  acknowledgment for warnings, and fails closed on lookup failure or missing review.
- The new SECURITY INVOKER RPC normalizes stored values, enforces current facility,
  retains caller RLS and fetches both CCC matches and member/day matches with medicine
  codes. It excludes the edited claim and paginates instead of silently truncating.
- The UI and service no longer apply the conflicting member/date/amount hard block.
  Batch duplicate grouping uses member + CCC + facility + day too, so an allowed
  encounter is not later rejected merely for an equal total. Serialization and
  export RPCs are untouched.
- `NhisCccDuplicateReview` shows reference, service date, masked member, status,
  total, CCC, medicine codes and a Find existing claim link to the existing general
  search page. Review pauses the save. Cancel leaves the claim unsaved. A blocking
  duplicate cannot be acknowledged away.
- Branch-server preflight uses the same classifier; the SQLite write transaction
  also enforces hard duplicates before any record/outbox write. Offline protection
  covers records available to that branch; the hosted index remains the final
  cross-workstation concurrency backstop during synchronization.

## Migration and rollout

Migration: `20261002100000_member_aware_ccc_duplicate_detection.sql`.

The function is replaced without removing reservation data. Existing trigger wiring
is preserved; a trigger is installed when absent on a clean database. A partial
unique index over facility, normalized member/HIN (patient-ID fallback), normalized
CCC and service day provides the concurrency guarantee for active claims. The guard
also checks status transitions and supplies the friendly error in the ordinary path.
A racing save can still return the unique-index error.

No historical data is rewritten or deleted. Index creation fails transactionally if
historical active duplicates exist: resolve those explicitly before applying the
migration. Deploy the database migration before the application because the new
lookup RPC is required. Neither database migration nor application was deployed as
part of this task. Production state was not independently verified in this session.

## Override and audit policy

There is no duplicate override for any role. Admin/super-admin and ordinary staff
are equally blocked for category A, including when callers pass override flags or
acknowledge the review dialog. Therefore override reason, override audit event and
successful-authorized-override tests are not applicable; no bypass is introduced.

Existing claim fields for member, patient, facility, CCC, service date, NHIA
transaction/attendance/validation data, creation actor and timestamps are preserved.
Existing claim creation/update audit events remain. This change adds no raw NHIA
payloads or secrets and does not claim to create an override/review audit trail.

## Verification

Coverage includes the five classifications, active and inactive statuses, normalized
HIN and patient fallback, same-name nonidentity, medicine overlap, manual/generated
parity, edit exclusion, pagination past 200 rows, lookup failure, awaited review and
cancellation, denied overrides for all roles, review display/search navigation,
clean/production trigger wiring, status reactivation, index enforcement, RPC
facility/RLS/anonymous-access boundaries and atomic branch-server enforcement.

The existing NHIS service suite covers claim creation, updates, attachments, serving,
member validation, totals and exports. See the final task report for execution results.

Verified locally after the fixes: 339 relevant tests passed across the NHIS service
suite (266), classifier/service/SQL/review component suites (65), existing CCC
contracts (5) and offline repository suite (3). The offline suite passed using the
installer's Node 22 runtime; Node 24 crashed in native SQLite teardown in two older
tests. A combined Vitest run also encountered a worker startup timeout; the affected
service suite passed separately. Full lint, production build, protected-baseline,
migration validation and whitespace checks passed.

Additional touched integration files are `src/pages/Nhis.jsx`, `src/pages/Nhis.css`,
`local-branch-server/src/offlineRecordsRepository.js`, and the protected hash/report
entry in `config/production-baseline.json`. Regression coverage lives in
`src/utils/nhisCccDuplicate.test.js`, `src/services/nhisCccDuplicateService.test.js`,
`src/services/nhisCccDuplicateMigration.test.js`, `src/services/nhisService.test.js`,
`src/components/NhisCccDuplicateReview.test.jsx`, and
`local-branch-server/src/offlineRecordsRepository.test.js`.
