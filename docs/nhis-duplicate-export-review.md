# NHIS duplicate export review (per-group "not a duplicate")

Status: built on branch `feat/nhis-duplicate-export-review`. Not applied to production, not deployed, not pushed.

## Why

Export blocks the whole batch when two or more claims share facility, member, service date and CCC (business rule SCRUB-001). Real visits can have several prescriptions, so West Point could only proceed by recycling claims. This adds an audited, per-group decision instead.

## Behaviour

- In the "Duplicate Claims Found" dialog, an administrator or claims officer sees **Not a duplicate - export all** on each group. It asks for a reason (10-500 characters) and warns that NHIA may reject or double-pay real duplicates.
- The decision is stored against the group key **and the exact set of claim ids**. A reviewed group stops blocking export; nothing is deleted, no stock or CCC changes.
- If a claim later joins (or leaves) the group, the stored set no longer matches and the group blocks again.
- Withdrawing a decision (`revoke_nhis_duplicate_review`) makes the group block again. On the NHIS claims page, the **Reviewed duplicates** card (admin and claims officer only) lists the active decisions with their claims, service date, CCC, time and reason, and a **Withdraw review** button that asks for a reason (at least 5 characters). The reviewer's identity is kept on the review row and in the audit log; the list does not show a name.
- Every other group, other facilities, the "Keep this claim" flow, export formats and the Claim-IT file are unchanged.
- If reviews cannot be loaded (error, permission, branch-server mode) groups keep blocking: failure never unblocks an export.

## Database (`20261026090000_nhis_duplicate_export_reviews.sql`)

- New table `nhis_duplicate_reviews` (RLS: facility members can read their own; no direct writes for any client role).
- `review_nhis_duplicate_group(group_key, claim_ids, reason)`: caller must be an active admin or claims officer (primary or assigned role); group key must start with the caller's facility id; every claim must be a served/submitted claim of that facility sharing one service date and one CCC (digits only). Re-reviewing the same set updates the one active row. Writes an audit event (a failing audit call does not lose the decision; the row itself records who/when/why).
- `revoke_nhis_duplicate_review(review_id, reason)`: same role rule, own facility only.
- Additive and re-runnable. No existing table or function is altered.

## Verification done locally

- `scripts/verify-nhis-duplicate-reviews-postgres.py` against a disposable network-less PostgreSQL 17.6: roles (admin, claims officer, multi-role, assistant, inactive, unknown), cross-facility refusal, rejected/missing/different-date claims, no direct table writes, tenant-isolated reads, withdrawal, re-review, idempotent migration, audit-failure tolerance. PASS.
- `src/services/nhisService.test.js`: 8 new tests (exact-set matching, growth re-blocks, other groups still block, load failure keeps blocking, branch-server mode never consults reviews, RPC arguments, short reasons rejected). 287 tests in the NHIS service files pass; eslint and `vite build` pass.
- Five unrelated suites (Docker/SQL and local-branch-server) fail identically on an unmodified main-based worktree in this environment.

## Required before release (not done)

1. **Product-owner approval** to change SCRUB-001: groups can now export with a recorded review. `docs/production-business-rules.md` is intentionally not edited until approved.
2. **Protected baseline**: `src/services/nhisService.js` is protected. It needs the baseline manifest refresh and impact report in a reviewed change, following PR #16 (this branch is based on a main where the baseline already mismatches; merge #16 first).
3. Apply the migration manually in the production SQL editor, then deploy the front end (user approval per step).
4. Residual risk: NHIA may reject or double-pay genuinely duplicated claims; the reason and reviewer are recorded for audit.
