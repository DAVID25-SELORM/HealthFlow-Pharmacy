-- ================================================
-- MULTI-TENANT MIGRATION - STEP 3: FIXES
-- ================================================
-- Date: April 16, 2026
-- Description: Fix tenant bootstrap and organization-aware inserts
-- Author: David Gabion Selorm
-- ================================================

-- ================================================
-- HELPER: CHECK WHETHER THE CURRENT USER IS AN ADMIN
-- FOR THE TARGET ORGANIZATION
-- ================================================

CREATE OR REPLACE FUNCTION public.current_user_is_org_admin(target_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.users
        WHERE id = auth.uid()
          AND role = 'admin'
          AND organization_id = target_org_id
    );
$$;

COMMENT ON FUNCTION public.current_user_is_org_admin(UUID) IS
'Returns true when the currently authenticated user is an admin in the target organization';

-- ================================================
-- FIX ORGANIZATION UPDATE POLICY
-- ================================================

DROP POLICY IF EXISTS organizations_update_owner ON organizations;
DROP POLICY IF EXISTS organizations_update_admin_same_org ON organizations;

CREATE POLICY organizations_update_admin_same_org ON organizations
FOR UPDATE
TO authenticated
USING (public.current_user_is_org_admin(id))
WITH CHECK (public.current_user_is_org_admin(id));

-- ================================================
-- DEFAULT ORGANIZATION_ID FOR NORMAL APP INSERTS
-- ================================================
-- This keeps existing client-side inserts working under tenant RLS.
-- Service-role flows should continue to set organization_id explicitly.

ALTER TABLE users
ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

ALTER TABLE drugs
ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

ALTER TABLE patients
ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

ALTER TABLE sales
ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

ALTER TABLE sale_items
ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

ALTER TABLE claims
ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

ALTER TABLE claim_items
ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

ALTER TABLE pharmacy_settings
ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'stock_movements') THEN
        ALTER TABLE stock_movements
        ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_logs') THEN
        ALTER TABLE audit_logs
        ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();
    END IF;
END $$;

-- ================================================
-- VERIFICATION
-- ================================================

SELECT
    table_name,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'organization_id'
  AND table_name IN (
      'users',
      'drugs',
      'patients',
      'sales',
      'sale_items',
      'claims',
      'claim_items',
      'pharmacy_settings'
  )
ORDER BY table_name;

DO $$
BEGIN
    RAISE NOTICE 'Migration Step 3 fixes applied successfully.';
END $$;
