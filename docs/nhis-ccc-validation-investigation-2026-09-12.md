# NHIS CCC validation investigation

## Evidence and reproduction boundary

West Point reports removing CCC from an existing claim and successfully using the attachment/save workflow. The supplied screenshot does not establish the claim's original status, exact button, API response, dispensing result or export result. No production claim was modified to reproduce it. The precise live incident remains unconfirmed; the source bypasses below and isolated database reproductions are confirmed.

The disposable SQL fixture starts with an incomplete draft, saves an attachment without advancing it, then attempts completion, Serve, Direct Serve and a direct served-medicine insert with missing CCC. Each progression is rejected. After setting `12345`, completion and a served-medicine insert succeed. Removing CCC while saving a replacement attachment is rejected and the previously stored valid claim is preserved. A historical malformed completed fixture inserted before the migration remains readable and unchanged.

## Source bypass

`Nhis.jsx` routes attachment persistence and intake saves through `handleSubmitClaim`, then `createNhisClaim` / `updateNhisClaim`. Existing status could be preserved with `allowIncompleteReview`. That option deliberately skips general readiness blockers for incomplete intake. Separately, bridge/direct-API mode accepted empty CCC, and medicine-only updates retained only medicine blockers. Neither serving RPC had a CCC prerequisite. Thus incomplete-intake exceptions could reach completion/serving without an authoritative database check.

Readiness also used a truthy fallback from `cccNo` to `ccCode`: an explicitly cleared canonical value could be masked by an older alias. Nullish precedence now respects explicit deletion.

## Field map and rule

| Layer | Existing field / mapping |
| --- | --- |
| Database and offline JSON | `nhis_claims.ccc_no` |
| Form | `claimForm.cccNo`; legacy `ccCode` alias |
| Service writes | `cccNo ?? ccc_no ?? ccCode ?? cc_code` to `ccc_no` |
| Serving RPCs | Read persisted parent `ccc_no`; do not trust a supplied CCC |
| Export | Normalized `ccCode`, XML `CcCode`, CXF `claimCheckCode` |

The existing normalization is retained: remove non-digits and require exactly five digits, including established `CC-12345` compatibility. No external verification or new CCC field is introduced.

Incomplete drafts/intake may retain missing CCC under existing intake rules. Completed/served/submitted states and any actual medicine serving require valid CCC. Missing CCC is always a readiness/scrub/export blocker, including bridge mode. Clearing CCC on a completed claim is blocked, rather than silently retaining completeness or undoing historical dispensing. Rejected saves do not erase the stored valid CCC. Draft attachment success does not mean completion.

## Write-path coverage

| Path | Enforcement |
| --- | --- |
| New/edit Save, Save & Continue, diagnosis edits | Shared service state check plus database header trigger; incomplete intake remains permitted |
| Attachment add/save/delete | Same claim-save boundary; attachment-only draft save remains draft; completed header with missing CCC rejected |
| Medicine add/edit and dispensary Serve | Shared progress check for medicine-only save, parent-claim SQL check before replacement, served-medicine trigger |
| Direct Serve | SQL check after existing authorization and before medicine writes; frontend check before attachment upload |
| Complete / mark ready / finalize | Header trigger covers served, claim_ready, partially_served, fully_served, submitted, approved, accepted, paid and served aggregate flags |
| Scrub / bulk scrub / export / CXF | Existing readiness and all-or-nothing export gates retained; pending-mode CCC exemption removed from readiness |
| Offline Save | Shared state validation before SQLite record/outbox persistence |
| Offline serving | Shared progress validation before local inventory and serving queue work |
| Offline sync | Cloud triggers and serving RPC prerequisites apply to replayed writes |
| Admin correction | Existing correction writes encounter header/medicine triggers; historical rows are not bulk rewritten |

The SQL helper provides backend enforcement even if browser validation is bypassed. Original RPC authorization, organization lookup and row locking are retained. No RLS policy, price, duration, HIN, tariff, attachment format, inventory calculation or audit payload is changed. Frontend and local server share one JS validation module; SQL implements the same normalized five-digit rule.

## UX

Completion/serving attempts show a CCC-specific message and focus the CCC input where possible. Missing-CCC draft saves explicitly say to add CCC before completing or serving. Database exceptions contain user-facing CCC wording. No automatic CCC generation or historical demotion is performed.

## Verification and limits

The SQL test uses a disposable database with minimal tables and a stock fixture. It executes the actual new migration and invalid serving RPC paths, direct-write rejection, valid guarded writes, historical readability and existing cross-organization Direct Serve rejection. It does not exercise the full production inventory ledger, full production RLS policies or valid end-to-end RPC dispensing.

JS tests cover readiness, alias removal, protected saves, existing export regressions and offline persistence/serving rejection. The original offline inventory fixture now has a valid CCC so its original inventory-policy assertion remains meaningful. Existing contract tests characterize the surrounding NHIS behavior.

No Chrome reproduction of West Point's exact action has been completed. Before rollout, reproduce that exact action on a non-production fixture with its original status and run a full valid Serve/Direct Serve cycle against a complete staging schema. The subsequent user instruction authorizes review and Git push; database deployment remains outside this change.

## Change inventory and baseline impact

Verification results: 40 test files / 375 tests passed in the combined NHIS, offline and contract run. After final test additions, the service/offline recheck passed 2 files / 222 tests (overlapping coverage, not additional unique tests). Plain lint and the final production build passed. Protected baseline verification passed; migration protection passed for 116 migrations. The disposable SQL script passed. An initial offline inventory test failed because its fixture lacked CCC; adding a valid CCC restored that original inventory test, with separate invalid-CCC assertions added. No outstanding test failure is known.

- `src/pages/Nhis.jsx`: pre-progression feedback, focus and draft message.
- `src/services/nhisService.js`: readiness and service transition enforcement; protected fingerprint updated for this intentional change only.
- `local-branch-server/src/nhisCccValidation.js`: shared JS rule.
- `local-branch-server/src/offlineRecordsRepository.js`: pre-persistence and pre-serving enforcement.
- Corresponding service/shared/offline tests and `supabase/tests/nhis_ccc_transitions.sql`.
- `supabase/migrations/20260912170000_enforce_nhis_ccc_transitions.sql`: prospective triggers and serving prerequisites.
- This report and `config/production-baseline.json`.

Deployment is intentionally withheld. Review the migration with a complete staging schema before applying it; do not weaken guards or fabricate CCC to replay invalid queued work.

During the pre-push review, both serving RPC bodies were compared against their latest preceding migrations. Apart from the inserted CCC prerequisite, the function bodies are unchanged (ignoring whitespace). This confirms that the copied authorization, organization checks, serving calculations and updates were preserved.

Final pre-push verification: baseline, 116 migration checks, contracts and lint passed. The full suite reported 1,013 passing tests and one failed completed-claim fixture in nhiaRepositoryHospital.test.js (missing CCC). That fixture was corrected with 12345; its entire 12-test file then passed. The full suite was not rerun after this fixture-only correction. The preceding final production build passed. The exact West Point browser reproduction and complete staging dispensing remain unverified.
