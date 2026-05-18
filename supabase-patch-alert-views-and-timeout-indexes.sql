-- ================================================================
-- PATCH: Alert views and timeout indexes
-- ================================================================
-- Date: 2026-05-18
-- Purpose:
--   Repairs stock alert views used by the dashboard/top bar and adds
--   indexes for hosted inventory search/report paths that were timing out.
-- ================================================================

CREATE INDEX IF NOT EXISTS idx_drugs_org_status_qty
  ON public.drugs (organization_id, status, quantity);

CREATE INDEX IF NOT EXISTS idx_drugs_org_status_expiry
  ON public.drugs (organization_id, status, expiry_date);

CREATE INDEX IF NOT EXISTS idx_drugs_org_branch_status_name
  ON public.drugs (organization_id, branch_id, status, name);

CREATE INDEX IF NOT EXISTS idx_sales_org_sale_date
  ON public.sales (organization_id, sale_date);

CREATE INDEX IF NOT EXISTS idx_claims_org_service_date
  ON public.claims (organization_id, service_date);

CREATE OR REPLACE VIEW public.low_stock_drugs
WITH (security_invoker = true)
AS
SELECT d.*
FROM public.drugs AS d
WHERE d.status = 'active'
  AND COALESCE(d.quantity, 0) <= COALESCE(d.reorder_level, 0)
  AND NOT (
    UPPER(COALESCE(d.batch_number, '')) LIKE 'PDF-IMP-%'
    AND COALESCE(d.quantity, 0) <= 0
  )
ORDER BY d.quantity ASC NULLS FIRST, d.name ASC;

CREATE OR REPLACE VIEW public.expiring_soon_drugs
WITH (security_invoker = true)
AS
SELECT
  d.*,
  (d.expiry_date - CURRENT_DATE) AS days_until_expiry
FROM public.drugs AS d
WHERE d.status = 'active'
  AND d.expiry_date >= CURRENT_DATE
  AND d.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
  AND NOT (
    UPPER(COALESCE(d.batch_number, '')) LIKE 'PDF-IMP-%'
    AND COALESCE(d.quantity, 0) <= 0
  )
ORDER BY d.expiry_date ASC, d.name ASC;

CREATE OR REPLACE VIEW public.expired_drugs
WITH (security_invoker = true)
AS
SELECT
  d.*,
  (COALESCE(d.price, 0) * COALESCE(d.quantity, 0)) AS total_value
FROM public.drugs AS d
WHERE d.expiry_date < CURRENT_DATE
  AND NOT (
    UPPER(COALESCE(d.batch_number, '')) LIKE 'PDF-IMP-%'
    AND COALESCE(d.quantity, 0) <= 0
  )
ORDER BY d.expiry_date DESC, d.name ASC;
