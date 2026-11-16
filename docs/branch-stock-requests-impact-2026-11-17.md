# Branch stock requests (BRANCH-003)

Date: 2026-11-17

## Why
A branch manager asked whether they can move stock from the main store to their branch. They cannot: staff tied to a branch can only
send from their own branch (the database refuses anything else) and, since BRANCH-002, cannot read another branch's stock. The only
route was for an administrator to create the transfer. This adds the missing step: the branch asks, the main store decides.

## Behaviour
- **Ask.** Branch-bound staff (not administrators) get a Request stock button on Stock Transfers. They pick the branch to ask (default:
  the main store), search its medicines, and enter the quantity needed per batch line. Nothing moves.
- **Decide.** An administrator, staff of the branch being asked, or staff with no branch see the request under Stock requests
  ("Needs my action") and can Approve, lowering a quantity or dropping a line (0), or Decline with a reason of 5 to 500 characters.
- **Approve = dispatch.** Approving calls the existing `create_branch_stock_transfer`, so the stock leaves the asked branch at once and the
  asking branch confirms receipt exactly as for any transfer (short quantities go back, or the transfer is rejected). If a line cannot be
  supplied in full the whole approval fails with the usual "Not enough ... in stock" message, nothing is saved and the request stays open.
- **Cancel.** The person who asked, the asking branch's manager, or an administrator can cancel while the request is waiting.
- **Visibility.** A request is visible to the two branches it involves, administrators and staff with no branch (BRANCH-002 restrictive
  policy). Other pharmacies see nothing.
- **Picker.** `search_branch_stock_for_request` returns medicine name, batch, expiry, unit and quantity of active, in-stock, unexpired
  rows of the chosen branch. It exposes no prices or costs and is only callable by inventory staff of the same pharmacy.

## Database
Additive only: tables `branch_stock_requests` and `branch_stock_request_items`, sequence `branch_stock_request_number_seq`, five functions
(`search_branch_stock_for_request`, `create_branch_stock_request`, `approve_branch_stock_request`, `decline_branch_stock_request`,
`cancel_branch_stock_request`) and two restrictive read policies. Writes happen only through the functions (direct insert/update is revoked).
No existing table, policy or function changes. Needs 20261111090000 and 20261116090000 (both applied to production). Undo: `03-rollback.sql`.

## Deploy order
1. Apply the migration (precheck, migration, verify). 2. Merge and deploy the front end. If the front end is live first, only the Stock
requests tab shows a "could not load" message; transfers keep working, because requests are loaded separately.

## Verification
`scripts/verify-branch-stock-requests-postgres.py` runs the real transfer and branch scope migrations plus this one on a disposable
Postgres and checks: the picker hides prices, expired and retired rows; who can ask, approve, decline and cancel (including another
branch's manager, a cashier, another pharmacy); request visibility; that a request never moves stock; partial approval with a dropped
line; a failed approval rolls back completely; the approved transfer is confirmed by the asking branch; privileges; and rollback.
Unit tests cover the service, both modals and the page wiring.

## Not done
- No notification is sent to the main store when a request arrives; they see it on the Stock Transfers page (the tab shows "n to decide").
- A request names specific batches. If the main store wants to send a different batch, they decline with a reason or send a New transfer.
