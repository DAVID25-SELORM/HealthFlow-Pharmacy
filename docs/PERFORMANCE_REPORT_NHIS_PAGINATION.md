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
- Reports bundle generation because it loads and computes multiple report datasets
- Dashboard sales history query for trend calculations

One remaining heavy browser request was also removed:

```text
/rest/v1/nhis_claims?select=*&limit=5000
```

That request came from the patient workspace NHIS-claim patient merge, not from the paginated NHIS Claims table. It now requests only the patient identity fields it needs and orders the latest rows first.

No live browser/API waterfall was captured in this environment because measuring authenticated production pages requires a real logged-in session and browser instrumentation against the deployed app.

## Database Indexes Added

Migration added:

```text
supabase/migrations/20260624153000_optimize_nhis_claim_pagination.sql
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

The migration also adds `public.get_nhis_claim_stats()` so status totals are aggregated in the database instead of pulling every claim row into the frontend just to count statuses.

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
5. Consider a Supabase RPC for NHIS status counts so stats do not scan all claim rows client-side.
