# Database function security review

The live Security Advisor displayed 0 errors, 126 warnings and 10 suggestions on 10 September 2026. The visible warning rows included publicly executable SECURITY DEFINER functions. This pass reviews the two e-pharmacy completion functions, not all 126 findings.

## Confirmed priority

`complete_epharmacy_order(uuid,uuid,uuid)` and `complete_customer_epharmacy_order(uuid,uuid,uuid)` trust supplied actor and organization IDs and mutate stock. The marketplace migration grants authenticated execution without revoking PostgreSQL's default PUBLIC execution. The customer migration revokes PUBLIC but the live advisor flags it as publicly callable, indicating that deployed grants require reconciliation.

The only repository RPC caller is `updateEpharmacyOrderStatus` in `tier-access`, using its service-role admin client after role checks, facility ownership checks and allowed-transition validation. The new migration removes PUBLIC, anon and authenticated execution while preserving service_role. It does not modify stock, order state, function bodies, RLS, or branch-sync permissions.

## Deferred categories

Branch-sync functions deliberately grant anon/authenticated execution and validate a separate sync token through `get_branch_sync_client`, which checks activity and first-use expiry. Removing their grants without a protocol migration would break existing installations. Their token handling and individual authorization paths need further review. Trigger-returning functions and RLS helper functions require their own caller analysis; the advisor warning alone does not prove exploitable access.

## Rollout

Validation: an isolated PostgreSQL 17 fixture began with both default PUBLIC and explicit client grants. Applying the migration twice succeeded. Actual calls under anon and authenticated failed with permission denied for both functions; service_role calls succeeded. The fixture used stub bodies to isolate ACL behavior, so it does not validate delivery business logic. Migration validation passed for 112 files. The temporary database container was stopped afterward.

The user reported successful execution of `20260910200000_restrict_epharmacy_completion_execution.sql` in Supabase. The read-only diagnostic was subsequently run in the live Supabase SQL Editor: both functions reported anon false, authenticated false, service_role true. Rerunning the advisor showed 0 errors, 122 warnings and 10 suggestions. Verify a legitimate e-pharmacy delivery through the application in a test environment; do not create a production delivery just to test security. Re-run the advisor afterward.

## Sales and purchase permission pass

`src/services/salesService.js` calls `create_sale_transaction(jsonb)` directly with the staff session, and `src/services/purchasesService.js` calls `complete_purchase(uuid)`. These functions therefore retain authenticated execution. The purchase function also checks purchase-approval privilege and scopes the purchase to the current organization. This pass does not constitute a full audit of either function body.

`20260910210000_restrict_sales_purchase_anonymous_execution.sql` revokes both inherited PUBLIC and explicit anon execution on these exact signatures, preserving authenticated and service_role. Separate branch-sync RPCs remain unchanged. No stock or transaction data is modified.

Validation: applied twice to isolated PostgreSQL 17 stub functions starting with PUBLIC and explicit anon grants. Actual anon calls were denied; authenticated and service_role calls succeeded for both signatures. The diagnostic returned false/true/true for both. These tests verify ACL behavior, not sales or purchase business logic. Migration validation passed for 113 migrations and the protected baseline check passed.

Production application of this second migration is pending. After applying it, run `supabase/diagnostics/sales_purchase_permissions.sql`; expected permissions are anon false, staff true, service true. The remaining advisor warnings still require individual review.
