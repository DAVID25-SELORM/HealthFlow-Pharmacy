# Workspace load recovery

Date: 2026-11-15

A shop saw "Unable to load workspace. Your staff profile could not be loaded. Your session
has been retained." and a page refresh loaded it. It happens to shops from time to time.

## Cause
`AuthContext` loads the staff profile and workspace after sign-in and after every page load.
If that request fails for a temporary reason (25-second timeout, dropped connection, busy
server, rate limit, or the browser's sign-in lock held by another tab) the session is kept
and the screen above is shown. Until now HealthFlow retried three times (2, 5 and 15 seconds)
and then stopped; the screen waited for a click on "Retry loading". A refresh starts a fresh
load with a clean counter, which is why it worked. The address in the report ended with the
automatic deployment-recovery reload parameter, and two HealthFlow tabs were open, so a new
version going live and tab contention are likely contributors. The exact failure at the shop
was not visible, which is why the failure category is now kept.

## Behaviour after this change
- Unchanged: the session is never cleared for a temporary failure; a confirmed authentication
  failure still signs the user out; the quick retries (2, 5, 15 seconds) and the retry on
  reconnect and on "Retry loading".
- After the quick retries fail, the page is reloaded once (`workspaceAutoReload`), at most once
  every 5 minutes, never while the device is offline, and never if the cooldown cannot be kept.
- If the reload is declined, or the problem continues, HealthFlow retries every 30 seconds, up to
  40 times, instead of stopping.
- The screen says why in plain words (slow answer, dropped connection, busy server, too many
  requests, another HealthFlow tab signing in) and that it is trying again automatically.
- The last 10 failures are kept on the device as category and time only (`workspaceLoadFailure`),
  never an error message, user, organization or patient detail.

## Not changed
Sign-in, sign-out, session validation, profile and workspace queries, timeouts, billing or
access-pause screens, roles and permissions. Server-side logging of these failures is not added.

## Rollback
Revert the pull request. Retries return to three quick attempts followed by a manual retry.
