BEGIN;

-- Keep the SECURITY DEFINER helper pinned to the intended schema.
ALTER FUNCTION public.user_organization_id() SET search_path = public;

-- E-pharmacy writes are intentionally mediated through the tier-access Edge Function,
-- where role checks, medicine class restrictions, stock checks, and status transitions
-- are enforced before service-role writes occur. Authenticated table access remains
-- read-only through the select policies from the base marketplace migration.
DROP POLICY IF EXISTS epharmacy_orders_insert_buyer ON public.epharmacy_orders;
DROP POLICY IF EXISTS epharmacy_orders_update_parties ON public.epharmacy_orders;
DROP POLICY IF EXISTS epharmacy_order_items_insert_buyer ON public.epharmacy_order_items;

COMMIT;
