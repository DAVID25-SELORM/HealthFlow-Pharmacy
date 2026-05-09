# Offline Operations And Sync Roadmap

## Recommended Direction

For reliable pharmacy offline operations, use a local branch component instead of relying on browser caching alone.

Best fit:
- Single-machine pharmacy: installable desktop app with local SQLite and Supabase sync.
- Multi-machine pharmacy: local branch server with a local database, used by all branch computers over LAN, then synced to Supabase when internet returns.

## Why This Matters

A service worker/PWA can cache the app shell, but it does not solve transactional pharmacy data. Offline sales, inventory changes, patients, claims, stock transfers, and multi-user branch activity need a real local database plus a sync queue.

## Offline-Capable Modules

Start with:
- Sales / POS (Started: browser queue saves offline sales and syncs them when online.)
- Inventory lookup (Started: POS keeps a cached in-stock search list for offline use.)
- Stock reduction after sale
- Patients
- Basic purchases / stock receiving
- Receipts
- Pending NHIS/private claims capture

Keep cloud-only at first:
- Subscription billing
- Super admin dashboard
- Organization setup
- Staff permission changes
- Cross-branch reports
- Bulk imports

## Core Architecture

Local branch:
- React frontend
- Local API/backend
- Local SQLite or PostgreSQL database
- Sync queue
- Sync worker
- Clear online/offline UI status

Cloud:
- Supabase remains the source for synced multi-branch data.

## Sync Principles

- Generate UUIDs locally so offline records can sync without ID collisions.
- Record business actions as events where possible.
- Do not blindly overwrite stock quantities.
- Use stock movements for sales, purchases, adjustments, expiries, returns, and transfers.
- Mark local records as pending, synced, or failed.
- Keep audit trails for all sync-sensitive actions.

## Suggested Rollout

1. Make the app installable/cacheable as a PWA. (Done: app shell cache, manifest, and online/offline status.)
2. Add first POS offline queue. (Done: offline sales are stored locally, sync on reconnect, and shift closing is blocked while sales are pending.)
3. Refactor service calls behind app-owned APIs, starting with Sales.
4. Add a stronger local database and sync queue for inventory, patients, purchases, claims, and full shift close support.
5. Add conflict handling, audit trails, and sync monitoring.
6. Move to a local branch server for pharmacies with multiple offline computers.

## Next Practical Step

Refactor the Sales module so the page does not depend directly on Supabase calls. Make it call a `salesApi` abstraction that can later choose between Supabase, the browser queue, or a local branch backend.

## Current POS Offline Behavior

- If internet drops while the POS has cached data and an open shift, the cashier can save sales offline.
- The checkout button changes to `Save Offline Sale`.
- Offline sales are stored on the device with an `OFF-...` reference and a printable receipt.
- When internet returns, pending sales sync automatically. The cashier can also click `Sync Now`.
- The app blocks shift closing while offline sales remain unsynced, because the server-side shift must stay open for accurate cash and inventory posting.
