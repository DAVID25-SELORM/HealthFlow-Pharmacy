# NeHFAMS rollout audit - 2026-10-20

Decision: NO-GO for production. Eligible for explicitly authorized sandbox verification only. No NHIA calls, production configuration changes, deployments or production migrations were performed.

## Branch failure

A detached comparison worktree at D:/APPS/HealthFlow-nehfams-baseline-audit was created at dc37269b; the current uncommitted work was preserved. The exact targeted test failed on baseline with NHIS_ONLINE_SERVING_REQUIRED. Its fixture used saveOfflineRecord to create status=served, contrary to the intentional cloud coverage guard. Changed only that fixture to use importOfflineRecords, the existing path for authoritative cloud history. No production guard or serving behavior changed. The branch suite and coverage guard suite then passed all 20 tests. Comparison worktree retained for inspection.

## Implementation defects corrected

1. Cached results reconstructed through manual reconciliation might omit environment. Cached responses now restore it from the reservation, with a policy fallback, so test results cannot populate production claim forms. The SQL cached response includes the ledger environment.
2. A thrown exception while updating an unknown outcome could replace the user-facing reconciliation reference. The reservation remains durable; the error now preserves its ID even if outcome persistence throws. No retries or fallback were added.

## PostgreSQL proof

Docker desktop-linux; private disposable container hf-nehfams-audit-20261020, image public.ecr.aws/supabase/postgres:17.6.1.171, PostgreSQL 17.6, --network none, no published ports. Only synthetic data and a minimal schema fixture. Migration files 20261010090000, 20261020200000 and 20261021090000 applied there, not to production. Independent psql sessions were observed waiting on database locks via pg_stat_activity before the holding transaction was released.

scripts/verify-nehfams-postgres.py records these checks:
- Concurrent duplicate reservations: first commits; blocked second rejects unresolved outcome.
- Rollback: first rolls back; second successfully creates a new reservation.
- Both scenarios repeated for enabled, validated NeHFAMS test provider.
- Trigger-injected outcome persistence failure leaves pending reservation; duplicate remains blocked; unknown state can subsequently be recorded.
- Successful production ledger fixture links to matching claim. Wrong tenant, branch, member and CCC are rejected.
- Failed claim persistence leaves succeeded ledger intact and reusable from cache.
- Wrong tenant and branch reservations are rejected.

This establishes actual independent-connection lock behavior. It is not full-schema deployment compatibility or external NHIA behavior. Test container removed after verification; no existing containers changed. The script expects this dedicated disposable container and a fresh database name and fails rather than dropping an existing database.

## Uncertain outcomes

Local guarantees: one transport call; redirects rejected; no fallback; success only after response validation and ledger persistence; network/HTTP/application/malformed failures after dispatch retain pending/unknown protection; claim insert rollback does not delete external attendance evidence. SQL tests and transport mocks cover different layers, not an atomic external/database transaction.

If both outcome writes fail, the durable pending reservation remains discoverable and blocks retransmission. If the external response is lost, HealthFlow cannot reconstruct it without NHIA evidence. Existing manual reconciliation requires administrator evidence and a request at least five minutes old. A timeout is never proof of non-creation. No lookup endpoint is invented.

Remaining limitation: a failed repeat connection-validation attempt does not automatically revoke an earlier successful validation until its 24-hour local validity expires. The next generation still authenticates with NHIA, but strict immediate revocation is not yet implemented. Address before rollout. The UI/backend also retain documented PascalCase parsing; prior production observations of lower-camel-case responses must be reconciled explicitly with the supplied contract.

## Prepared test matrix - NOT EXECUTED against NHIA

| Test | Expected outcome | Evidence required |
|---|---|---|
| GET hpinfo, correct test credentials | Expected HPN/name match; validated mode and boolean OTAC flag; version-bound validation | Redacted response shape, timestamp, environment and stored validation version |
| GET hpinfo, wrong facility | No activation | Mismatch error; unchanged disabled state |
| 1FA, OTAC disabled | Request without OTAC; accept only validated attendance | Redacted request keys and response, ledger ID and succeeded state |
| 2FA, OTAC enabled | Four-digit client OTAC required | Missing/invalid code rejected before dispatch; authorized valid-code response and ledger |
| 2FA without OTAC / 3FA | Unsupported workflow blocked | Zero attendance calls, clear configuration error |
| Invalid credentials | Validation fails; no activation | HTTP classification without credential/body leakage |
| Invalid card/application failure with HTTP 200 | No success; conservative unknown after dispatch | StatusCode=1 fixture/authorized response; unresolved ledger; no second POST |
| Malformed response | No success | Mock missing fields, wrong types/casing; unresolved ledger |
| Date | Exact documented YYYY-MM-DD matching requested day | Compare actual sandbox serialization; reject timestamp variants until explicitly supported |
| CCC leading zero | Preserve five-character string exactly | Request result, ledger and synthetic claim payload retain 01234 |
| Timeout/lost response | Unknown/pending, no replay/fallback | Local fault-injection call count, blocked duplicate; NHIA confirmation required for reconciliation |
| Ledger write failure | Pending/unknown stays durable | Injected DB failure, request reference retained, duplicate blocked |
| Claim persistence failure | Existing attendance remains retrievable | Failed synthetic claim transaction then cached attendance; no new external request |
| Claim linkage | Matching production fixture allowed; mismatches and test-to-production links rejected | SQL constraints/trigger assertions and SQLite reload test |

Malformed/timeout cases should be exercised with mocks or an authorized proxy in an isolated test harness, not by deliberately disrupting a real production request. All personal response values must remain in protected evidence, not repository/log output.

## Sandbox procedure requiring explicit authorization

1. Authorize the official test environment https://elig.nhia.gov.gh:5007, the workbook's test accounts/members, specific operations and number of attendance creations. No production account or real patient number.
2. Prepare a disposable HealthFlow test database/backend; apply the migrations and configure test-only credentials securely. No secret values in committed files. Keep production generation blocked.
3. Execute authorized read-only hpinfo for the documented 1FA and 2FA accounts. Establish the test facility HPN/name, actual field casing and types. Confirm permission to use the supplied test data and the authorized client OTAC acquisition procedure.
4. Review any contract differences before changing the parser. Confirm omitted versus empty OTAC handling for 1FA.
5. With explicit attendance-creation authorization, enable only the test environment and reserve each request before one POST. Record protected evidence and normalized ledger outcome. Never replay an uncertain POST.
6. Confirm claims cannot consume test attendance. Verify normalization/persistence with synthetic production-shaped fixtures locally. Disable test activation after the session.

Open NHIA questions: actual response casing/date serialization; StatusCode=1 and HTTP-error no-creation guarantees; duplicate/newCCC behavior; supported reconciliation/status retrieval process; 2FA non-OTAC/3FA workflows; test OTAC procedure. Referral endpoints are not attendance lookup substitutes.

## Addendum - verification session 2026-10-20

A later session re-verified this audit's claims against the code and re-ran the tests and the PostgreSQL checks in a new disposable container. Results, additional isolation checks and one defect found and fixed (implicit attendance generation during claim saving) are recorded in `docs/nehfams-test-integration.md`. The first authorized test steps are in `docs/nehfams-authorized-test-procedure.md`. The audit's figure of 20 branch tests was not reproducible as one number.
