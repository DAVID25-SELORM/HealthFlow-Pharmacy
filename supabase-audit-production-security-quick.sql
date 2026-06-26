-- ================================================================
-- QUICK PRODUCTION SECURITY AUDIT: metadata only, timeout-safe
-- ================================================================
-- Purpose:
--   Paste this into Supabase SQL Editor when the full audit times out.
--   It does not scan production data rows.
-- ================================================================

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
        ('claim_payments'),
        ('nhis_claims'),
        ('nhis_claim_medicines'),
        ('nhis_claim_services'),
        ('nhis_claim_payments'),
        ('nhis_drugs'),
        ('nhia_configuration'),
        ('organization_nhia_integrations'),
        ('payment_attempts'),
        ('branch_sync_clients')
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
policy_status AS (
    SELECT
        tablename AS table_name,
        COUNT(*) AS policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
    GROUP BY tablename
),
service_only_tables(table_name) AS (
    VALUES
        ('organization_nhia_integrations'),
        ('branch_sync_clients')
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
        'No RLS policies found',
        table_status.table_name,
        'REVIEW: no policy rows'
    FROM table_status
    LEFT JOIN policy_status ON policy_status.table_name = table_status.table_name
    LEFT JOIN service_only_tables ON service_only_tables.table_name = table_status.table_name
    WHERE table_status.table_exists
      AND table_status.rls_enabled
      AND service_only_tables.table_name IS NULL
      AND COALESCE(policy_status.policy_count, 0) = 0

    UNION ALL

    SELECT
        'Credential table has client-facing policies',
        'organization_nhia_integrations',
        COUNT(*)::text
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'organization_nhia_integrations'
    HAVING COUNT(*) > 0

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
    'No blocking metadata-only RLS/function issues found',
    'quick_production_security_audit',
    'OK'
WHERE NOT EXISTS (SELECT 1 FROM issue_rows)
ORDER BY overall_status DESC, check_name, object_name;
