-- ================================================
-- BRANCHES MIGRATION
-- ================================================
-- Date: April 16, 2026
-- Description: Add multi-branch support for pharmacy organizations
-- Author: David Gabion Selorm
-- ================================================

-- ================================================
-- 1. CREATE BRANCHES TABLE
-- ================================================

CREATE TABLE IF NOT EXISTS public.branches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  code            VARCHAR(50),
  phone           VARCHAR(20),
  email           VARCHAR(255),
  address         TEXT,
  city            VARCHAR(100),
  region          VARCHAR(100),
  is_main         BOOLEAN NOT NULL DEFAULT false,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branches_org      ON public.branches(organization_id);
CREATE INDEX IF NOT EXISTS idx_branches_org_main ON public.branches(organization_id, is_main);

COMMENT ON TABLE  public.branches IS 'Physical branch locations under a pharmacy organization';
COMMENT ON COLUMN public.branches.is_main IS 'True for the head-office branch — protected from deactivation';

-- ================================================
-- 2. ADD BRANCH_ID TO USERS
-- ================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_branch ON public.users(branch_id);

-- ================================================
-- 3. ENABLE RLS ON BRANCHES
-- ================================================

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

-- Any org member can view all branches in their org
DROP POLICY IF EXISTS branches_select_same_org ON public.branches;
CREATE POLICY branches_select_same_org ON public.branches
FOR SELECT TO authenticated
USING (organization_id = public.user_organization_id());

-- Only admins can create branches
DROP POLICY IF EXISTS branches_insert_admin ON public.branches;
CREATE POLICY branches_insert_admin ON public.branches
FOR INSERT TO authenticated
WITH CHECK (
  organization_id = public.user_organization_id()
  AND EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
  )
);

-- Only admins can update branches
DROP POLICY IF EXISTS branches_update_admin ON public.branches;
CREATE POLICY branches_update_admin ON public.branches
FOR UPDATE TO authenticated
USING (
  organization_id = public.user_organization_id()
  AND EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
  )
)
WITH CHECK (organization_id = public.user_organization_id());

-- ================================================
-- 4. SUPER ADMIN POLICIES FOR BRANCHES
-- ================================================

DROP POLICY IF EXISTS branches_select_super_admin ON public.branches;
CREATE POLICY branches_select_super_admin ON public.branches
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.users u2
    WHERE u2.id = auth.uid() AND u2.role = 'super_admin'
  )
);

DROP POLICY IF EXISTS branches_insert_super_admin ON public.branches;
CREATE POLICY branches_insert_super_admin ON public.branches
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.users u2
    WHERE u2.id = auth.uid() AND u2.role = 'super_admin'
  )
);

DROP POLICY IF EXISTS branches_update_super_admin ON public.branches;
CREATE POLICY branches_update_super_admin ON public.branches
FOR UPDATE TO authenticated
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
-- 5. SEED: CREATE MAIN BRANCH FOR EXISTING ORGANIZATIONS
-- ================================================

INSERT INTO public.branches (organization_id, name, code, is_main, is_active)
SELECT o.id, o.name, 'MAIN', true, true
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.branches b
  WHERE b.organization_id = o.id AND b.is_main = true
);

-- ================================================
-- 6. VERIFY
-- ================================================

SELECT
  o.name AS organization,
  b.name AS branch,
  b.code,
  b.is_main,
  b.is_active
FROM public.organizations o
JOIN public.branches b ON b.organization_id = o.id
ORDER BY o.name, b.is_main DESC;

SELECT policyname, tablename, cmd
FROM pg_policies
WHERE tablename = 'branches'
ORDER BY policyname;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'branch_id';

DO $$
BEGIN
  RAISE NOTICE 'Branches migration applied successfully.';
END $$;
