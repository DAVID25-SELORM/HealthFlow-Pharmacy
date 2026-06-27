-- ================================================
-- PATCH: Allow super_admin to read activity logs
-- Date: 2026-04-24
-- ================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'audit_logs'
  ) THEN
    DROP POLICY IF EXISTS audit_logs_select_pharmacist_admin ON audit_logs;
    DROP POLICY IF EXISTS audit_logs_select_admin_same_org ON audit_logs;

    CREATE POLICY audit_logs_select_admin_superadmin_same_org ON audit_logs
    FOR SELECT
    TO authenticated
    USING (
      organization_id = public.user_organization_id()
      AND EXISTS (
        SELECT 1
        FROM users
        WHERE id = auth.uid()
          AND role IN ('admin', 'super_admin')
      )
    );
  END IF;
END $$;
