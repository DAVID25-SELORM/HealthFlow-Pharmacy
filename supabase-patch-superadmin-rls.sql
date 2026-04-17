-- ================================================
-- PATCH: Fix super_admin RLS recursion and tighten tenant admin policies
-- ================================================
-- Date: April 17, 2026
-- Problem:
-- 1. Several RLS policies query public.users from inside public.users policies,
--    which causes recursive policy evaluation and PostgREST 500 errors.
-- 2. Some older role logic still treats only admin/pharmacist/assistant as valid,
--    which can downgrade super_admin sessions.
-- 3. Older tenant policies are too broad:
--    - users can self-escalate if self/admin updates share one policy
--    - any org member can update organizations via organizations_update_owner
-- Fix:
-- - Add SECURITY DEFINER helper functions that read current role/org/branch safely.
-- - Recreate users/organizations/branches super-admin policies using helpers.
-- - Split self-user updates from admin-managed updates.
-- - Limit direct organization updates to super_admin only.
-- - Sync your auth metadata role to super_admin.
-- ================================================

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.users WHERE id = auth.uid()
$$;

COMMENT ON FUNCTION public.current_user_role() IS 'Returns the role of the currently authenticated user';

CREATE OR REPLACE FUNCTION public.current_user_branch_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT branch_id FROM public.users WHERE id = auth.uid()
$$;

COMMENT ON FUNCTION public.current_user_branch_id() IS 'Returns the branch_id of the currently authenticated user';

CREATE OR REPLACE FUNCTION public.current_user_is_active()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_active FROM public.users WHERE id = auth.uid()
$$;

COMMENT ON FUNCTION public.current_user_is_active() IS 'Returns whether the currently authenticated user is active';

CREATE OR REPLACE FUNCTION public.branch_belongs_to_organization(
  target_branch_id UUID,
  target_organization_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.branches
    WHERE id = target_branch_id
      AND organization_id IS NOT DISTINCT FROM target_organization_id
  )
$$;

COMMENT ON FUNCTION public.branch_belongs_to_organization(UUID, UUID) IS 'Returns true when a branch belongs to the given organization';

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_user_role() = 'super_admin', false)
$$;

COMMENT ON FUNCTION public.is_super_admin() IS 'Returns true when the current user is a super_admin';

CREATE OR REPLACE FUNCTION public.is_org_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_user_role() = 'admin', false)
$$;

COMMENT ON FUNCTION public.is_org_admin() IS 'Returns true when the current user is an org admin';

CREATE OR REPLACE FUNCTION public.app_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  role_value TEXT;
BEGIN
  role_value := COALESCE(
    auth.jwt() -> 'app_metadata' ->> 'role',
    auth.jwt() -> 'user_metadata' ->> 'role',
    public.current_user_role(),
    'assistant'
  );

  IF role_value NOT IN ('admin', 'pharmacist', 'assistant', 'super_admin') THEN
    RETURN 'assistant';
  END IF;

  RETURN role_value;
END;
$$;

UPDATE public.users u
SET role = 'super_admin',
    email = au.email
FROM auth.users au
WHERE u.id = au.id
  AND au.email = 'gabiondavidselorm@gmail.com';

UPDATE auth.users
SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || '{"role":"super_admin"}'::jsonb,
    raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) - 'role'
WHERE email = 'gabiondavidselorm@gmail.com';

DROP POLICY IF EXISTS users_select_self ON public.users;
DROP POLICY IF EXISTS users_select_sa ON public.users;
DROP POLICY IF EXISTS users_update_sa ON public.users;
DROP POLICY IF EXISTS users_insert_sa ON public.users;
DROP POLICY IF EXISTS users_select_super_admin ON public.users;
DROP POLICY IF EXISTS users_update_super_admin ON public.users;
DROP POLICY IF EXISTS users_select_same_org ON public.users;
DROP POLICY IF EXISTS users_update_self_or_admin ON public.users;
DROP POLICY IF EXISTS users_update_self_safe ON public.users;
DROP POLICY IF EXISTS users_update_admin_same_org ON public.users;
DROP POLICY IF EXISTS users_insert_admin ON public.users;

CREATE POLICY users_select_self ON public.users
FOR SELECT TO authenticated
USING (id = auth.uid());

CREATE POLICY users_select_same_org ON public.users
FOR SELECT TO authenticated
USING (
  public.is_super_admin()
  OR id = auth.uid()
  OR organization_id = public.user_organization_id()
);

CREATE POLICY users_update_self_safe ON public.users
FOR UPDATE TO authenticated
USING (id = auth.uid())
WITH CHECK (
  id = auth.uid()
  AND role = public.current_user_role()
  AND organization_id IS NOT DISTINCT FROM public.user_organization_id()
  AND branch_id IS NOT DISTINCT FROM public.current_user_branch_id()
  AND is_active IS NOT DISTINCT FROM public.current_user_is_active()
);

CREATE POLICY users_update_admin_same_org ON public.users
FOR UPDATE TO authenticated
USING (
  public.is_org_admin()
  AND id <> auth.uid()
  AND organization_id = public.user_organization_id()
)
WITH CHECK (
  public.is_org_admin()
  AND id <> auth.uid()
  AND organization_id = public.user_organization_id()
  AND role IN ('admin', 'pharmacist', 'assistant')
  AND (
    branch_id IS NULL
    OR public.branch_belongs_to_organization(branch_id, public.user_organization_id())
  )
);

CREATE POLICY users_insert_admin ON public.users
FOR INSERT TO authenticated
WITH CHECK (
  public.is_org_admin()
  AND organization_id = public.user_organization_id()
  AND role IN ('admin', 'pharmacist', 'assistant')
  AND (
    branch_id IS NULL
    OR public.branch_belongs_to_organization(branch_id, public.user_organization_id())
  )
);

DROP POLICY IF EXISTS organizations_select_super_admin ON public.organizations;
DROP POLICY IF EXISTS organizations_insert_super_admin ON public.organizations;
DROP POLICY IF EXISTS organizations_update_super_admin ON public.organizations;
DROP POLICY IF EXISTS organizations_update_owner ON public.organizations;

CREATE POLICY organizations_select_super_admin ON public.organizations
FOR SELECT TO authenticated
USING (public.is_super_admin());

CREATE POLICY organizations_insert_super_admin ON public.organizations
FOR INSERT TO authenticated
WITH CHECK (public.is_super_admin());

CREATE POLICY organizations_update_super_admin ON public.organizations
FOR UPDATE TO authenticated
USING (public.is_super_admin())
WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS branches_select_super_admin ON public.branches;
DROP POLICY IF EXISTS branches_insert_super_admin ON public.branches;
DROP POLICY IF EXISTS branches_update_super_admin ON public.branches;

CREATE POLICY branches_select_super_admin ON public.branches
FOR SELECT TO authenticated
USING (public.is_super_admin());

CREATE POLICY branches_insert_super_admin ON public.branches
FOR INSERT TO authenticated
WITH CHECK (public.is_super_admin());

CREATE POLICY branches_update_super_admin ON public.branches
FOR UPDATE TO authenticated
USING (public.is_super_admin())
WITH CHECK (public.is_super_admin());

DO $$
BEGIN
  RAISE NOTICE 'super_admin recursion-safe patch applied. Sign out and sign back in to refresh JWT role metadata.';
END $$;

SELECT
  u.id,
  u.email,
  u.role AS public_role,
  u.organization_id,
  au.raw_app_meta_data ->> 'role' AS jwt_app_role,
  au.raw_user_meta_data ->> 'role' AS jwt_user_role
FROM public.users u
JOIN auth.users au ON au.id = u.id
WHERE au.email = 'gabiondavidselorm@gmail.com';

SELECT public.current_user_role() AS current_user_role_fn;
