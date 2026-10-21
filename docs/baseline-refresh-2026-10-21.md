# Protected baseline refresh, 2026-10-21

The protected production baseline (`config/production-baseline.json`, checked by `npm run protect:baseline`) has failed on `main` for two files. This change records, for each file, exactly what changed since its fingerprint last matched, so a reviewer can confirm the current content is intended before the fingerprints are accepted.

Nothing in application code, migrations or configuration changes here: only the two fingerprints and this report.

CI note: the failure was hidden because the earlier `Check production dependency vulnerabilities` step has failed on every push to `main` since 10 Oct, so the baseline step never ran in CI. The dependency fix is a separate pull request.

## What the check compares

SHA-256 of each critical file with line endings normalized to LF. The two values below were recomputed from the committed files on `main` (`dc37269b`).

| File | Manifest value (before) | Committed value (after) |
|---|---|---|
| `src/services/nhisService.js` | `f29976b617f2ece8f91c566130fa1d98695bf1c83ca6bbb6ca0c7af932456779` | `1b4aa9c4c62fb2a4a917e5d16dd18e69f8062f2d7134237a4df13c94bf6e60c0` |
| `supabase/functions/tier-access/index.ts` | `16f30f8eede1d0dc5e4e8d7eabbbf9b38a4e58b5708abb761a8ffd679f31aa3b` | `5ebdd6ef1e2641d14edeb08f8cd2311d3386c58b7a2c916eb9aa460dfd473752` |

The other nine protected files already match and are untouched.

## `src/services/nhisService.js`

Last matched at `3e9e3b86` (2 Oct). Net change since: +11 / -6 lines, from two commits.

- `3a59b8cb` (10 Oct) Add organization-scoped CCC providers and secure OTAC routing. When the attendance came from OTAC or a reconciled NHIA record, the provider's attendance date is kept for the NHIA/CXF audit field on create and update; for every other source the field is still the pharmacy service date, as before.
- `dd1076a6` (4 Oct) Adapt export verification batches to database timeouts. If signing produced warnings or any claim has no fingerprint, the export now stops with "Export verification could not complete. No file was generated." (fails closed instead of producing a file).

Rules touched: NHIS-001 (CCC readiness: unchanged), AUDIT-001 (attendance evidence preserved). Claim-IT field order, serializer and locked export contract are unchanged (their protected hashes still match).

## `supabase/functions/tier-access/index.ts`

Last matched at `a1add925` (25 Sep). Net change since: +132 / -22 lines, from eight commits.

| Commit | Date | Change |
|---|---|---|
| `3a59b8cb` | 10 Oct | Organization-scoped CCC providers (existing, OTAC), reservation ledger, branch-server CCC endpoints authenticated with the scoped sync token, administrator policy actions |
| `60ce35ce` | 10 Oct | Audited administrator viewing of retained OTAC tokens (writes `ccc_policy_audit`, response not cacheable) |
| `0ce52ebc` | 10 Oct | Unresolved CCC requests listed ahead of recent history |
| `4ec3b303` | 12 Oct | Existing-provider dispatch tracking: failures before anything is sent are retryable |
| `9a44481f` | 13 Oct | Merge of live-deployed behavior: blank expiry for consumables and similar categories, spreadsheet import keeps sale class when omitted, no-op catalog rows skipped |
| `9584750f` | 13 Oct | Clear NHIA refusals (explicit rejections, 4xx other than timeout or rate limit) are retryable with a clear message |
| `c874b540` | 20 Oct | NeHFAMS connection preparation with live generation disabled; saved facility credentials reused |
| `dc37269b` | 20 Oct | Reuse of facility-saved NHIA credentials for NeHFAMS preparation |

Also in this range: the CCC request body is no longer logged (redacted to the action name only), and the existing NHIA CCC call now refuses redirects and times out after 25 seconds.

Rules touched: NHIS-001, AUDIT-001. Administrator and branch checks for the new actions are enforced server-side; existing actions are unchanged. Tenant and branch scoping for the new actions comes from the authenticated profile, not the request payload, except for platform administrators acting on a selected facility.

## Verification

- `npm run protect:baseline` passes with the new values and fails if either file changes again.
- `npm run protect:migrations`, `npm run lint`, `npm run build`: pass.
- Characterization coverage for these files: `src/services/nhisService.test.js` and the provider suites listed in the pull request description.
- Windows note: 10 source-text contract tests fail on a CRLF checkout and pass on the Linux CI checkout.

## What approving this means

Accepting these fingerprints states that the two files on `main` are the approved baseline. It does not approve anything not already on `main`: the NeHFAMS production enablement branch will change `tier-access/index.ts` again and needs its own refresh in its own reviewed change.

## Rollback

Revert the commit; the check then fails again exactly as it does on `main` today.
