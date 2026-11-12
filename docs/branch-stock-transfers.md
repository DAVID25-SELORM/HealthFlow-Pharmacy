# Branch stock transfers and branch creation

## What changed

1. **Confirmed transfers.** Stock moves between a pharmacy's branches (main store to branch, branch to
   main store, or branch to branch) in two steps instead of one instant move:
   - **Dispatch.** A sender adds one or more medicines (each batch is its own line) and sends. The stock
     leaves the source branch immediately, so it cannot be sold while in transit.
   - **Confirm.** The receiving branch counts what arrived. Anything short goes back to the source branch
     automatically. The receiver can instead reject the whole transfer, or the sender can cancel while it is
     still pending. Rejecting or cancelling returns all the stock.
2. **Branch creation by branch managers.** Administrators and branch managers can add a branch (from the
   Stock Transfers page). The Settings screen is still administrator-only.
3. **Printable transfer note** for every transfer (Stock Transfers, Open, Print note), with signature spaces.
4. **Existing entry points.** The Inventory "send to another branch" button and the Reorder Centre
   "transfer instead of buying" now create the same confirmed transfer, so no screen moves stock in one step.

Normal sales, serving and dispensing are untouched (INVENTORY-001). Transfers need an internet connection;
they are never queued offline.

## Who can do what (enforced in the database; the screens only hide buttons)

| Action | Allowed |
|---|---|
| Dispatch | Inventory staff: admin, pharmacist, technician, procurement, inventory officer, branch manager (or anyone with the stock permissions). Staff tied to one branch can only send **from that branch**; administrators and staff with no branch can send from any. |
| Confirm or reject | An administrator, or a branch manager of the **receiving** branch (a branch manager with no branch assigned counts as organisation-wide). |
| Cancel (pending only) | The sender, an administrator, or a branch manager of the **sending** branch. |
| Create a branch | Administrator or branch manager. A pharmacy gets a second branch only when the platform administrator has switched **Multi-branch** on for it (Tenant Admin); the function enforces this too. |

Expired batches cannot be dispatched. A batch is matched at the destination by medicine name and batch number
(same rule as the old instant transfer); a new stock row is created when there is none.

## Data

New tables `branch_stock_transfers` and `branch_stock_transfer_items` (read-only for clients, written only by
the functions), a number sequence (`TRF-000001`...), and five client functions
`create_branch_stock_transfer`, `receive_branch_stock_transfer`, `reject_branch_stock_transfer`,
`cancel_branch_stock_transfer`, `create_pharmacy_branch`. Every step writes `transfer_out` / `transfer_in`
rows to `stock_movements` (no new movement types) and an audit event.

## Release order

See `tmp/branch-stock-transfers-migration/README.md` in the session folder: precheck, migration, verify, deploy
the front end, then (optionally) retire the old instant-transfer function with `04-...sql`.

## Tests

`scripts/verify-branch-stock-transfers-postgres.py` (disposable PostgreSQL, no network) covers dispatch,
full and partial receipt, reject, cancel, permissions, cross-pharmacy isolation, stock conservation and branch
creation. Front-end tests: `branchTransferService`, `drugTransferDispatch`, `NewTransferModal`,
`TransferDetailModal`, `StockTransfers`.
