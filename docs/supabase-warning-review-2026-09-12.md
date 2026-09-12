# Supabase warning review ? 12 September 2026

Inspected the signed-in HealthFlow production project in Chrome. Security Advisor displayed 0 errors, 122 warnings and 11 suggestions. A read-only pg_proc query found 51 SECURITY DEFINER functions executable by anon, of which 12 return trigger. These counts differ because Advisor warnings cover more than this single condition.

Prepared 20260912183000_restrict_internal_trigger_execution.sql for the twelve observed trigger functions. It removes PUBLIC, anon and authenticated EXECUTE grants only; it does not replace functions, triggers, RLS, data or branch-sync RPC grants. Applied in production through Chrome after explicit user confirmation.

Disposable PostgreSQL verification passed: all twelve client grants removed, an authenticated INSERT still fired its existing trigger, and an unrelated anonymous branch-sync fixture grant remained intact. Migration protection passed for 117 migrations. Only the approved trigger EXECUTE grants were changed in production; no paid compute change was performed.

Resource alert remains unresolved: live infrastructure displayed CPU 100%, disk 69%, RAM 47% and 25/90 connections. Query Performance displayed 196 slow queries, 99.99% cache hit rate and 285,102,480 cumulative authenticated request-configuration calls consuming 37% of recorded execution time. These cumulative numbers do not establish the present caller or measurement interval. Drugs listing and NHIS paging/count queries also consume substantial recorded time. Do not attribute the CPU alert to the trigger grants or claim a security-only fix resolves resource exhaustion.

Remaining work: apply approved trigger permission repair and rerun Advisor; review other RPC warnings individually (token-authenticated sync must continue working); examine recent error logs and request rates to locate retry/polling sources before tuning queries or considering a paid compute upgrade.

## Production verification

Supabase returned Success. No rows returned for the approved transaction. A subsequent catalog query verified 12 target trigger functions and 0 remaining anon/authenticated EXECUTE grants. Security Advisor then displayed 98 warnings (down from 122), 0 errors and 11 suggestions. The resource-exhaustion banner remained. No CCC migration or unrelated RPC permission change was applied during this action.
