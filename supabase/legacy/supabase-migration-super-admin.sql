-- ================================================
-- SUPER ADMIN MIGRATION
-- ================================================
-- Date: April 16, 2026
-- Description: Add super_admin role for platform-level tenant management
-- Author: David Gabion Selorm
-- ================================================

-- ================================================
-- 1. EXPAND THE ROLE CHECK CONSTRAINT TO INCLUDE super_admin
-- ================================================

ALTER TABLE public.users
DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users
ADD CONSTRAINT users_role_check
CHECK (role IN ('admin', 'pharmacist', 'assistant', 'super_admin'));

-- ================================================
-- 2. ALLOW super_admin TO READ ALL ORGANIZATIONS
-- ================================================

DROP POLICY IF EXISTS organizations_select_super_admin ON organizations;

CREATE POLICY organizations_select_super_admin ON organizations
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'super_admin'
  )
);

-- ================================================
-- 3. ALLOW super_admin TO INSERT NEW ORGANIZATIONS
-- ================================================

DROP POLICY IF EXISTS organizations_insert_super_admin ON organizations;

CREATE POLICY organizations_insert_super_admin ON organizations
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'super_admin'
  )
);

-- ================================================
-- 4. ALLOW super_admin TO UPDATE ANY ORGANIZATION
-- ================================================

DROP POLICY IF EXISTS organizations_update_super_admin ON organizations;

CREATE POLICY organizations_update_super_admin ON organizations
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'super_admin'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'super_admin'
  )
);

-- ================================================
-- 5. ALLOW super_admin TO READ ALL USERS ACROSS TENANTS
-- ================================================

DROP POLICY IF EXISTS users_select_super_admin ON users;

CREATE POLICY users_select_super_admin ON users
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.users u2
    WHERE u2.id = auth.uid() AND u2.role = 'super_admin'
  )
);

-- ================================================
-- 5b. ALLOW super_admin TO UPDATE ANY USER ACROSS TENANTS
-- ================================================

DROP POLICY IF EXISTS users_update_super_admin ON users;

CREATE POLICY users_update_super_admin ON users
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.users u2
    WHERE u2.id = auth.uid() AND u2.role = 'super_admin'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.users u2
    WHERE u2.id = auth.uid() AND u2.role = 'super_admin'
  )
);

-- ================================================
-- 6. PROMOTE YOUR ACCOUNT TO super_admin
-- ================================================
-- Replace with your email before running

UPDATE public.users
SET role = 'super_admin'
WHERE email = 'gabiondavidselorm@gmail.com';

-- ================================================
-- 7. VERIFY
-- ================================================

SELECT email, role, organization_id 
FROM public.users 
WHERE role = 'super_admin';

SELECT policyname, tablename 
FROM pg_policies 
WHERE policyname LIKE '%super_admin%'
ORDER BY tablename, policyname;

DO $$
BEGIN
    RAISE NOTICE 'Super admin migration applied successfully.';
END $$;
