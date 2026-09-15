# Workspace recovery and concurrent read reduction

## Problem and changes

After profile/organization loading failed, the workspace error waited for a reload
or unrelated auth event. Recovery now retries after 2, 5, and 15 seconds, measured
after the preceding attempt completes. Reconnection and the Retry loading button
also retry without reloading the application. Concurrent recovery requests share
one operation, auth work remains serialized, and cleanup cancels timers/listeners.
Successful resolution and clearing auth state stop recovery.

Identical concurrent direct inventory reads and cloud NHIS issue-count reads now
share pending work within the same cached session object and request arguments.
Results are not cached after completion. Different sessions and branch/filter
arguments remain separate, and failed requests are removed so retry is possible.
Offline read routing, clinical rules, stock quantities, RLS and permissions are
unchanged. This reduces duplicate concurrent work; it does not consolidate all
counter SQL or replace full inventory reads with server-side search.

## Evidence and limits

Two production snapshots from September 15, 19:46–20:24 UTC, showed inventory
listing as the largest measured query cost, but did not establish sustained
resource exhaustion. These changes address confirmed client recovery/concurrency
issues; they do not establish the outage's root cause. Rejected drug writes need
the deployed policies and request context. No production deployment or database
migration is included. Query-plan/index optimization remains separate work.

## Verification

Regression coverage includes bounded recovery, no overlap, cleanup, recovery on
online/manual events, pending read sharing, session/filter isolation, fresh reads
after completion and retry after failures. Existing auth, inventory and NHIS
service suites are included in validation. Final command outcomes are reported
in the task response.

## Rollback

Revert the recovery and coalescing changes and their protected file fingerprints.
No database rollback is necessary.
