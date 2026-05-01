-- ================================================================
-- PRODUCTION SECURITY AUDIT: RLS, policies, grants, and functions
-- ================================================================
-- Purpose:
--   Run this in Supabase SQL Editor to verify the live production DB.
--   This script is read-only. It does not modify data or policies.
-- ================================================================

-- 1) RLS status for sensitive public tables.
WITH expected_tables(table_name) AS (
    VALUES
        ('organizations'),
        ('users'),
        ('branches'),
        ('drugs'),
        ('patients'),
        ('sales'),
        ('sale_items'),
        ('claims'),
        ('claim_items'),
        ('stock_movements'),
        ('audit_logs'),
        ('pharmacy_settings'),
        ('shifts'),
        ('shift_cash_movements'),
        ('expense_categories'),
        ('expenses'),
        ('cashbook_sessions'),
        ('cashbook_entries'),
        ('claim_payments')
)
SELECT
    expected_tables.table_name,
    COALESCE(pg_class.relrowsecurity, false) AS rls_enabled,
    COALESCE(pg_class.relforcerowsecurity, false) AS rls_forced,
    CASE
        WHEN pg_class.oid IS NULL THEN 'MISSING TABLE'
        WHEN pg_class.relrowsecurity THEN 'OK'
        ELSE 'RISK: RLS DISABLED'
    END AS audit_status
FROM expected_tables
LEFT JOIN pg_class
    ON pg_class.relname = expected_tables.table_name
LEFT JOIN pg_namespace
    ON pg_namespace.oid = pg_class.relnamespace
    AND pg_namespace.nspname = 'public'
ORDER BY expected_tables.table_name;

-- 2) Policy count by table. Sensitive tables should have policies.
SELECT
    tablename,
    COUNT(*) AS policy_count,
    STRING_AGG(policyname || ' [' || cmd || ']', ', ' ORDER BY policyname) AS policies
FROM pg_policies
WHERE schemaname = 'public'
GROUP BY tablename
ORDER BY tablename;

-- 3) Full policy definitions for manual review.
SELECT
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual AS using_expression,
    with_check AS check_expression
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- 4) Required security functions and whether they are SECURITY DEFINER.
SELECT
    n.nspname AS schema_name,
    p.proname AS function_name,
    pg_get_function_arguments(p.oid) AS arguments,
    CASE
        WHEN p.prosecdef THEN 'OK: SECURITY DEFINER'
        ELSE 'RISK: SECURITY INVOKER'
    END AS security_mode,
    pg_get_userbyid(p.proowner) AS owner,
    p.proconfig AS function_settings
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
      'user_organization_id',
      'current_user_role',
      'current_user_organization_id',
      'is_super_admin',
      'create_sale_transaction',
      'refund_sale_transaction',
      'log_audit_event',
      'generate_sale_number'
  )
ORDER BY p.proname, arguments;

-- 5) Function execute grants exposed to anon/authenticated/public.
SELECT
    routine_schema,
    routine_name,
    grantee,
    privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN (
      'create_sale_transaction',
      'refund_sale_transaction',
      'log_audit_event',
      'generate_sale_number'
  )
  AND grantee IN ('PUBLIC', 'anon', 'authenticated')
ORDER BY routine_name, grantee;

-- 6) Table grants that may allow direct browser writes.
SELECT
    table_schema,
    table_name,
    grantee,
    privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  AND table_name IN (
      'organizations',
      'users',
      'branches',
      'drugs',
      'patients',
      'sales',
      'sale_items',
      'claims',
      'claim_items',
      'stock_movements',
      'audit_logs',
      'pharmacy_settings',
      'shifts',
      'shift_cash_movements',
      'expense_categories',
      'expenses',
      'cashbook_sessions',
      'cashbook_entries',
      'claim_payments'
  )
ORDER BY table_name, grantee, privilege_type;

-- 7) Policies that do not reference organization isolation or auth.uid().
-- These are not automatically wrong, but they need manual review.
SELECT
    tablename,
    policyname,
    cmd,
    qual AS using_expression,
    with_check AS check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
      'organizations',
      'users',
      'branches',
      'drugs',
      'patients',
      'sales',
      'sale_items',
      'claims',
      'claim_items',
      'stock_movements',
      'audit_logs',
      'pharmacy_settings',
      'shifts',
      'shift_cash_movements',
      'expense_categories',
      'expenses',
      'cashbook_sessions',
      'cashbook_entries',
      'claim_payments'
  )
  AND COALESCE(qual, '') || ' ' || COALESCE(with_check, '') NOT ILIKE '%organization%'
  AND COALESCE(qual, '') || ' ' || COALESCE(with_check, '') NOT ILIKE '%auth.uid%'
ORDER BY tablename, policyname;

-- 8) Cross-tenant data health checks. Any non-zero result needs review.
SELECT 'drugs_missing_organization_id' AS check_name, COUNT(*) AS issue_count
FROM public.drugs
WHERE organization_id IS NULL
UNION ALL
SELECT 'sales_missing_organization_id', COUNT(*)
FROM public.sales
WHERE organization_id IS NULL
UNION ALL
SELECT 'sale_items_missing_organization_id', COUNT(*)
FROM public.sale_items
WHERE organization_id IS NULL
UNION ALL
SELECT 'patients_missing_organization_id', COUNT(*)
FROM public.patients
WHERE organization_id IS NULL
UNION ALL
SELECT 'users_missing_organization_id_non_super_admin', COUNT(*)
FROM public.users
WHERE organization_id IS NULL
  AND COALESCE(role, '') <> 'super_admin';

-- 9) Recent audit log activity to confirm logging is alive.
SELECT
    created_at,
    actor_email,
    actor_user_id,
    event_type,
    entity_type,
    entity_id,
    action,
    details
FROM public.audit_logs
ORDER BY created_at DESC
LIMIT 20;

-- 10) Final executive summary.
-- Supabase SQL Editor shows the last result most prominently, so this
-- summary is placed last on purpose.
WITH expected_tables(table_name) AS (
    VALUES
        ('organizations'),
        ('users'),
        ('branches'),
        ('drugs'),
        ('patients'),
        ('sales'),
        ('sale_items'),
        ('claims'),
        ('claim_items'),
        ('stock_movements'),
        ('audit_logs'),
        ('pharmacy_settings'),
        ('shifts'),
        ('shift_cash_movements'),
        ('expense_categories'),
        ('expenses'),
        ('cashbook_sessions'),
        ('cashbook_entries'),
        ('claim_payments')
),
table_status AS (
    SELECT
        expected_tables.table_name,
        pg_class.oid IS NOT NULL AS table_exists,
        COALESCE(pg_class.relrowsecurity, false) AS rls_enabled
    FROM expected_tables
    LEFT JOIN pg_class
        ON pg_class.relname = expected_tables.table_name
    LEFT JOIN pg_namespace
        ON pg_namespace.oid = pg_class.relnamespace
        AND pg_namespace.nspname = 'public'
),
required_functions(function_name) AS (
    VALUES
        ('create_sale_transaction'),
        ('refund_sale_transaction'),
        ('log_audit_event'),
        ('generate_sale_number')
),
function_status AS (
    SELECT
        required_functions.function_name,
        COUNT(pg_proc.oid) AS function_count,
        BOOL_OR(pg_proc.prosecdef) AS has_security_definer
    FROM required_functions
    LEFT JOIN pg_proc
        ON pg_proc.proname = required_functions.function_name
    LEFT JOIN pg_namespace
        ON pg_namespace.oid = pg_proc.pronamespace
        AND pg_namespace.nspname = 'public'
    GROUP BY required_functions.function_name
),
issue_rows AS (
    SELECT
        'RLS disabled or table missing' AS check_name,
        table_name AS object_name,
        CASE
            WHEN NOT table_exists THEN 'MISSING TABLE'
            WHEN NOT rls_enabled THEN 'RISK: RLS DISABLED'
            ELSE 'OK'
        END AS status
    FROM table_status
    WHERE NOT table_exists OR NOT rls_enabled

    UNION ALL

    SELECT
        'Required security function missing or not SECURITY DEFINER',
        function_name,
        CASE
            WHEN function_count = 0 THEN 'MISSING FUNCTION'
            WHEN NOT has_security_definer THEN 'RISK: NOT SECURITY DEFINER'
            ELSE 'OK'
        END
    FROM function_status
    WHERE function_count = 0 OR NOT has_security_definer

    UNION ALL

    SELECT
        'Rows missing organization_id',
        'drugs',
        COUNT(*)::TEXT
    FROM public.drugs
    WHERE organization_id IS NULL
    HAVING COUNT(*) > 0

    UNION ALL

    SELECT
        'Rows missing organization_id',
        'sales',
        COUNT(*)::TEXT
    FROM public.sales
    WHERE organization_id IS NULL
    HAVING COUNT(*) > 0

    UNION ALL

    SELECT
        'Rows missing organization_id',
        'sale_items',
        COUNT(*)::TEXT
    FROM public.sale_items
    WHERE organization_id IS NULL
    HAVING COUNT(*) > 0

    UNION ALL

    SELECT
        'Rows missing organization_id',
        'patients',
        COUNT(*)::TEXT
    FROM public.patients
    WHERE organization_id IS NULL
    HAVING COUNT(*) > 0

    UNION ALL

    SELECT
        'Non-super-admin users missing organization_id',
        'users',
        COUNT(*)::TEXT
    FROM public.users
    WHERE organization_id IS NULL
      AND COALESCE(role, '') <> 'super_admin'
    HAVING COUNT(*) > 0
)
SELECT
    CASE
        WHEN EXISTS (SELECT 1 FROM issue_rows) THEN 'REVIEW_REQUIRED'
        ELSE 'PASS'
    END AS overall_status,
    check_name,
    object_name,
    status
FROM issue_rows
UNION ALL
SELECT
    'PASS',
    'No blocking RLS/function/data-isolation issues found by this summary',
    'production_security_audit',
    'OK'
WHERE NOT EXISTS (SELECT 1 FROM issue_rows)
ORDER BY overall_status DESC, check_name, object_name;
