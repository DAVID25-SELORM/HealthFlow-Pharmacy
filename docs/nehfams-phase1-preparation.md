# NeHFAMS Phase 1 preparation ? 2026-10-17

## Scope and baseline
Local branch: prep/nehfams-phase1, isolated worktree D:/APPS/HealthFlow-nehfams-prep.
Based on committed 1aa22e76. Neither original worktree was edited. The existing uncommitted CCC fixture test and dashboard edits in HealthFlow-billing-fix were not copied.
Active IDE HEAD: 6703f0b0 with unrelated dirty changes. Remote main read using ls-remote: 8411ac12135ddebc09348806e829f43a3609dbd2. The preparation baseline is an ancestor of that remote commit. No push or deployment performed.

The isolated baseline includes 4ec3b303: dispatch callback immediately before legacy fetch, timeout/HTTP/invalid-result classification, same-calendar-date comparison, no fallback after dispatch, and result-persistence failure protection. Active IDE source does not include these fixes. OTAC mapping also differs (normalized newCCC and confirmed verification status). The reservation migration is unchanged between the baselines; both lock organization policy and enforce organization/member/card/date uniqueness. Claim persistence differs substantially across these branches, including attendance normalization; do not copy entire files into the IDE checkout.
Repository history proves published source, NOT deployed frontend, Edge Function or database versions. No authenticated deployment inventory was available; deployed status remains unverified. Do not claim that local or remote main equals production. The prior successful portal call establishes the portal contract only.

## Changes
- Explicit known provider registry; no generic legacy fallback. Unknown and NeHFAMS providers fail before reservation/network calls; reserved policy is checked again to close a policy-change race.
- Separate NeHFAMS internal interface and disabled adapter. Confirmed production origin https://nehfams.nhia.gov.gh is metadata only. No endpoint, wire schema, token exchange or transport invented.
- Organization admin UI may stage NeHFAMS only with generation disabled. No credential fields or connection test are exposed. Backend and SQL reject enablement. Existing OTAC token, expiry and identity are retained when staging NeHFAMS.
- Separate service-only NeHFAMS metadata table; no speculative credential columns. A future reviewed migration and implementation are required to allow validation or live requests.
- Forward migration adds a nullable claim-to-ledger foreign key and validation trigger. New/updated claims automatically link only when organization, member, card (when supplied), date, CCC and branch scope match successful evidence. This also links draft attendance whose encounter key is not the final claim UUID. Existing rows are not backfilled. Explicit invalid links and changes inconsistent with an existing link fail. Foreign-key deletion is restrictive.
- Local branch claims receive their cloud ledger link on cloud persistence/synchronization. No local SQLite schema was changed. An offline linkage display is not implemented.
- Existing success cache, unique ledger key, policy locks and unresolved-provider-switch restrictions remain. No automatic attendance retry is added.

## Security and behavior considerations
NeHFAMS is unavailable even if a forged client enables it; registry, backend validation and SQL CHECK constraints independently block it. Only platform administrators can stage provider changes. Ordinary clients have no table permissions for new configuration. Retained OTAC credentials are never treated as NeHFAMS credentials.
Saving disabled NeHFAMS pauses generation for that organization; UI labels it unavailable. No organization is changed automatically. A currently linked claim cannot silently change its attendance identity; staff must use an intentional correction workflow. Manual/historical claims without matching evidence remain usable. Source already supports plaintext compatibility reads for old secrets; this phase does not rewrite credentials. Future NeHFAMS storage must use encryption only.

## Validation
Initial validation: 29 provider/gateway/SQL tests passed, targeted TypeScript check passed, changed-JS ESLint passed, and Vite production build passed. Additional UI and claim compatibility checks: 21 tests passed across 3 files. Total: 50 passing tests across 7 files. New UI test lint and git diff --check also passed. PGlite SQL tests exercise actual functions, constraints and triggers with synthetic fixtures, including two concurrently queued reservations. PGlite serializes those calls: this is NOT proof of independent PostgreSQL session lock scheduling. Before rollout, run a two-session PostgreSQL race test against a disposable database and a representative full migration snapshot, plus branch synchronization validation. No live database or NHIA request was used.
The isolated baseline has no project-wide TypeScript configuration. Targeted tsc checks cover provider modules; they do not establish full Deno Edge Function type coverage.

## Deployment instructions (not executed)
1. Review/rebase or cherry-pick ONLY preparation changes onto current release branch; do not deploy this historical worktree wholesale. Resolve existing unrelated changes independently.
2. Verify deployed baseline includes recent CCC safety fixes. Back up schema/policies and test new migrations in disposable PostgreSQL with representative schema.
3. Apply 20261017100000_prepare_nehfams_provider.sql, then 20261017101000_link_claim_ccc_attendance.sql after authorization.
4. Deploy backend before frontend. Existing provider defaults remain unchanged. Leave NeHFAMS disabled everywhere.
5. Validate existing/OTAC generation using authorized controlled procedures, claim linkage and branch sync. Do not use exploratory live patient records.

## Rollback instructions
Prefer application rollback with additive tables/column retained. For organizations deliberately staged to NeHFAMS, an authorized administrator must restore their prior provider and state; never mass-enable organizations. Resolve pending/unknown outcomes before switching. Preserve ledger/audit rows and credential ciphertext.
If a database rollback is necessary, first export linkage evidence, verify no organization still selects NeHFAMS, then review removal of the claim trigger/column, metadata table and new constraints. Restore prior reserve/save function definitions and grants from the approved baseline. Do not automatically run destructive rollback or drop historical records. Linked-claim correction failures may be mitigated by a reviewed trigger rollback while preserving the column.

## NHIA dependencies
Production origin is confirmed and need not be requested again. Still required: exact test host/port 5007 URL; endpoint paths/methods; API-key/secret authentication; mandatory request/response fields and status semantics; access-token expiry/refresh/rotation support; facility identity rules; member/OTAC requirements; attendance retrieval/idempotency; authorized synthetic members and sandbox credentials; rate limits/activation/network requirements.
Future work: official contract adapter, encrypted credential model, connection validation, actual sandbox Postman collection, independent-session concurrency testing, end-to-end branch persistence, pilot/rollback rehearsal. No claim of live NeHFAMS compatibility is made.

## File inventory
Modified: src/components/CccIntegrationSettings.jsx; src/pages/Nhis.jsx; src/services/cccProvider.test.js; supabase/functions/_shared/cccProvider.ts; supabase/functions/tier-access/index.ts.
Added: src/components/CccIntegrationSettingsPreparation.test.jsx; src/services/nehfamsPreparation.test.js; supabase/functions/_shared/cccProviderRegistry.ts; supabase/functions/_shared/nehfamsAdapter.ts; the two migrations listed above; this report.
Local build output: dist-nehfams-prep (not for commit). No secrets or patient fixtures added.
