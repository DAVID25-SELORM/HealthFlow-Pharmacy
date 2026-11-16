# Branch scope enforced on the server (BRANCH-002)

Date: 2026-11-16

## Why
BRANCH-001 (PR #37, #38) limits what branch staff see in the app. The stock and sales tables were still readable by every
member of the pharmacy, and `tier-access` honoured a branch id in the request ahead of the user's own. Anyone calling the API
directly could read or change another branch's data. This makes the database and the edge function keep the rule.

## What production looked like (read-only checks, 2026-11-16)
- Row-level security is on for `drugs`, `sales`, `sale_items` and `stock_movements`; the only read rule was
  `organization_id = user_organization_id()` (plus the chemical-shop and stock-movement admin rules).
- `low_stock_drugs` and `expiring_soon_drugs` already run with the caller's rights (`security_invoker`), so the new rule
  protects them without changing them.
- Helper functions `current_user_branch_id()`, `user_organization_id()` and `is_org_admin()` exist.
- Five pharmacies have Multi-branch on; only two have more than one active branch. One of the others has a branch-assigned member
  of staff and 66,289 stock rows with no branch. Legacy rows with no branch are therefore left visible, and single-branch
  pharmacies are never limited.

## Behaviour
- `public.user_branch_scope()` returns the branch a user is limited to, or NULL. Limited only if: the user belongs to a branch, is not
  an administrator or super administrator (role or any assigned role), the pharmacy has Multi-branch on, and it has more than one
  active branch.
- Six restrictive policies (ANDed with the existing ones) on `drugs` and `sales` (read and write), `sale_items`,
  `stock_movements`, `branch_stock_transfers` and `branch_stock_transfer_items` (read). A row with no branch stays visible;
  a transfer is visible to the two branches it connects; a movement to the branch it left and the one it reached.
- Trigger `sales_branch_guard`: a sale of another branch cannot be changed, which blocks a refund of it. The refund function itself
  is not touched.
- `tier-access`: `requestedBranchForRequester` ignores a requested branch id for branch staff in the inventory request,
  inventory sync and e-pharmacy buyer-branch paths. Administrators, super administrators and staff with no branch behave as before.

## Not changed
SECURITY DEFINER functions (sales, refunds, transfers) and the service role are not subject to row-level security. The local branch
server has its own data and sign-in. NHIS claims, purchases, shifts and patients are organisation-level and were not scoped.
Data is not changed by the migration.

## Release order (each step needs approval)
1. `00-precheck.sql` (read only), 2. `01-migration.sql`, 3. `02-verify.sql` plus the signed-in check, 4. deploy `tier-access` from a
clean checkout of main, 5. front end needs no change (PR #38 is independent). Rollback: `03-rollback.sql` (database), redeploy the
previous `tier-access`.

## Verification
`scripts/verify-branch-scope-rls-postgres.py` against a disposable Supabase Postgres 17.6 (no network): limited versus unlimited
users, legacy no-branch rows, single-branch and Multi-branch-off pharmacies, administrator by role and by assigned role, stock,
alert view, sales and lines, movements, transfers, direct writes across branches, the refund guard, the dependence on the number of
active branches, privileges, rollback and re-apply. Edge function: contract tests that also run the extracted helper.
