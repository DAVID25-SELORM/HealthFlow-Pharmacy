-- ================================================================
-- PATCH: Temporarily align all FEB 2023 tariff prices to the new
-- Private Primary Care Hospital catering-exclusive prices.
-- ================================================================
-- Run after:
--   supabase-patch-private-primary-care-hospital-exclusive-tariff-feb-2023.sql
--
-- Purpose:
--   Uses the newly imported Private Primary Care Hospital / exclusive
--   tariff amounts as the temporary master price list for every active
--   FEB 2023 tariff row with the same G-DRG code.
--
-- Notes:
--   This changes only tariff_amount and updated_at. Facility group,
--   catering option, source file, and source page stay unchanged so the
--   original tariff category labels remain visible until plan-specific
--   amounts are available.
-- ================================================================

BEGIN;

DO $$
DECLARE
  source_count INTEGER;
  updated_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO source_count
  FROM (
    SELECT DISTINCT gdrg_code
    FROM public.nhia_tariff_items
    WHERE tariff_version = 'FEB 2023'
      AND facility_group = 'Private Primary Care Hospital'
      AND catering_option = 'exclusive'
      AND source_file = 'Private Primary Care Hospital (Catering Exclusive) Tariff JAN 2023 (1).pdf'
      AND is_active = true
  ) source_codes;

  IF source_count <> 617 THEN
    RAISE EXCEPTION
      'Expected 617 new Private Primary Care Hospital exclusive tariff prices, found %. Run the private primary care tariff patch first.',
      source_count;
  END IF;

  UPDATE public.nhia_tariff_items AS target
  SET
    tariff_amount = source.tariff_amount,
    updated_at = NOW()
  FROM public.nhia_tariff_items AS source
  WHERE source.tariff_version = 'FEB 2023'
    AND source.facility_group = 'Private Primary Care Hospital'
    AND source.catering_option = 'exclusive'
    AND source.source_file = 'Private Primary Care Hospital (Catering Exclusive) Tariff JAN 2023 (1).pdf'
    AND source.is_active = true
    AND target.tariff_version = source.tariff_version
    AND target.gdrg_code = source.gdrg_code
    AND target.is_active = true
    AND target.tariff_amount IS DISTINCT FROM source.tariff_amount;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE 'Temporarily aligned % FEB 2023 tariff rows to new Private Primary Care Hospital exclusive prices.', updated_count;
END $$;

COMMIT;
