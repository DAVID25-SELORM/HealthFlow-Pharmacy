# Authentication Request Resilience Impact Report

## Approval and scope

The product owner explicitly requested completion of the previously uncommitted
authentication, audit, tier-access, and diagnostics work. This change is limited
to transient request handling and operational diagnostics.

## Changed behavior

- Identical concurrent password sign-in submissions share one request.
- A corrected password submitted while an earlier attempt is pending starts a
  separate request.
- Transient read-only tier-access failures retry with bounded backoff, including
  `check_*` actions. Mutating actions are not automatically retried.
- Audit events that fail because the network is unavailable are queued locally
  and retried after connectivity returns. A permanently invalid queued event is
  discarded so it cannot block later valid events.
- Edge Function failures emit structured, sanitized diagnostics containing
  operational context without credentials or patient data.

## Preserved behavior

- Supabase password authentication and session establishment are unchanged.
- Role resolution, tenant membership, branch access, RLS, and organization
  isolation are unchanged.
- Audit failure remains non-blocking for user workflows.
- NHIS, CLAIM-it/CXF, Ghana Card/HIN, CCC, scrub rules, pricing, tariffs, claim
  totals, dispensing, exports, offline sync, and storage behavior are unchanged.
- Existing Edge Function request payloads and server-side authorization remain
  unchanged.

## Files and functions

- `src/context/AuthContext.jsx`: `signIn`
- `src/lib/supabase.js`: `invokeSupabaseFunction`
- `src/services/auditService.js`: `tryLogAuditEvent`, `flushPendingAuditEvents`
- `src/services/tierAccessService.js`: read-action classification and retry path
- `src/utils/requestDiagnostics.js`: sanitized diagnostic construction/logging
- Focused regression tests beside the affected modules

## Regression coverage

- Exact duplicate sign-in requests are coalesced.
- Corrected concurrent credentials are not coalesced.
- Network-failed audits are queued and retried.
- Invalid queued audits do not poison the queue.
- Safe `check_*` tier actions retry after transient network failure.
- Mutating tier actions remain non-retrying.
- Diagnostic logs preserve operational fields and redact sensitive fields.

## Risk and rollback

The principal risk is additional retry traffic during a transient outage. Retries
are bounded and restricted to read-only actions. Roll back this commit to restore
the prior request behavior; no database rollback or data migration is required.

The protected `AuthContext` checksum was updated after characterization tests were
added. The production baseline ID and reference commit remain unchanged.
