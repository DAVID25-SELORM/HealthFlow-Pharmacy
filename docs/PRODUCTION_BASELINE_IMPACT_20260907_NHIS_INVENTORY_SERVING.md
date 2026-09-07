# Production baseline impact — 2026-09-07

This baseline records the reviewed NHIS serving and inventory work.

- `src/services/nhisService.js` retains the structured claims workflow and is covered by the existing NHIS medicine, duration, serving, scrub, and CXF tests.
- `src/context/AuthContext.jsx` and `supabase/functions/tier-access/index.ts` retain the active-role and subscription boundaries used by the claims workflow.
- `src/services/settingsService.js` adds the optional, administrator-controlled `nhis_deduct_inventory_on_serve` setting. Existing deployments that have not run its migration continue through the optional-column fallback with inventory deduction off.

The database implementation is migration-only and defaults every organization to stock-neutral NHIS serving. When enabled, the service uses immutable, tenant-scoped serving and inventory ledgers; records a policy-activation baseline so old served quantities are not retrospectively deducted; and requires active branch servers to attest to the dedicated offline completion protocol before the setting can be enabled.

Validation completed for this baseline: migration protection, targeted contract tests, local-branch baseline test, changed-file linting, production build, diff whitespace check, and protected-baseline verification.
