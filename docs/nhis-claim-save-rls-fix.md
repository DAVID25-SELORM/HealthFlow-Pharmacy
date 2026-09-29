# NHIS claim save: "new row violates row-level security policy"

## Root cause
Creating/saving an NHIS claim writes directly to `nhis_claims` from the browser
(`insertNhisClaimWithSchemaFallback` / `updateNhisClaimWithSchemaFallback` in
`nhisService.js`), relying on the table's RLS policies rather than an RPC. Unlike
`invokeSupabaseFunction` (used for edge-function calls), a direct `supabase.from(...)`
write never checks whether the current session is near expiry before sending the
request.

The claim form is one of the longest-lived in the app (patient lookup, prescription
upload, several medicine lines, attendance verification). If the browser tab sits
open — especially backgrounded, where browsers throttle timers — long enough for the
access token to actually expire, the Supabase JS client's own background refresh
timer can miss it. The write then goes out with an expired token; PostgREST treats
`auth.uid()` as unset, and `nhis_claims`'s RLS policies (which check the requester's
role via a `users` row keyed on `auth.uid()`) reject the row. Postgres reports this as
SQLSTATE `42501` with the generic message "new row violates row-level security
policy" — indistinguishable, from the message alone, from an actual permissions
problem. Confirmed with the user this affected an allowed role (Claims Officer /
Pharmacist / Billing / Records Officer / Admin), ruling out a role/permission gap.

## Fix
`src/lib/supabase.js`:
- `getValidUserSession` exported (previously private) — refreshes a session within
  30s of expiry.
- `ensureFreshSupabaseSessionBeforeWrite()` — best-effort, never throws; called
  right before the claim insert/update so a near-expired token is refreshed first.
- `withRowLevelSecurityRetry(write)` — if `write()` fails with SQLSTATE `42501`,
  forces one session refresh and retries `write()` once. Recovers a token that had
  *already* expired (not just near-expiry) when the write started. A genuine
  permissions rejection still fails on the retry and surfaces as before.

`src/services/nhisService.js`: both wrapped around the existing
`supabase.from('nhis_claims').insert(...)` / `.update(...)` calls. No change to what
gets written, no change to RLS policies, no migration.

## Not changed
This only touches the two `nhis_claims` write wrappers. The same class of bug could
affect other long-lived direct writes elsewhere in the app; fixing those was out of
scope for this report and would need its own review.

## Tests
- `src/lib/supabase.test.js`: unmocked, exercises the real
  `ensureFreshSupabaseSessionBeforeWrite` / `withRowLevelSecurityRetry` against a
  mocked `@supabase/supabase-js` client (near-expiry refresh, fresh session no-op,
  42501 retry-and-succeed, non-42501 no-retry, retry declined when the forced
  refresh itself fails).
- `src/services/nhisService.test.js`: wiring test confirming `createNhisClaim` calls
  both helpers (this file mocks `../lib/supabase` at the module boundary, so it
  proves the wiring, not the retry internals).

## Rollback
Revert this commit. No database or config changes.
