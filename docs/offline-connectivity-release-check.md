# Offline setup and facility connectivity release check

11 September 2026. User authorized repository push after the earlier local-only review.

## Validation

- Full regression: `npx vitest run --maxWorkers=1` — 154 files, 981 tests passed in 419 seconds.
- Lint passed.
- Production build passed.
- Protected production baseline passed.
- All 114 migrations passed protection checks.
- Staged diff whitespace checks passed.

The earlier concurrent run had worker-startup timeouts and an offline-auth timeout. The complete single-worker run passed without changing test timeouts or assertions.

## Remaining rollout work

Apply `supabase/migrations/20260911010000_add_facility_connectivity.sql` in the target database. Until then the dashboard reports connectivity unavailable; it does not infer that facilities are offline.

The offline connection check requires an updated local branch server. No installer was built or installed in this review. Complete the physical outage/reconnection checklist in `offline-outage-acceptance.md` on the Main Computer and each workstation before declaring facility offline readiness.

Earlier review documents describe their local-only state at the time of review. Repository delivery does not establish that production deployment, database migration, installer distribution or live acceptance has completed.
