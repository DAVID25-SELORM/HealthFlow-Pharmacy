-- ================================================================
-- PATCH: Expanded pharmacy staff roles
-- ================================================================
-- Date: 2026-05-01
-- Purpose:
--   Adds support for larger-pharmacy roles in database role helpers
--   and broadens inventory write RLS for inventory-focused staff.
-- ================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.app_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  role_value TEXT;
BEGIN
  role_value := COALESCE(
    (auth.jwt() -> 'app_metadata' ->> 'role'),
    (auth.jwt() -> 'user_metadata' ->> 'role'),
    'assistant'
  );

  IF role_value NOT IN (
    'admin',
    'pharmacist',
    'assistant',
    'technician',
    'cashier',
    'branch_manager',
    'procurement',
    'billing',
    'delivery',
    'super_admin'
  ) THEN
    RETURN 'assistant';
  END IF;

  RETURN role_value;
END;
$$;

DROP POLICY IF EXISTS drugs_insert_staff ON public.drugs;
CREATE POLICY drugs_insert_staff ON public.drugs
FOR INSERT
TO authenticated
WITH CHECK (
  organization_id = public.user_organization_id()
  AND EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = auth.uid()
      AND (
        role IN ('admin', 'pharmacist', 'technician', 'procurement', 'branch_manager')
        OR can_manage_inventory = true
      )
  )
);

DROP POLICY IF EXISTS drugs_update_staff ON public.drugs;
CREATE POLICY drugs_update_staff ON public.drugs
FOR UPDATE
TO authenticated
USING (
  organization_id = public.user_organization_id()
  AND EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = auth.uid()
      AND (
        role IN ('admin', 'pharmacist', 'technician', 'procurement', 'branch_manager')
        OR can_manage_inventory = true
      )
  )
)
WITH CHECK (organization_id = public.user_organization_id());

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'stock_movements') THEN
    DROP POLICY IF EXISTS stock_movements_insert_staff ON public.stock_movements;
    CREATE POLICY stock_movements_insert_staff ON public.stock_movements
    FOR INSERT
    TO authenticated
    WITH CHECK (
      organization_id = public.user_organization_id()
      AND EXISTS (
        SELECT 1
        FROM public.users
        WHERE id = auth.uid()
          AND (
            role IN ('admin', 'pharmacist', 'technician', 'procurement', 'branch_manager')
            OR can_manage_inventory = true
          )
      )
    );
  END IF;
END $$;

COMMIT;
