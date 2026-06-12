# NHIA CCC Credential Source Rollback Note - 2026-06-11

## Purpose

Fix hosted CCC generation reading stale or mismatched NHIA API credentials after Settings save.

## Source Files Changed

- `src/services/nhisService.js`
  - Removed frontend direct/legacy hosted reads from `organization_nhia_integrations`.
  - Made hosted NHIA settings use `tier-access` / `nhia_configuration` as the source of truth.
  - Clears `healthflow.nhiaApiSettings.v3` and per-organization cache keys before/after credential changes.
  - Forces backend readback after cloud save and requires `hasApiKey === true` / `hasApiSecret === true` when credentials are saved.
  - Keeps hosted CCC generation routed through `tier-access:generate_nhia_cc_code`.

- `src/pages/Settings.jsx`
  - Forces NHIA settings readback after save with `getNhiaApiSettings({ forceRefresh: true })`.
  - Confirms saved credential flags before showing success.
  - Keeps NHIA debug logs DEV-only and redacted.

- `supabase/functions/tier-access/index.ts`
  - Reads NHIA settings with service role from `nhia_configuration`.
  - Chooses the newest active branch/org scoped settings row to avoid stale branch credentials overriding fresh org credentials.
  - Decrypts and confirms saved credentials internally before returning masked settings to the client.
  - Separates stored encrypted credentials (`hasStoredApiKey` / `hasStoredApiSecret`) from successfully decoded credentials (`hasApiKey` / `hasApiSecret`).
  - Stops CCC generation before calling NHIA when saved credentials cannot be decoded by the Edge Function encryption key.
  - Keeps CCC generation on `POST https://elig.nhia.gov.gh:5000/api/hmis/genCCC` using `x-nhia-apikey`, `x-nhia-apisecret`, `accept`, and `content-type` headers.

- `src/services/nhisService.test.js`
  - Updated tests to enforce tier-access readback as authoritative.
  - Added cache clearing/readback coverage.
  - Updated legacy/direct row tests to confirm the frontend no longer reads `organization_nhia_integrations`.

## Generated Files Changed By `npm.cmd run build:offline`

- `local-branch-server/public/index.html`
- `local-branch-server/public/service-worker.js`
- Hashed files under `local-branch-server/public/assets/`

The exact asset filenames change whenever Vite rebuilds the offline application.
Hosted branch-update ZIPs are removed from this offline output after the build;
they remain available only under the root `public/branch-updates/` release path.

## Deployment

- Deployed Supabase Edge Function `tier-access` to project `bcvmiwmhtvtqrvzdovin`.

## Rollback

To roll back this specific change, revert the source files above and rebuild the offline bundle with `npm.cmd run build:offline`. If hosted behavior is rolled back, redeploy `tier-access`.
