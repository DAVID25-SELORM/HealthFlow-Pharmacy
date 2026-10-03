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
