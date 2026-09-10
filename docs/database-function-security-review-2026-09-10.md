# Database function security review

The live Security Advisor displayed 0 errors, 126 warnings and 10 suggestions on 10 September 2026. The visible warning rows included publicly executable SECURITY DEFINER functions. This pass reviews the two e-pharmacy completion functions, not all 126 findings.

## Confirmed priority

`complete_epharmacy_order(uuid,uuid,uuid)` and `complete_customer_epharmacy_order(uuid,uuid,uuid)` trust supplied actor and organization IDs and mutate stock. The marketplace migration grants authenticated execution without revoking PostgreSQL's default PUBLIC execution. The customer migration revokes PUBLIC but the live advisor flags it as publicly callable, indicating that deployed grants require reconciliation.

The only repository RPC caller is `updateEpharmacyOrderStatus` in `tier-access`, using its service-role admin client after role checks, facility ownership checks and allowed-transition validation. The new migration removes PUBLIC, anon and authenticated execution while preserving service_role. It does not modify stock, order state, function bodies, RLS, or branch-sync permissions.

## Deferred categories

Branch-sync functions deliberately grant anon/authenticated execution and validate a separate sync token through `get_branch_sync_client`, which checks activity and first-use expiry. Removing their grants without a protocol migration would break existing installations. Their token handling and individual authorization paths need further review. Trigger-returning functions and RLS helper functions require their own caller analysis; the advisor warning alone does not prove exploitable access.

## Rollout

Validation: an isolated PostgreSQL 17 fixture began with both default PUBLIC and explicit client grants. Applying the migration twice succeeded. Actual calls under anon and authenticated failed with permission denied for both functions; service_role calls succeeded. The fixture used stub bodies to isolate ACL behavior, so it does not validate delivery business logic. Migration validation passed for 112 files. The temporary database container was stopped afterward.

The user reported successful execution of `20260910200000_restrict_epharmacy_completion_execution.sql` in Supabase. Live grants have not yet been independently checked. Run `supabase/diagnostics/epharmacy_completion_permissions.sql` to verify: expected permissions are anon false, authenticated false, service_role true. Verify a legitimate e-pharmacy delivery through the application in a test environment; do not create a production delivery just to test security. Re-run the advisor afterward.
