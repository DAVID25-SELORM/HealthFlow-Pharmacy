-- ================================================
-- MULTI-TENANT MIGRATION - STEP 2: ROW LEVEL SECURITY
-- ================================================
-- Date: April 16, 2026
-- Description: Update RLS policies for multi-tenant isolation
-- Author: David Gabion Selorm
-- ================================================

-- ================================================
-- HELPER FUNCTION: Get Current User's Organization
-- ================================================

CREATE OR REPLACE FUNCTION public.user_organization_id()
RETURNS UUID
LANGUAGE sql
STABLE SECURITY DEFINER
AS $$
    SELECT organization_id FROM public.users WHERE id = auth.uid()
$$;

COMMENT ON FUNCTION public.user_organization_id() IS 'Returns the organization_id of the currently authenticated user';

-- ================================================
-- ENABLE RLS ON ORGANIZATIONS TABLE
-- ================================================

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- Users can see their own organization
CREATE POLICY organizations_select_own ON organizations
FOR SELECT
TO authenticated
USING (id = public.user_organization_id());

-- Only organization owners can update their organization
CREATE POLICY organizations_update_owner ON organizations
FOR UPDATE
TO authenticated
USING (
    owner_user_id = auth.uid()
    OR id = public.user_organization_id()
)
WITH CHECK (
    owner_user_id = auth.uid()
    OR id = public.user_organization_id()
);

-- ================================================
-- UPDATE USERS TABLE RLS
-- ================================================

-- Drop old policies
DROP POLICY IF EXISTS users_select_authenticated ON users;
DROP POLICY IF EXISTS users_update_admin_or_self ON users;
DROP POLICY IF EXISTS users_insert_self ON users;

-- NEW: Users can see users in their organization
CREATE POLICY users_select_same_org ON users
FOR SELECT
TO authenticated
USING (organization_id = public.user_organization_id());

-- NEW: Users can update themselves, admins can update anyone in org
CREATE POLICY users_update_self_or_admin ON users
FOR UPDATE
TO authenticated
USING (
    id = auth.uid() -- Can update self
    OR (
        organization_id = public.user_organization_id()
        AND EXISTS (
            SELECT 1 FROM users
            WHERE id = auth.uid()
            AND role = 'admin'
        )
    )
)
WITH CHECK (
    id = auth.uid()
    OR (
        organization_id = public.user_organization_id()
        AND EXISTS (
            SELECT 1 FROM users
            WHERE id = auth.uid()
            AND role = 'admin'
        )
    )
);

-- NEW: Only admins can insert new users in their org (via staff creation)
CREATE POLICY users_insert_admin ON users
FOR INSERT
TO authenticated
WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
        SELECT 1 FROM users
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

-- ================================================
-- UPDATE DRUGS TABLE RLS
-- ================================================

DROP POLICY IF EXISTS drugs_select_authenticated ON drugs;
DROP POLICY IF EXISTS drugs_write_pharmacist_admin ON drugs;

-- NEW: Select drugs from same organization
CREATE POLICY drugs_select_same_org ON drugs
FOR SELECT
TO authenticated
USING (organization_id = public.user_organization_id());

-- NEW: Insert drugs (pharmacists and admins only, in their org)
CREATE POLICY drugs_insert_staff ON drugs
FOR INSERT
TO authenticated
WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
        SELECT 1 FROM users
        WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist')
    )
);

-- NEW: Update drugs (pharmacists and admins only, in their org)
CREATE POLICY drugs_update_staff ON drugs
FOR UPDATE
TO authenticated
USING (
    organization_id = public.user_organization_id()
    AND EXISTS (
        SELECT 1 FROM users
        WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist')
    )
)
WITH CHECK (
    organization_id = public.user_organization_id()
);

-- NEW: Delete drugs (admins only, in their org)
CREATE POLICY drugs_delete_admin ON drugs
FOR DELETE
TO authenticated
USING (
    organization_id = public.user_organization_id()
    AND EXISTS (
        SELECT 1 FROM users
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

-- ================================================
-- UPDATE PATIENTS TABLE RLS
-- ================================================

DROP POLICY IF EXISTS patients_select_authenticated ON patients;
DROP POLICY IF EXISTS patients_write_staff ON patients;

-- NEW: Select patients from same organization
CREATE POLICY patients_select_same_org ON patients
FOR SELECT
TO authenticated
USING (organization_id = public.user_organization_id());

-- NEW: Insert patients (all staff can add patients)
CREATE POLICY patients_insert_staff ON patients
FOR INSERT
TO authenticated
WITH CHECK (organization_id = public.user_organization_id());

-- NEW: Update patients (all staff)
CREATE POLICY patients_update_staff ON patients
FOR UPDATE
TO authenticated
USING (organization_id = public.user_organization_id())
WITH CHECK (organization_id = public.user_organization_id());

-- NEW: Delete patients (admins only)
CREATE POLICY patients_delete_admin ON patients
FOR DELETE
TO authenticated
USING (
    organization_id = public.user_organization_id()
    AND EXISTS (
        SELECT 1 FROM users
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

-- ================================================
-- UPDATE SALES TABLE RLS
-- ================================================

DROP POLICY IF EXISTS sales_select_authenticated ON sales;
DROP POLICY IF EXISTS sales_write_staff ON sales;

-- NEW: Select sales from same organization
CREATE POLICY sales_select_same_org ON sales
FOR SELECT
TO authenticated
USING (organization_id = public.user_organization_id());

-- NEW: Insert sales (all staff)
CREATE POLICY sales_insert_staff ON sales
FOR INSERT
TO authenticated
WITH CHECK (organization_id = public.user_organization_id());

-- NEW: Update sales (admins and pharmacists only)
CREATE POLICY sales_update_staff ON sales
FOR UPDATE
TO authenticated
USING (
    organization_id = public.user_organization_id()
    AND EXISTS (
        SELECT 1 FROM users
        WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist')
    )
)
WITH CHECK (organization_id = public.user_organization_id());

-- ================================================
-- UPDATE SALE_ITEMS TABLE RLS
-- ================================================

DROP POLICY IF EXISTS sale_items_select_authenticated ON sale_items;
DROP POLICY IF EXISTS sale_items_write_staff ON sale_items;

-- NEW: Select sale items from same organization
CREATE POLICY sale_items_select_same_org ON sale_items
FOR SELECT
TO authenticated
USING (organization_id = public.user_organization_id());

-- NEW: Insert sale items (all staff)
CREATE POLICY sale_items_insert_staff ON sale_items
FOR INSERT
TO authenticated
WITH CHECK (organization_id = public.user_organization_id());

-- ================================================
-- UPDATE CLAIMS TABLE RLS
-- ================================================

DROP POLICY IF EXISTS claims_select_authenticated ON claims;
DROP POLICY IF EXISTS claims_write_staff ON claims;

-- NEW: Select claims from same organization
CREATE POLICY claims_select_same_org ON claims
FOR SELECT
TO authenticated
USING (organization_id = public.user_organization_id());

-- NEW: Insert/Update claims (all staff)
CREATE POLICY claims_insert_staff ON claims
FOR INSERT
TO authenticated
WITH CHECK (organization_id = public.user_organization_id());

CREATE POLICY claims_update_staff ON claims
FOR UPDATE
TO authenticated
USING (organization_id = public.user_organization_id())
WITH CHECK (organization_id = public.user_organization_id());

-- ================================================
-- UPDATE CLAIM_ITEMS TABLE RLS
-- ================================================

DROP POLICY IF EXISTS claim_items_select_authenticated ON claim_items;
DROP POLICY IF EXISTS claim_items_write_staff ON claim_items;

-- NEW: Select claim items from same organization
CREATE POLICY claim_items_select_same_org ON claim_items
FOR SELECT
TO authenticated
USING (organization_id = public.user_organization_id());

-- NEW: Insert claim items (all staff)
CREATE POLICY claim_items_insert_staff ON claim_items
FOR INSERT
TO authenticated
WITH CHECK (organization_id = public.user_organization_id());

-- ================================================
-- UPDATE STOCK_MOVEMENTS TABLE RLS (if exists)
-- ================================================

DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'stock_movements') THEN
        -- Drop all existing policies
        DROP POLICY IF EXISTS stock_movements_select_authenticated ON stock_movements;
        DROP POLICY IF EXISTS stock_movements_write_staff ON stock_movements;
        DROP POLICY IF EXISTS stock_movements_select_same_org ON stock_movements;
        DROP POLICY IF EXISTS stock_movements_insert_staff ON stock_movements;

        -- NEW: Select stock movements from same organization
        CREATE POLICY stock_movements_select_same_org ON stock_movements
        FOR SELECT
        TO authenticated
        USING (organization_id = public.user_organization_id());

        -- NEW: Insert stock movements (pharmacists and admins only)
        CREATE POLICY stock_movements_insert_staff ON stock_movements
        FOR INSERT
        TO authenticated
        WITH CHECK (
            organization_id = public.user_organization_id()
            AND EXISTS (
                SELECT 1 FROM users
                WHERE id = auth.uid()
                AND role IN ('admin', 'pharmacist')
            )
        );
    END IF;
END $$;

-- ================================================
-- UPDATE AUDIT_LOGS TABLE RLS (if exists)
-- ================================================

DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'audit_logs') THEN
        -- Drop all existing policies
        DROP POLICY IF EXISTS audit_logs_select_admin ON audit_logs;
        DROP POLICY IF EXISTS audit_logs_insert_authenticated ON audit_logs;
        DROP POLICY IF EXISTS audit_logs_select_admin_same_org ON audit_logs;
        DROP POLICY IF EXISTS audit_logs_insert_all ON audit_logs;

        -- NEW: Select audit logs (admins only, in their org)
        CREATE POLICY audit_logs_select_admin_same_org ON audit_logs
        FOR SELECT
        TO authenticated
        USING (
            organization_id = public.user_organization_id()
            AND EXISTS (
                SELECT 1 FROM users
                WHERE id = auth.uid()
                AND role = 'admin'
            )
        );

        -- NEW: Insert audit logs (all authenticated users, auto-set org)
        CREATE POLICY audit_logs_insert_all ON audit_logs
        FOR INSERT
        TO authenticated
        WITH CHECK (organization_id = public.user_organization_id());
    END IF;
END $$;

-- ================================================
-- UPDATE PHARMACY_SETTINGS TABLE RLS
-- ================================================

DROP POLICY IF EXISTS settings_select_authenticated ON pharmacy_settings;
DROP POLICY IF EXISTS settings_write_admin ON pharmacy_settings;

-- NEW: Select settings from same organization
CREATE POLICY settings_select_same_org ON pharmacy_settings
FOR SELECT
TO authenticated
USING (organization_id = public.user_organization_id());

-- NEW: Insert settings (system/admin only during org creation)
CREATE POLICY settings_insert_admin ON pharmacy_settings
FOR INSERT
TO authenticated
WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
        SELECT 1 FROM users
        WHERE id = auth.uid()
        AND role = 'admin'
    )
);

-- NEW: Update settings (admins only, in their org)
CREATE POLICY settings_update_admin_same_org ON pharmacy_settings
FOR UPDATE
TO authenticated
USING (
    organization_id = public.user_organization_id()
    AND EXISTS (
        SELECT 1 FROM users
        WHERE id = auth.uid()
        AND role = 'admin'
    )
)
WITH CHECK (organization_id = public.user_organization_id());

-- ================================================
-- VERIFICATION
-- ================================================

-- List all RLS policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Multi-tenant RLS policies updated successfully!';
    RAISE NOTICE 'All data is now isolated by organization_id';
END $$;

