-- ================================================================
-- PATCH: Harden sale number generation function security mode
-- ================================================================
-- Date: 2026-05-01
-- Purpose:
--   Ensure public.generate_sale_number() runs as SECURITY DEFINER with
--   a fixed search_path, so production security audit passes and sale
--   number generation is not affected by caller-level sequence grants.
-- ================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.generate_sale_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    next_id BIGINT;
BEGIN
    next_id := nextval('public.sales_sale_number_seq');
    RETURN 'SAL-' || LPAD(next_id::TEXT, 6, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.generate_sale_number() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_sale_number() FROM anon;
GRANT EXECUTE ON FUNCTION public.generate_sale_number() TO authenticated;

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'generate_sale_number security-definer patch applied successfully.';
END $$;
