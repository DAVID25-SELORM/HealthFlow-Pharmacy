# HealthFlow Performance Report - NHIS Claims Pagination

Date: 2026-06-24

## Scope

This pass focused on the confirmed slow path: the NHIS Claims page loading too many claims on open/refresh.

Pages reviewed:

- Dashboard
- Patients
- NHIS
- Dispensing / Sales POS
- Reports

## Before Optimization

The NHIS page used a fixed bulk claim load:

```text
getAllNhisClaims({ limit: 2000, includeDetails: false })
```

Earlier troubleshooting also temporarily raised this path to very high limits so old Westpoint claims could appear. That solved visibility, but it was not a good long-term performance design.

Observed risk:

- Too many claim rows loaded on every NHIS page open.
- Filtering happened partly in React after loading a large batch.
- Older facilities with hundreds or thousands of NHIS claims would get slower over time.
- The user could not page through results predictably.

Local build signal before this specific pagination pass:

```text
vite build: 16.79s
NHIS route chunk: ~205.74 kB
nhisService chunk: ~161.00 kB
```

## After Optimization

NHIS Claims now uses server-side pagination:

```text
100 claims per page
Supabase range(from, to)
Supabase exact count
```

The UI now shows:

```text
Showing 1-100 of total claims
Previous
Page N of M
Next
```

Filters are sent to the database before pagination:

- Status tab
- Date range
- Open claims
- Claim search
- Member number / HIN / patient name / claim number search
- Organization access remains enforced by existing Supabase RLS/session access

When filters change, the page resets to page 1.

Follow-up optimization added:

- Claim search is debounced before hitting Supabase, reducing request bursts while typing.
- Exact totals are fetched for a new filter set, then skipped on later page clicks to avoid repeated count scans.
- Recently loaded pages are cached in memory for 60 seconds, so Page 1 -> Page 2 -> Page 1 does not immediately refetch.
- A combined `get_nhis_claims_page()` RPC now returns paginated claim summaries and matching counts in one call when the production migration is installed.

Local build signal after this pass:

```text
vite build: 10.10s
NHIS route chunk: ~207.10 kB
nhisService chunk: ~161.77 kB
```

The JS chunk size is roughly unchanged because this is a data-loading optimization, not a bundle-splitting change. The performance gain comes from fetching 100 matching rows instead of thousands.

## Slowest Endpoints / Requests

Likely slow paths identified from code review:

- `nhis_claims` list loading without server-side pagination
- `nhis_claims` search using partial text matches
- Patient workspace loading when it merges patients and NHIS claim-derived patient records
- Repeated exact counts for every paginated page request
- Reports bundle generation because it loads and computes multiple report datasets
- Dashboard sales history query for trend calculations

One remaining heavy browser request was also removed:

```text
/rest/v1/nhis_claims?select=*&limit=5000
```

That request came from the patient workspace NHIS-claim patient merge, not from the paginated NHIS Claims table. It now requests only the patient identity fields it needs and orders the latest rows first.

No live browser/API waterfall was captured in this environment because measuring authenticated production pages requires a real logged-in session and browser instrumentation against the deployed app.

## NHIS Issue Query Plan

Follow-up optimization removed embedded attachment payloads from NHIS list and issue-count queries. Ordinary claim lists and issue dashboards must not select `claimit_attachment_base64`; that field remains available only to full claim/export/submission paths that actually need the document payload.

Code paths:

- Main claims list: `getNhisClaimsPage()` -> `fetchNhisClaimsPageFromSupabase()` in `src/services/nhisService.js`
- Issue-filtered claim tabs: `fetchNhisIssueFilteredClaimsPageFromSupabase()`
- Issue badge counts: `getNhisClaimIssueCountsFromSupabase()`
- Issue rules/specs: `getNhisIssueQuerySpecs()`

Issue cards and filters:

| UI count/filter | Query design | Attachment payload selected? | Supporting index |
| --- | --- | --- | --- |
| Missing attachment | Exact count over export-ready statuses where prescription URL/path/name and Base64 are all null | No | `idx_nhis_claims_issue_missing_prescription` |
| Set attachment type | Exact counts over attached claims, comparing attached claims vs claims marked as prescription documents | No | `idx_nhis_claims_issue_prescription_metadata` |
| Unverified prescription | Exact counts over attached prescription documents where verification is null/false | No | `idx_nhis_claims_issue_prescription_metadata` |
| Incomplete intake | Exact count over intake statuses minus claims with attachment metadata and at least one medicine row | No | `idx_nhis_claims_issue_intake_status` plus existing medicine relationship indexes |
| All issues | Composes the lightweight issue specs above, then pages within those specs instead of scanning large browser-side batches | No | Same indexes as each issue spec |

Expected complexity:

- The main claims list remains page-sized and server-paginated.
- Issue badges are server-side exact counts with narrow predicates.
- Issue tabs fetch only the visible page range instead of loading thousands of claims into the browser.
- A count failure should not break the main claims list; the user should see a retryable issue-count warning while normal claim work continues.

Operational verification after deployment:

- Browser Network tab should show no `claimit_attachment_base64` in NHIS list or issue-count `select` parameters.
- NHIS issue tabs should not request 1,000 to 100,000 claim rows just to calculate counts.
- HTTP 500 or statement-timeout errors from issue counts should no longer block the claims table.
- Pagination should be checked on page 1, middle pages, and the last page for missing or repeated claims.

## Database Indexes Added

Migration added:

```text
supabase/migrations/20260624153000_optimize_nhis_claim_pagination.sql
supabase/migrations/20260624165000_add_nhis_claims_page_rpc.sql
supabase/migrations/20260723010000_optimize_nhis_issue_filter_indexes.sql
```

Indexes added for:

- `organization_id, created_at desc`
- `organization_id, status, created_at desc`
- `organization_id, service_date_from, created_at desc`
- `organization_id, submission_month, created_at desc`
- `organization_id, claim_number`
- `organization_id, member_no`
- `organization_id, hin`
- Trigram search on claim number, member number, HIN, surname, and other names

The first migration also adds `public.get_nhis_claim_stats()` so status totals are aggregated in the database instead of pulling every claim row into the frontend just to count statuses. The second migration adds `public.get_nhis_claims_page()` for combined page rows and matching counts.

## Verification

Passed locally:

```text
npm.cmd run lint
npm.cmd run build
```

## Recommended Next Improvements

1. Add live browser timing with a Westpoint account using Chrome DevTools or Playwright after deployment.
2. Convert Reports to lazy/on-demand report generation instead of loading the default bundle immediately.
3. Optimize Patient page enrichment to avoid per-patient visit-count lookups where workspace stats already exist.
4. Add a paginated Patient Care patient picker for large facilities.
5. After live timing, consider moving more list filters into specialized RPCs only if the current indexed query path still shows requests above 2 seconds.
