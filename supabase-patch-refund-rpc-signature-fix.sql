-- ================================================
-- PATCH: Resolve refund RPC overload ambiguity
-- Date: 2026-04-25
-- ================================================

BEGIN;

DROP FUNCTION IF EXISTS public.refund_sale_transaction(TEXT, UUID);

GRANT EXECUTE ON FUNCTION public.refund_sale_transaction(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

