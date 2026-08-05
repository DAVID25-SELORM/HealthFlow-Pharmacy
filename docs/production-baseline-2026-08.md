# HealthFlow Production Baseline - August 2026

## Identity

- Baseline tag: `healthflow-production-baseline-2026-08`
- Commit: `f29d41f345d96d998ded21258768285ca361f4b7`
- Branch: `main`
- Captured: `2026-08-05T04:15:32Z`
- Frontend package version: `1.0.0`
- Tracked repository migrations: 74
- Deployed-function source directories: 8
- Test files: 88
- Production frontend: `https://healthflowcloud.com`
- Supabase project reference: `bcvmiwmhtvtqrvzdovin`

This is a repository baseline. Hosted migration, function, RLS, storage-policy, and environment state must also be checked in the Supabase and Vercel deployment records before rollback. No secrets are stored here.

Pending, untracked migrations are deliberately excluded. They become protected only after review, commit, deployment verification, and an intentional baseline update.

## Protected Surface

The machine-readable hashes in `config/production-baseline.json` protect the central NHIS, authentication, staff, Recycle Bin, offline-release, and tier-access implementations. A legitimate change must include owner approval, updated characterization tests, an impact report, and an updated hash.

Environment names used by production include `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, HealthFlow monitoring credentials, and installer-release deployment credentials. Values belong only in approved secret stores.

## Verification

Run:

```bash
npm run verify:production-baseline
```

This verifies protected hashes, migration structure, contract/golden tests, the complete test suite, lint, and the production build. If the workspace contains unrelated uncommitted work, run the focused gates first and record any unrelated full-suite failure separately; do not weaken or update the baseline to hide it.

## Rollback

1. Stop publication of the affected frontend, Edge Function, migration, or installer release.
2. Preserve logs, request IDs, audit records, and the current database backup.
3. Compare the deployment commit with this baseline tag and identify the smallest affected surface.
4. Frontend: redeploy the immutable baseline tag. Do not reset or rewrite `main`.
5. Edge Functions: deploy the function source from the tag individually.
6. Database: restore from a verified backup or apply a separately reviewed forward-repair migration. Never edit an applied migration.
7. Offline installer: disable the affected release and roll back through Installer Releases; preserve the ZIP and audit history.
8. Run production health checks and the workflows in `docs/production-business-rules.md` before reopening access.

Database rollback is never performed by reversing SQL blindly. A backup restore or reviewed forward repair is required because production data may have changed after deployment.
