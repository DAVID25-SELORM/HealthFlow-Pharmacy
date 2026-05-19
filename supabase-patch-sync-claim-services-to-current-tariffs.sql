-- ================================================================
-- PATCH: Sync saved NHIS claim service lines to current tariff prices
-- ================================================================
-- Run after:
--   supabase-patch-private-primary-care-hospital-exclusive-tariff-feb-2023.sql
--   supabase-patch-temporarily-align-all-tariffs-to-private-primary-care-feb-2023.sql
--
-- Purpose:
--   Existing hospital claims copied tariff amounts into nhis_claim_services
--   when the service was selected. This refreshes those copied line amounts
--   from the current nhia_tariff_items catalog and recalculates claim totals.
-- ================================================================

BEGIN;

DO $$
DECLARE
  updated_service_count INTEGER;
  updated_claim_count INTEGER;
BEGIN
  UPDATE public.nhis_claim_services AS service
  SET
    tariff_version = tariff.tariff_version,
    facility_group = tariff.facility_group,
    catering_option = tariff.catering_option,
    mdc = tariff.mdc,
    gdrg_code = tariff.gdrg_code,
    description = tariff.description,
    age_band = tariff.age_band,
    unit_price = tariff.tariff_amount,
    total_amount = ROUND((tariff.tariff_amount * service.quantity)::NUMERIC, 2),
    source_file = tariff.source_file,
    source_page = tariff.source_page
  FROM public.nhia_tariff_items AS tariff
  WHERE service.nhia_tariff_item_id = tariff.id
    AND tariff.is_active = true
    AND (
      service.tariff_version IS DISTINCT FROM tariff.tariff_version OR
      service.facility_group IS DISTINCT FROM tariff.facility_group OR
      service.catering_option IS DISTINCT FROM tariff.catering_option OR
      service.mdc IS DISTINCT FROM tariff.mdc OR
      service.gdrg_code IS DISTINCT FROM tariff.gdrg_code OR
      service.description IS DISTINCT FROM tariff.description OR
      service.age_band IS DISTINCT FROM tariff.age_band OR
      service.unit_price IS DISTINCT FROM tariff.tariff_amount OR
      service.total_amount IS DISTINCT FROM ROUND((tariff.tariff_amount * service.quantity)::NUMERIC, 2) OR
      service.source_file IS DISTINCT FROM tariff.source_file OR
      service.source_page IS DISTINCT FROM tariff.source_page
    );

  GET DIAGNOSTICS updated_service_count = ROW_COUNT;

  WITH claim_totals AS (
    SELECT
      claim.id,
      COALESCE(medicine_totals.total_amount, 0) + COALESCE(service_totals.total_amount, 0) AS total_amount
    FROM public.nhis_claims AS claim
    LEFT JOIN (
      SELECT claim_id, SUM(total_amount)::NUMERIC(12,2) AS total_amount
      FROM public.nhis_claim_medicines
      GROUP BY claim_id
    ) AS medicine_totals ON medicine_totals.claim_id = claim.id
    LEFT JOIN (
      SELECT claim_id, SUM(total_amount)::NUMERIC(12,2) AS total_amount
      FROM public.nhis_claim_services
      GROUP BY claim_id
    ) AS service_totals ON service_totals.claim_id = claim.id
    WHERE EXISTS (
      SELECT 1
      FROM public.nhis_claim_services AS service
      WHERE service.claim_id = claim.id
    )
  )
  UPDATE public.nhis_claims AS claim
  SET
    total_amount = claim_totals.total_amount,
    updated_at = NOW()
  FROM claim_totals
  WHERE claim.id = claim_totals.id
    AND claim.total_amount IS DISTINCT FROM claim_totals.total_amount;

  GET DIAGNOSTICS updated_claim_count = ROW_COUNT;

  RAISE NOTICE 'Synced % NHIS claim service lines and recalculated % claim totals.', updated_service_count, updated_claim_count;
END $$;

COMMIT;
