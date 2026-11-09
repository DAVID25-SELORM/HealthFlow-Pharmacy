# Protected baseline refresh for `src/services/nhisService.js`, 2026-11-09

The protected baseline (`config/production-baseline.json`, checked by `npm run protect:baseline`) currently fails on `main` for one file, `src/services/nhisService.js`. This change records, for that file, everything that changed since its fingerprint last matched, including the per-group duplicate review added in this pull request, so a reviewer can confirm the current content is intended before the fingerprint is accepted.

Only one fingerprint and this report change here. No other protected file changed.

## What the check compares

SHA-256 of the file with line endings normalized to LF.

| File | Manifest value (before) | Value on this branch (after) |
|---|---|---|
| `src/services/nhisService.js` | `c3e5669876a08cd106c1b0ec00d0dcd773eeadffae19a12e134360c836d2a720` | `eaafab36280742081a6d6a209b5ce319cc5c53708fe66abc13f5507964553153` |

The "before" value last matched the file at `64823f34` (22 Oct). `main` (`129f04a0`) holds `b0a807559f6cb5207f54bb15873ebea6ea9c13564a489501ef80023148996db1`.

## Changes since the fingerprint last matched

Net: +125 / -4 lines, from five commits. Three are already on `main` and were never accepted into the baseline; two are this pull request.

### Already on `main` (not yet baselined)

| Commit | Date | Change |
|---|---|---|
| `17193bb6` | 22 Oct | The duplicate-claims error now carries each claim's medicines (drug code, description) so the review dialog can show them. Display data only. |
| `c7642668` | 22 Oct | **Duplicate groups exclude separate prescriptions.** A group of claims with the same member, date and CCC is no longer reported when every claim has a recorded medication set and the sets differ. Groups with identical sets, or with any claim missing medication data, are still reported. This narrows SCRUB-001. |
| `07a38b01` | 22 Oct | Wording of the early-refill export blocker ("Export blocked:" instead of "Active medication blocked:"). No rule change. |

### This pull request (+112 / -2)

| Commit | Change |
|---|---|
| `01126b3a` | Per-group "reviewed - not a duplicate" decision. Export loads the facility's active reviews and splits the duplicate groups into blocking and reviewed (`partitionNhisDuplicateGroups`). A group is reviewed only when its key **and** its exact set of claim ids match an active review; a claim joining or leaving the group makes it block again. Reviews that cannot be loaded, an unknown facility, or branch-server mode leave every group blocking. Adds `reviewNhisDuplicateGroup` and `revokeNhisDuplicateReview` (calls to two database functions that check role, facility and claim set) and returns `reviewedDuplicateGroups` alongside `duplicateGroups`. |
| `3f277a86` | `listActiveNhisDuplicateReviews`: read-only list of a facility's active decisions with their claim numbers, for the withdraw screen. |

Rules touched: **SCRUB-001 (duplicates): intentionally changed**, see below. NHIS-001 (CCC readiness), AUDIT-001 and the Claim-IT export contract are unchanged: the Claim-IT field order, serializer and locked export contract keep their protected hashes, and the export file format is not touched.

## Behaviour that changes, and what does not

- Changes: an administrator or claims officer can record that a duplicate group is not a duplicate; that group then exports with all of its claims. The reason, reviewer and time are stored and audited.
- Does not change: every unreviewed group blocks exactly as before; other facilities are unaffected; "Keep this claim" and recycling work as before; no claim, stock or CCC value is edited by a review.
- Safe failure: if the review table or function is missing (migration not applied), the loader returns no reviews, so every group blocks as it does today. Merging the front end before the migration is applied therefore changes nothing for users, except that the new buttons will report a database error if clicked.

## Authorization

SCRUB-001 is a business rule. `c7642668` was merged earlier without a baseline refresh. This refresh does not approve any behavior by itself; the SCRUB-001 change in this pull request needs the product owner's approval, recorded in the pull request, before merge.

## Verification

- `npm run protect:baseline` passes with the new value and fails if the file changes again.
- `npm run protect:migrations` passes (176 migrations).
- `npm run test:contracts`: 41 files, 153 tests pass.
- `src/services/nhisService.test.js`: 280 tests pass, including 10 new tests for the review partition, load-failure fail-closed behaviour, branch-server mode, RPC arguments and the list function.
- `scripts/verify-nhis-duplicate-reviews-postgres.py` against disposable PostgreSQL 17.6 for the two database functions.
- eslint and `vite build` pass.
- Windows note: source-text contract tests that read files can fail on a CRLF checkout and pass on the Linux CI checkout.

## Relationship to PR #16

PR #16 (`fix/baseline-manifest`) predates the `main` manifest update and now conflicts with it. It proposes `1b4aa9c4…` for this file, which matches the file at `3a59b8cb` (10 Oct) and is out of date. This report supersedes it for `nhisService.js`; #16 should be rebased or closed.

## Rollback

Revert this commit: the manifest returns to `c3e5669…` and the check fails again exactly as it does on `main` today.
