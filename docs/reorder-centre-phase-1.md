# Reorder Centre — Phase 1

Status: implemented on branch `feature/reorder-centre`, **not deployed**. Nothing here has been applied to production.

## What Phase 1 covers

Target stock level, smarter suggested quantity, open-order deduction, the Reorder Centre page (`/reorder`), supplier grouping, and the dashboard link. Phases 2–4 (lifecycle, receiving, PO document, price history, velocity, expiry awareness, multi-branch) are intentionally not started.

## Decisions worth knowing

- **Target stock level** — new nullable `drugs.target_stock_level` (migration `20260923090000`). Checks: non-negative, and `>= reorder_level`. Existing rows stay `NULL`; nothing is mass-written. Calculations fall back to `reorder_level` for that one calculation only (`getEffectiveTargetStockLevel`).
- **Suggested quantity** — `max(0, ceil(target - current - alreadyOnOrder))`, never negative. Lives in `src/utils/reorderCentre.js`.
- **Open orders** — the purchase model has only `draft | completed | cancelled` and no partial receipt, so "already on order" is the sum of `purchase_items.quantity` on **draft** purchases (`getOpenOrderQuantitiesByDrug`). True ordered/received/outstanding tracking needs Phase 2's status and line-item changes.
- **Stock severity** — `OUT_OF_STOCK` (<= 0), `CRITICAL` (<= 25% of reorder level, `CRITICAL_STOCK_RATIO`), `LOW` (<= reorder level), `OK`. Separate from `calculateDrugStatus`, which also weighs expiry and drives the Inventory badge; that function is unchanged. Unstocked catalogue placeholders (`PDF-IMP-*` with quantity 0) and inactive drugs are excluded, as in the existing low-stock alerts.
- **Supplier grouping** — one purchase order per supplier; medicines with no supplier sit in a "Supplier required" group and cannot be ordered until one is assigned. Uses the existing `drug.supplier` text; a preferred-supplier field is deferred.
- **PO numbering** — already concurrency-safe (`purchase_number_seq`, `PO-000123`), so nothing was added.

## Applying it

1. Run the migration in `supabase/migrations/20260923090000_add_drug_target_stock_level.sql`.
2. Deploy the `tier-access` edge function (create/update/get now handle `target_stock_level`). Until both are done, the new form field will not persist.

## Deferred

Preferred supplier, `reorder_enabled`, price history, sales velocity/days of stock, expiry warnings, priority scoring, printable PO, ordered/partially-received lifecycle, receiving, cancellation audit, dashboard open-order/estimated-value metrics, multi-branch transfer advice.

## Protected-baseline impact (`supabase/functions/tier-access/index.ts`)

The manifest hash for this critical file was updated deliberately in this change. The edit is additive and pattern-matched to `reorder_level`: `target_stock_level` is added to `INVENTORY_DRUG_SELECT_FIELDS` (read), `buildDrugCreatePayload` (create) and the `update_drug` payload (update), with two small helpers (`parseOptionalNonNegativeNumber`, `assertTargetStockAtLeastReorderLevel`). No existing behaviour, permission check or query changes. Characterization tests: `supabase/functions/tier-access/index.test.js` ("drug target stock level"). This file cannot be executed locally (Deno), so those tests inspect the source, like the existing ones in that file.
