# Production Baseline Rollback Rehearsal - 2026-08-05

## Scope

This was a local, non-production rehearsal of the recovery instructions for
`healthflow-production-baseline-2026-08`. No Vercel deployment, Supabase Edge
Function deployment, database restore, migration, installer release change, or
production configuration change was performed.

## Baseline Identity

- Annotated tag: `healthflow-production-baseline-2026-08`
- Tag target: `f29d41f345d96d998ded21258768285ca361f4b7`
- Isolated checkout: detached Git worktree under the Windows temporary folder
- Baseline migrations: 74

## Rehearsal Results

| Check | Result | Evidence |
| --- | --- | --- |
| Resolve immutable tag | PASS | Tag resolves to `f29d41f345d96d998ded21258768285ca361f4b7`. |
| Create isolated baseline checkout | PASS | Detached worktree created without modifying the production workspace. |
| Restore root dependencies | PASS | `npm ci` completed. |
| Restore local branch server dependencies | PASS | `local-branch-server/npm ci` completed. This is required before running the historical full suite. |
| Build baseline frontend | PASS | Production build completed and `dist/index.html` exists. |
| Recover Edge Function source | PASS | `tier-access` and `_shared` were archived directly from the immutable tag into a local TAR file. Nothing was deployed. |
| Run historical full test suite | PARTIAL | The suite ran with `vitest run`, but was not green: two installer command suites fail to parse their shebangs under the current Vite/Vitest toolchain, and the 1,001-attachment signing-batch test exceeds its 5-second timeout. |
| Validate database restore | NOT EXECUTED | Docker is not installed and no non-production database target is configured. Production was deliberately not touched. |
| Rehearse Vercel redeployment | NOT EXECUTED | No non-production Vercel target is configured. |
| Rehearse Edge Function deployment | NOT EXECUTED | No non-production Supabase target is configured. Source recovery was verified locally only. |
| Rehearse installer release rollback | NOT EXECUTED | Requires a non-production application and release record to prove disable, rollback, signed download, and audit behavior safely. |

## Historical Test-Suite Findings

The baseline application build is recoverable, but the following test-harness
items must be resolved before claiming that a rollback has been fully rehearsed:

1. `scripts/disable-offline-installer.test.js` fails while transforming the
   `.mjs` command because the shebang is encountered after generated imports.
2. `scripts/release-offline-installer.test.js` fails for the same reason.
3. `src/services/nhisService.test.js` test "splits more than 1000 prescription
   attachment paths into safe signing batches" exceeds the 5-second test timeout.

These findings do not alter or invalidate the immutable baseline tag. They mean
the historical suite is not fully green with the current local Node/toolchain
combination. CI uses Node 20; this rehearsal ran on the locally installed Node
24 toolchain, so the same commands must also be repeated under Node 20.

## Required Hosted Rehearsal

Before marking rollback readiness complete:

1. Provision explicit non-production Vercel and Supabase targets.
2. Restore a sanitized backup into the non-production database.
3. Redeploy the frontend from the immutable tag.
4. Deploy only one selected Edge Function from the tag and verify its health.
5. Exercise installer disable and rollback using a non-production release.
6. Run `docs/production-business-rules.md` and the production operations
   checklist against that environment.
7. Record deployment IDs, function versions, backup identity, test evidence,
   and rollback timings in a second rehearsal report.

## Safety Conclusion

The immutable source can be checked out, dependencies can be restored, the
frontend can be built, and Edge Function source can be recovered without
touching production. A complete operational rollback is **not yet proven**
because hosted deployment and database recovery require an isolated staging
environment.
