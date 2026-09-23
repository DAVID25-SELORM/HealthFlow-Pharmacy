# Reorder Centre — Phase 2: purchase lifecycle and receiving

Status: implemented on branch `feature/reorder-centre` (on top of Phase 1). **Not deployed.**

## Lifecycle

```
draft ──place──▶ ordered ──receive──▶ partially_received ──receive──▶ completed (received)
  │                 │                        │
  └─────────────────┴──────── cancel ────────┘  ▶ cancelled
```

- `completed` is the "fully received" state. Existing purchases, and the existing one-step
  `complete_purchase()` (draft → completed, receive everything), are unchanged, so the simple
  workflow still works.
- **Stock increases only when goods are received.** Creating, placing or cancelling never touches stock.
- Receiving reuses the exact statements `complete_purchase()` already uses (update the `drugs`
  row, insert a `stock_movements` row), so it is the same trusted path, not a new one.

## Database (`20260923100000_purchase_order_lifecycle.sql`)

- `purchases.status` now allows `ordered` and `partially_received`; adds `ordered_at/by`,
  `cancelled_at/by`, `cancellation_reason`.
- `purchase_items.received_quantity` (never above `quantity`). Outstanding = `quantity − received_quantity`,
  computed, never stored.
- `purchase_receipts`: one row per received line (item, drug, quantity, batch, expiry, unit cost,
  received_by, received_at, notes, `receipt_key`). No insert/update/delete for `authenticated`; only the RPC writes it.
- RPCs (all `security definer`, permission checked inside, audited inside):
  - `place_purchase_order(id)` — needs `user_can_manage_purchases()`; needs a supplier and items with quantity > 0.
  - `receive_purchase_goods(id, lines, receipt_key, notes)` — needs `user_can_approve_purchases()`; validates
    everything first, then writes; refuses over-receipt (also across split batches); the same
    `receipt_key` on the same purchase never posts twice.
  - `cancel_purchase_order(id, reason)` — needs `user_can_manage_purchases()`; reason required once placed;
    cannot cancel a received or cancelled order; stock untouched.
  - `complete_purchase(id)` — same behaviour, plus it now records `received_quantity`.
- Audit events: `PURCHASE_ORDER_PLACED`, `GOODS_PARTIALLY_RECEIVED`, `GOODS_RECEIVED`,
  `PURCHASE_ORDER_CANCELLED` (via `log_audit_event`; an audit failure never blocks the action).

## "Already on order" (feeds Phase 1 suggestions)

`getOpenOrderQuantitiesByDrug` now counts draft (in full), ordered and partially received
(outstanding only). Cancelled and completed purchases stop counting.

## App

- Purchases page: new status tabs/badges, **Place order**, **Receive goods** (partial or full, with
  batch/expiry/unit cost, several batches per item, receipt history), **Cancel** with a reason,
  ordered/received/outstanding columns, **Print PO**.
- Printable PO: facility, supplier, PO number, order date, created by, lines, estimated totals, notes, signature lines.
- Receiving and cancelling need internet (like completing already did); they are never queued offline.

## Known limits (deliberate, please read)

- **One batch per drug row.** Inventory keeps a single batch/expiry on each `drugs` row, and receiving
  overwrites it (exactly as the existing completion does). Every batch and expiry that arrived is kept in
  `purchase_receipts`, but stock is not split into per-batch inventory rows. True multi-batch inventory is a
  separate, larger change.
- **Direct table updates are still possible** for someone with purchases write access via the API
  (e.g. setting a status directly). The RPCs enforce the rules for everything the app does; closing
  the API path (a transition trigger) was not added because offline branch sync also upserts
  purchases and I could not verify it would tolerate it.
- Offline branch-server mode still uses the old draft/complete/cancel behaviour and has no received
  quantities (treated as 0).
- Over-delivery is rejected rather than accepted; staff record what was ordered and add a new order for extras.
- Older completed purchases keep `received_quantity = 0` (not back-filled); use `status`, not that
  column, for history.

## Applying it

1. Run `supabase/migrations/20260923100000_purchase_order_lifecycle.sql` (needs the Phase 1 migration first
   only for the Reorder Centre; this file does not depend on it).
2. Deploy the app. No edge-function change is needed for Phase 2.
