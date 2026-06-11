# Local Sync / CCC Routing Rollback - 2026-06-11

Backup requested for comparison:

- `C:\HealthFlowLocal\local-branch-server.codex-backups\local-sync-fix-20260611-141932`

Result:

- The requested backup path was not present on this machine during this rollback pass.
- Rollback was therefore scoped from git history for the last CCC/local-sync commits:
  - `3e005f7 Route pharmacy CCC through local server`
  - `13b770e Enforce local NHIA CCC verification`

Files changed in the last CCC/local-sync commits:

- `src/pages/Nhis.jsx`
- `src/services/branchServerApi.js`
- `src/services/connectivityService.ts`
- `src/services/connectivityService.test.ts`
- `src/services/nhisService.js`
- `src/services/nhisService.test.js`
- `supabase/functions/tier-access/index.ts`
- `local-branch-server/src/server.js`
- Generated offline bundle files under `local-branch-server/public/`

Files restored or changed in this rollback:

- `src/pages/Nhis.jsx`
  - Restored the CCC generation handler to the last working route selection:
    - local branch path when `shouldUseOfflineNhiaUrl` is true
    - hosted Supabase path otherwise
  - Removed the newer handler-level connectivity probe, branch runtime fallback IDs, route logging, and local settings prefetch that could send CCC verification through the wrong route or create an undefined `organizationId`.
- `local-branch-server/public/`
  - Refreshed with `npm.cmd run build:offline` after the browser console showed stale compiled assets still running the removed `[NHIA CCC] route` handler.
- `dist/`
  - Refreshed with `npm.cmd run build` after stale compiled CCC routing was also found in the regular production build output.

Files intentionally preserved:

- `local-branch-server/src/server.js`
  - Preserved local branch runtime/service setup.
- `src/services/branchServerApi.js`
  - Preserved branch server URL/token/runtime support and error body propagation.
- `src/services/connectivityService.ts`
  - Preserved local branch health probing behavior.
- `src/services/nhisService.js`
  - Preserved local-mode protection for hosted CCC generation.
- `local-branch-server/node_modules/`
  - Not touched; preserves the fixed `better-sqlite3` setup.
- Dashboard, drugs, patients, claims, tier access, Supabase routing
  - Not changed.

Verified CCC endpoint rule:

- Local branch CCC generation still reaches `POST https://elig.nhia.gov.gh:5000/api/hmis/genCCC`.
- Required headers remain `x-nhia-apikey`, `x-nhia-apisecret`, `accept: application/json`, and `content-type: application/json`.
- Request body remains `{ "CardNo": "...", "CardType": "NHISCARD" | "GHANACARD" }`.
