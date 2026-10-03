# NHIS claim recycling and stock

Deleting an NHIS claim now returns its net recorded inventory deduction to the
original inventory items/batches. It does not use prescribed or served quantities
to invent returns for historical claims that never deducted stock. The confirmation
explains that the medicines must not have been supplied, or must have been returned.

Restoring the claim deducts the exact quantities returned by that recycle operation.
Inactive original items or insufficient stock abort the entire restoration, keeping
the claim in the Recycle Bin. Repeated requests cannot return or deduct stock twice.
Existing permissions still apply; only administrators can restore records.

The new `nhis_inventory_claim_references` table retains claim identity after recycling
or permanent deletion. Ledger, serving events and activation baselines reference
this identity, remain in place, and are never rewritten or deleted. The table has
RLS enabled and no public/anon/authenticated access. Private stock helpers are not
callable by clients. A parent DELETE trigger prevents bypassing compensation.

Each return/restoration adds stock movements and ledger rows with the acting user,
original inventory item, quantity and event. The archived snapshot identifies the
return event. Old snapshots remain restorable. Signatures, CXF events, medicines,
services and other claim archives retain their existing restore behavior.

All changes occur in one database transaction. Parent and inventory row locks
serialize competing operations. Policy baselines retain historic stock-neutral
quantities, including when a new policy activation occurred while a claim was archived.

Deploy migration `20261003100000_restore_stock_when_recycling_nhis_claim.sql` and
the NHIS/Recycle Bin confirmation text together. This migration does not return stock
for claims already deleted before deployment and does not modify any current stock
quantities until an authorized recycle or restore is performed.

Validation: PGlite executes the actual migration and RPCs, including repeated cycles,
partial compensation, multiple batches, insufficient-stock rollback, archive failure
rollback, tenant/role checks, baseline preservation, private-helper permissions,
permanent-deletion history and signing/CXF archive restoration. No real claim needs
to be deleted for release verification.
