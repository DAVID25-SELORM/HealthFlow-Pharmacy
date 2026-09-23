# Reorder Centre — Phase 3: velocity, price history, expiry, priority

Status: implemented on branch `feature/reorder-centre` (on top of Phases 1–2). **Not deployed.**

## Where the numbers come from

One read-only database function, `get_reorder_insights(drug_ids, window_days)`
(`20260923110000_reorder_insights.sql`), aggregates everything server-side, so the browser never
downloads sales or purchase history. It needs `user_can_manage_purchases()`, is limited to the caller's
organization, and is not executable by `anon`. It changes no data.

- **Usage** — units on **completed** sales (`sale_items` joined to `sales.payment_status = 'completed'`) in the
  last 90 days. Refunded, cancelled, pending and older sales are ignored.
  It does **not** include NHIS dispensing (that is not a sale), so NHIS-heavy medicines will show
  lower usage than reality.
- **History** — days since the medicine row was created, capped at the window.
- **Price history** — cost of the latest and the previous **placed or received** purchase (drafts and
  cancelled orders ignored, zero costs ignored). The cost actually paid on the latest receipt beats the
  cost written on the order. Supplier and date come with it.

## Rules (all named constants in `src/utils/reorderInsights.js`)

| Thing | Rule |
|---|---|
| Average daily/weekly usage | units sold ÷ history days |
| Days of stock | current stock ÷ average daily usage |
| Not enough data | history under **14 days** (no rate is shown, no number is invented) |
| No recent sales | enough history, zero sold: usage 0, days of stock not shown, no division by zero |
| Fast moving | days of stock ≤ **14** |
| Large price change | ≥ **20%** either way — flagged, never blocks a purchase |
| Expiry warning | stock on the row expiring within the pharmacy's expiry alert days (default 30); expired stock is called out. Not subtracted from the suggestion — staff decide. |

## Priority (visible, testable, with reasons)

1. Out of stock
2. Critical **and** fast moving
3. Critical (slow or unknown speed), or low and fast moving
4. Low and slow moving or unknown speed

Unknown speed never hides or downgrades a medicine below its stock level. "Most urgent" sorts by
priority, then days of stock (unknown last), then quantity. "Fastest moving" sorts by known usage,
unknown last. Hover a priority to see its reasons.

## In the app

- **Reorder Centre**: days of stock and usage under the current stock ("Not enough data" when short),
  last vs previous cost with % change (red when flagged), expiry warning under the medicine name,
  priority badge, and a supplier fallback to whoever it was last bought from (labelled, editable).
- **New purchase from the Reorder Centre**: each line carries its price note; large changes read
  "please check".
- **Receiving goods**: the entered unit cost shows its % difference from the ordered cost; large
  differences are flagged, never blocked.
- If insights cannot load (function missing or an error), the page shows a notice and everything else works.

## Known limits

- Usage excludes NHIS dispensing (above).
- A medicine that had stock before its row was created will look like it has less history than it does.
- Inventory keeps one row per batch, so usage and expiry warnings are per row.
- Multi-branch transfer advice (Phase 4) is not started.

## Applying it

Run `supabase/migrations/20260923110000_reorder_insights.sql` (needs the Phase 2 migration applied first —
it reads `purchase_receipts` and the new statuses). Then deploy the app. If the migration is not applied
yet, the Reorder Centre still loads and simply hides days of stock and price history.
