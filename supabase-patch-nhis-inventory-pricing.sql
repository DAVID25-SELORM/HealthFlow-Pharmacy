-- ================================================================
-- PATCH: Mirror NHIS catalog pricing into inventory
-- ================================================================
-- Date: 2026-05-07
-- Purpose:
--   Keep the normal inventory selling price while storing the NHIS
--   code/price beside it for NHIS patient sales and top-up display.
-- ================================================================

BEGIN;

ALTER TABLE public.drugs
  ADD COLUMN IF NOT EXISTS nhis_code TEXT,
  ADD COLUMN IF NOT EXISTS nhis_price DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS nhis_unit TEXT,
  ADD COLUMN IF NOT EXISTS is_nhis_listed BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_drugs_org_nhis_code
  ON public.drugs (organization_id, nhis_code)
  WHERE nhis_code IS NOT NULL
    AND BTRIM(nhis_code) <> '';

CREATE INDEX IF NOT EXISTS idx_drugs_org_nhis_listed
  ON public.drugs (organization_id, is_nhis_listed)
  WHERE is_nhis_listed = true;

ALTER TABLE public.drugs
  DROP CONSTRAINT IF EXISTS drugs_nhis_price_non_negative;

ALTER TABLE public.drugs
  ADD CONSTRAINT drugs_nhis_price_non_negative
  CHECK (nhis_price IS NULL OR nhis_price >= 0);

COMMIT;
