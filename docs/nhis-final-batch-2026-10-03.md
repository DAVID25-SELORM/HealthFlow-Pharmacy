# NHIS final coverage batch ? 3 October 2026

## Ready for one deployment

Apply `supabase/migrations/20261003170000_complete_nhis_coverage_guards.sql`
once after the previously applied 120000?160000 corrections. Then run
`scripts/verification/nhis-final-deployment-check.sql` and export its ten rows.
The final batch has not yet been applied to production.

## Changes

- Two supplied lines with the same normalized medicine code in one claim are
  rejected by an AFTER INSERT/UPDATE trigger. Pending intake may contain duplicate
  lines, but they must be combined before serving. Different medicine codes remain
  allowed; this is not a therapeutic-equivalence classifier within a claim.
- Administrative claim status no longer removes a positive, supplied medicine
  line from cross-claim coverage. Rejected/cancelled claims with medicines actually
  supplied remain coverage evidence. Pending/not-served medicine rows still do not.
- Existing recycle/restore rules remain unchanged. Recycling removes the archived
  claim from live lookup and compensates recorded stock; restoration reruns coverage
  and rejects an overlap atomically. Staff must use recycling only when stock
  genuinely can be returned, as already explained by the UI.

## Verification

74 tests passed across coverage, recycle stock, online serving and branch API suites.
Includes both serving RPCs, duplicate-code atomic rollback, six administrative
status cases, served-header corrections, recycling/restoring with coverage guards
installed, and rejection of conflicting restoration without stock loss or removal
of its archive. Inventory fixtures seed existing ledger deductions; this is not a
claim of a full production end-to-end dispense test with all production triggers.
ESLint and git diff --check passed. Real PostgreSQL 17.6 two-connection shared-HIN
contention passed with the final migration applied twice. The ten-row final
verification query passed against that database, including all three trigger masks.

## Evidence already supplied

Export (15) verified previous function bodies, both then-existing enabled triggers,
private-helper permissions and zero active branch registrations. The user confirmed
ABC and Westpoint online-only; export (13) verified their ten obsolete registrations
disabled. This batch needs one further deployment/export to verify its additions.

## Practical boundaries

Checks depend on recorded supplies, matching member/HIN identifiers and medicine
codes/catalog metadata. They do not link records that share no identifier, infer
all equivalent medicines from free text, or prove every unrelated NHIS workflow.
Service-role imports remain outside signed-in serving guards. No production
patient or stock rows were used for testing. Existing duplicates are not deleted;
future writes to a claim containing duplicate supplied codes will require correction.
