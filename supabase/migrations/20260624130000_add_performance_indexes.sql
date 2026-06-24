-- Performance indexes identified from query pattern analysis.
--
-- 1. sales(sale_date, payment_status)
--    Dashboard loads 2 months of completed sales filtered by both columns.
--    The existing idx_sales_date covers sale_date alone; this composite index
--    lets Postgres satisfy the payment_status equality filter in the same scan.
--
-- 2. sales(patient_id, sale_date DESC)
--    Patient history and last-visit queries filter by patient_id then ORDER BY
--    sale_date DESC LIMIT 1.  The existing idx_sales_patient covers patient_id
--    alone and forces a separate sort step; the composite index eliminates it.
--
-- 3. nhia_tariff_items(tariff_version, facility_group, catering_option)
--    The NHIS workspace loads tariff items filtered by all three columns on
--    every mount.  No index exists on this table yet.

CREATE INDEX IF NOT EXISTS idx_sales_date_payment
  ON public.sales(sale_date, payment_status);

CREATE INDEX IF NOT EXISTS idx_sales_patient_date
  ON public.sales(patient_id, sale_date DESC);

CREATE INDEX IF NOT EXISTS idx_nhia_tariff_lookup
  ON public.nhia_tariff_items(tariff_version, facility_group, catering_option);
