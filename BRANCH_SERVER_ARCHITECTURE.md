# HealthFlow Branch Server Architecture

## Responsibilities

The branch server is the local backend for facilities that need LAN/offline workflows. It serves:

- Local POS and inventory reads/writes.
- Local patient, claim, purchase, supplier, and sales APIs.
- NHIS/NHIA settings and CLAIM-it workflows.
- CLAIM-it bridge under `/json-api` when enabled.
- SQLite persistence and background Supabase sync.
- Payment webhook and hosted payment initiation routes.

## Runtime Configuration

Configuration is loaded from `local-branch-server/.env` first, then process environment. Important groups:

- Server: `PORT`, `BRANCH_SERVER_TOKEN`, `ALLOWED_ORIGINS`
- Facility: `ORGANIZATION_ID`, `BRANCH_ID`
- Database: `HEALTHFLOW_DB_PATH`, `SQLITE_PATH`
- Sync: `SUPABASE_URL`, `SUPABASE_SYNC_KEY`, `BRANCH_SYNC_TOKEN`
- NHIS/NHIA: `NHIA_CONFIG_SECRET_KEY`, `NHIA_ELIGIBILITY_BASE_URL`, `CLAIMIT_*`, `NHIA_API_*`
- Payments: `PAYSTACK_*`, `HUBTEL_*`, `PAYMENT_*`
- Communication: `COMMUNICATION_*`, `SMTP_*`, `SMS_*`

## Important Endpoints

Public or semi-public:

- `GET /health`
- `GET /branch-runtime-config.js`
- CLAIM-it bridge at `CLAIM_BRIDGE_PUBLIC_PATH`, default `/json-api`
- Payment webhooks: `/api/payments/webhook/hubtel`, `/api/payments/webhook/paystack`

Protected by `x-branch-token`:

- Inventory: `/api/inventory`, `/api/inventory/search`, `/api/inventory/import`, `/api/inventory/:id`
- POS: `/api/pos/bootstrap`, `/api/sales`, `/api/sales/recent`, `/api/sales/:id`
- Patients: `/api/patients`
- Claims: `/api/claims`, `/api/nhis/claims`, `/api/nhia/claims`
- NHIA config and CC generation: `/api/nhia-config`, `/api/nhia/member-lookup`, `/api/nhia/cc-code`
- NHIA batches and export: `/api/nhia/batches`, `/api/nhia/batches/:id/export`
- Sync: `/api/sync/status`, `/api/sync/run`, `/api/sync/repair`, `/api/sync/pull-inventory`, `/api/sync/pull-reference-data`, `/api/sync/diagnostics`
- Database: `/api/database/status`, `/api/database/backup`

## Sync Model

- Local-first writes create rows in SQLite and queue events in `sync_outbox`.
- `supabaseSync.js` pushes sales, claims, NHIA config, and generic offline records.
- Cloud pulls hydrate inventory, patients, suppliers, claims, NHIS drugs, clinical rules, NHIS claims, NHIA configuration, and purchases.
- Failed records remain marked failed and can be repaired through `/api/sync/repair`.

## Sync Modes

- `ONLINE_CLOUD`: frontend talks to Supabase/Edge Functions directly.
- `ONLINE_LOCAL_SYNC`: frontend uses local branch server first; server syncs with Supabase.
- `OFFLINE_LOCAL`: frontend uses local branch server/cache while internet is unavailable.

## Facility Coverage

The code supports pharmacy and hospital/clinic-oriented NHIS workflows, including:

- Pharmacy levels: `P1`, `P2`, `LCS`, `HP`
- Hospital/provider classes: `B1`, `B2`, `C`, `D`, `M`, `SM`
- Multiple branches through `BRANCH_ID` and Supabase branch sync clients
- Multiple claims users through role and `can_manage_claims` permissions
- Multiple submitter IDs through NHIA settings per organization/branch

## Security Model

- Protected local API routes require `x-branch-token`.
- CORS allows localhost, private LAN origins, configured origins, and the production app.
- API and CLAIM-it bridge routes have an in-memory fixed-window rate limiter controlled by `RATE_LIMIT_*` settings.
- NHIA secrets are encrypted using `NHIA_CONFIG_SECRET_KEY`.
- Payment, SMTP, SMS, NHIA, and sync secrets are backend-only.
