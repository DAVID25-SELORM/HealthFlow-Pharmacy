# Facility-wide NHIS serving protection

The cloud `guard_nhis_active_coverage_on_serve` trigger applies to the shared
NHIS medicines table for every facility. It is independent of the optional stock
deduction setting. Both `serve_nhis_claim_direct` and `serve_nhis_claim_medicines`
execute the guard before committing a supply. Matching recorded supplies can come
from another facility. There is no staff override for overlapping coverage.

The user confirmed on 2026-10-03 that NHIS serving must remain blocked if an
authoritative online coverage check cannot be made. The hosted browser now rejects
local branch serving before sending a request, including to older branch servers.
The branch repository also rejects completed-supply writes and serving queue calls
before changing records, stock or outbox entries. Draft preparation and importing
existing authoritative cloud history remain available. To serve, sync the pending
claim and open it in the cloud workspace with a valid online session.

## Verification

- Actual PostgreSQL direct-serving and dispensary RPCs tested for three independent
  facility identities, without facility-specific configuration.
- Prior supply at another facility blocks the repeat.
- Five days of paracetamol repeated on day two is blocked.
- SQLite integration verifies that blocked local serving preserves stock and queues.
- Hosted-browser branch write entry points reject serving before network requests.

## Rollout boundary

Deploying the cloud site does not replace apps already installed on offline branch
machines. The updated branch source must be packaged and installed there, and their
local serving rejection verified, before claiming all offline installations are
protected. Previously queued historical supplies are not deleted or rewritten.
An offline machine running old software cannot learn about a new server rule until
it reconnects and updates. Protection uses supplies recorded in HealthFlow; it cannot
detect unrecorded supplies or supplies held only by disconnected old installations.


## Additional audit ? pending deployment

The coverage integration fixture now executes the August 20 clinical-date patch
and August 23 facility-label patch, not just the August 1 overlap definition.
All 23 coverage integration cases pass, including prior served-at dates, missing
clinical dates, inactive membership, missing patient identity and missing medicine
code. The fixture executes the coverage portion of the August 20 migration; it
does not test its unrelated branch synchronization adapters.

Migration `20261003120000_require_identity_for_nhis_coverage.sql` adds explicit
member/HIN, medicine-code and active-membership requirements at the authenticated
serving boundary. This migration has NOT been applied to production. Browser
access to the SQL editor timed out during the audit. No real claims were served
or changed for testing. All-facility certification remains pending production
verification and installation/verification on every offline branch machine.

Further audit remains required for requested dispensing-date selection, edits to
served claim identities/dates, concurrent serving, and legacy branch replication.
Passing these tests must not be described as completing those outstanding checks.


## Production export review

The user reported successful execution of migration 20261003120000 and supplied a
production screenshot confirming the serving trigger is enabled (O). The exported
coverage definition in `Supabase Snippet Untitled query (10).csv` confirms global
candidate lookup and clinical-date helpers, but declares the caller organization
without assigning it. This reproduces the earlier CRLF-sensitive patch defect.

New migration 20261003130000 patches only the scalar lookup membership assignment
and active-user gate, preserving its deployed coverage calculation. Its integration
fixture uses the exact exported function body and exercises rerunning the patch,
own-facility reference visibility, foreign-reference privacy despite a spoofed
organization parameter, and direct inactive-user rejection. Deployment of this
new migration remains pending. No all-facility certification is made.


## Serving-date correction

User reported successful application of 20261003130000. New pending migration
20261003140000 aligns the incoming supply date with the existing clinical-date
helper (dispensary date, actual served timestamp, then claim service date), and
rechecks served-at/catalog-identity changes rather than skipping those updates.
The direct-serving RPC tests now supply explicit historical dispensary dates;
otherwise the real RPC stamps today's served_at and would test a different day.
Production deployment of this new correction remains pending. Offline installer
rollout and the other previously listed audit items remain outstanding.


## Served-header audit

User reported successful application of 20261003140000. Pending migration
20261003150000 adds an AFTER UPDATE claim-header check for signed-in edits to
member/HIN, service date or organization when supplied medicine lines exist.
It rejects overlaps and missing patient identity atomically, prohibits moving a
served claim between organizations, and permits unrelated metadata and unserved
claim edits. The 32-case coverage suite passes, including four new header cases.
These tests cover header correction behavior in isolation, not every production
trigger or RPC combination.

The legacy branch_sync_complete_nhis_serving implementation inspected in migration
20260907102000 authenticates a branch token and reconciles inventory but does not
perform a medication coverage lookup. Rejecting historical sync is not equivalent
to preventing offline physical supply. Existing historical sync has been preserved;
rollout of the online-only local serving software remains necessary and unverified.
Concurrency, status changes affecting candidate visibility, same-claim repeat lines,
and full production-trigger interactions remain outstanding verification areas.


## Real PostgreSQL concurrency check

User reported successful application of 20261003150000. On 2026-10-03 the
`scripts/verification/nhis-concurrency.py` check passed against a disposable
PostgreSQL 17.6 Docker container with two independent psql connections. The first
Serve Directly transaction held its successful serving uncommitted for eight
seconds; the concurrent second claim for the same member and medicine was rejected
after the first committed. Exactly one claim was served and the rejected claim's
medicine quantity remained zero. No production connection or real records were used.
This validates same-member direct-serving contention under the fixture and default
isolation, not differing identifier aliases, every RPC combination or every
production trigger interaction.

`scripts/verification/nhis-production-rollout.sql` provides read-only enabled
trigger and active branch registration queries. It deliberately excludes patient
records and branch credentials. Branch inventory protocol version is not evidence
that the online-only serving guard is installed; each active installation still
requires verification. No new migration was needed for this concurrency result.


## Combined regression verification

33 coverage cases now include both coverage guards enabled while running actual
direct and dispensary RPCs: overlap is rejected and a supply after expiry succeeds.
Together with eight online-serving checks and three SQLite repository checks, 44
tests passed under Node 22. The branchServerApi worker timed out at startup in the
combined run; a separate default-runtime run passed all nine cases. Total: 53
passing cases across the four files, with the initial worker failure disclosed.
ESLint and git diff --check passed. The rollout query now returns one exportable
result set and explicitly reports missing triggers or zero active registrations;
that behavior was verified against an empty isolated PGlite fixture.
Actual production rollout query results are still awaited. No new production
migration or offline installation was performed in this verification step.


## Export-confirmed rollout and identifier concurrency correction

Production export (12) confirms both coverage triggers present/enabled O. User
confirmed ABC and WESTPOINT operate entirely online; export (13) confirms all ten
identified branch registrations inactive. The identified offline-registration
rollout issue is closed; this is not a claim that every other path is certified.

A real PostgreSQL two-connection test reproduced a missed overlap when the first
claim had member number plus HIN, and the second had only that same HIN: the old
coalesce-based locks differed and both transactions served. Pending migration
20261003160000 locks every nonempty normalized member/HIN identifier in numeric
lock-key order in both serving and claim-edit guards. The exact formerly failing
HIN concurrency case passes after the patch, and the 33-case coverage regression
suite passes. The migration is rerun in the concurrency fixture to check idempotence.
This does not infer links between records with no shared supplied identifier.
Production application of 20261003160000 remains pending.


## Consolidated production verification

User reported successful application of 20261003160000. The consolidated read-only
`scripts/verification/nhis-final-deployment-check.sql` returns eight rows: five
function bodies/permissions, both exact trigger bindings/event masks, and active
branch registration count. It passed against the patched PostgreSQL 17.6 fixture.
Production output is still needed to independently verify the latest deployed
bodies. Source-marker presence alone is not treated as behavioral certification.
Earlier "pending" entries in this document describe the state at their audit step;
user-reported applications and supplied exports above supersede those statuses.
Same-claim repeat lines, status transitions that affect candidate visibility, and
full production trigger/RPC combinations remain outside the completed checks.


## Production deployment export (15) verified

Read the full eight-row production export supplied by the user. Both triggers
are enabled O and bound to the intended functions/events. Both guard bodies call
lock_nhis_coverage_identifiers; the helper locks both normalized identifiers in
sorted key order. The incoming and prior dispensing dates use the clinical-date
helper. The scalar overlap body contains the actual active-user organization
assignment and cross-facility candidate lookup. Anonymous callers cannot execute
the overlap RPC; neither anonymous nor authenticated roles can directly execute
the private guards or locking helper. The immutable date-only helper is executable
by anon in this export; it reads no tables and does not expose clinical records.
Active branch registrations: zero.

This verifies deployment of the inspected fixes, not every NHIS workflow. The
remaining scope limitations recorded above still apply. No further SQL is needed
merely to establish the deployment facts in this export.
