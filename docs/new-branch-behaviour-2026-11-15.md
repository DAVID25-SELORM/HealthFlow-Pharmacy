# How a new branch should behave

Date: 2026-11-15

Trigger: a branch manager of a newly created branch signed in and saw the main branch's stock and sales.

## What the database shows
The new branch had 0 stock rows and the manager was correctly assigned to it (the main branch had 1,864). The app was
showing the main store by itself, in places that read the whole organisation instead of one branch:
- Dashboard "Reorder Watch" and "Expiry Watch" and the top-bar alert bell (views `low_stock_drugs` and `expiring_soon_drugs`
  have no branch column).
- Dashboard sales figures and recent sales, and the till's "Recent Sales" list (with Reprint and Refund buttons).
- The NHIS page medicine list (a direct read of the stock table).
Stock search at the till, Inventory, Purchases, the Reorder Centre and server-side reports were already branch-aware.

## What good multi-location behaviour looks like (outside research, vendor pages: treat as general guidance)
- Each location has its own stock count; a new location starts at zero and is stocked deliberately, by transfer, purchase
  or an opening balance. Items can be visible but "not stocked".
- Staff logins and permissions are set per location; owners see every location and consolidated reports.
- Transfers log stock leaving one location and the receiving location confirms what arrived.
- Reports can be filtered by location and also rolled up.

## Rule BRANCH-001 (implemented in the app)
- Multi-branch on, a member of staff with a branch: that branch only (dashboard sales and alerts, recent sales, alert bell,
  NHIS medicine list).
- Administrators and super administrators: organisation-wide. Staff with no branch: organisation-wide (as for transfers).
- Pharmacies without Multi-branch: unchanged.
- A new branch's Inventory says it has no stock yet and how stock arrives.

## Not done, recommended next (needs a database or edge function release, so it needs your go-ahead)
1. The scoping is in the app. A person who calls the database or the `tier-access` function directly can still ask for another
   branch (`get_drugs` honours a requested branch id ahead of the user's own; the stock and sales tables are readable
   organisation-wide). To make it a security boundary: make `get_drugs` ignore a requested branch for branch-bound staff, and
   add branch-aware row-level security (or branch-aware views) for `drugs`, `sales` and the alert views.
2. Refunds of another branch's sale are no longer offered in the till list but are not blocked server-side.
3. Cross-branch patient, claim and CC-code data are organisation-level by design and were not changed.
