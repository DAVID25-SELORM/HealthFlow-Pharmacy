# Reports: complete data and honest gaps (REPORT-001)

Date: 2026-11-25

## Why
A review of Reports found figures that looked complete when they were not, two reports that could never show anything,
and two queries that did not narrow to the facility. PR #77 added warnings on screen. This change addresses the causes
that live in `tier-access`, and lets the screen read the rest of the NHIS claims.

## What was checked before changing
- The deployed `tier-access` (version 169, deployed 2026-11-19) was compared file by file with `main`: all 16 files
  identical. Deploying this change therefore ships only this change.
- Signed out, returning no rows: `nhia_submission_logs` and `nhia_claim_batches` are not found in the cloud database;
  `claim_export_alerts` and `ccc_attendance_requests` exist and refuse signed-out reads. The two new inner-join searches
  (`nhis_claims` with matching `nhis_claim_medicines`, `sale_items` to `sales`) are accepted.
- Not verifiable signed out: the branch and officer names joined into the CC code query (checked against the table
  definitions: one link to each). If it failed, the report would say the list could not be loaded.

## Behaviour (report actions only)
- **Lists past 1,000 rows.** Sales, insurance claims, patients, inventory, purchases and suppliers are read page by page
  up to 5,000 rows each. `pagination.truncated` says which lists went past that. The limit exists because an edge function
  has limited memory and processing time per request.
- **Failures are named.** `unavailable` lists an optional source that could not be read, so an empty list is not shown as zero.
- **Stable paging.** The NHIS claim queries order by a unique last key, so claims created at the same moment are not
  skipped or repeated between pages.
- **Drug filter.** One query now asks for the facility's newest claims (and branch, and period) that have a matching
  medicine, so everything is narrowed *before* the limit. Previously the first medicine matches from every facility
  were taken and then filtered, so a facility could lose its own. Claim rows were always filtered by facility, so no
  other facility's claims were returned. The sale-line match is likewise narrowed to the facility's sales in the
  period and keeps its limit of 1,000 lines, now reported when reached.
- **Export history** now comes from `claim_export_alerts`, filtered by facility: claim month, claim count, time and a
  short file fingerprint. No amount or file name is recorded, and the screen shows a dash. Export records have no branch,
  so a user limited to one branch is shown none.
- **CC code report** now comes from `ccc_attendance_requests`, filtered by facility and branch: time, outcome, error code,
  officer and branch. The member number is deliberately not sent.
- **Removed:** reads of `nhia_submission_logs` (no facility filter) and `nhia_claim_batches`. Neither table exists in
  the cloud database, so nothing was exposed; the unfiltered read would have been unsafe had the table been created.

## Screen
- "Load all N NHIS claims" reads the remaining claims in pages of 250, with progress, up to 20,000 claims. NHIS reports,
  drug figures and exports are then built from every claim. A failed page keeps what arrived and keeps the warning.
- Further pages use the filters the figures were generated with, not later unsaved edits.
- Further pages start after the server's own first batch. Previously, claims added by a drug filter moved the starting
  point forward and claims could be skipped.
- The screen works with both the old and the new function, so the two can be released independently. Until the function
  is deployed, the 1,000-row warnings stay, and export history and CC codes stay empty.

## Risk to watch after deployment
Large pharmacies now receive up to five times as many rows in one response. This has not been load-tested. Generate
Reports for the longest period used, and roll back if it fails or times out.

## Not changed
Roles, tiers, branch resolution (`resolveScopedBranchId`), every non-report action, database schema, RLS, ClaimIT,
stock and dispensing. No migration. The local branch server is unchanged.

## Release
1. Merge (the screen deploys with Vercel). 2. With separate approval, deploy `tier-access` from a clean checkout of
`main`. 3. Signed-in check: Generate Reports for a period, open the export history and CC code reports, search by the
Drug filter. Rollback: redeploy the previous `tier-access` (version 169 is `main` at `a9d07580`).

## Verification
`src/contracts/reportBundleData.contract.test.js` (paging boundaries and failure, record shapes, facility and branch
filters in the source, stable ordering), `reportCompleteness.test.js` and `Reports.test.jsx` (load all, generated
filters, failed page, size limit, dash for missing amounts). The function has not been run against signed-in data:
that needs the deployment.
