-- ================================================================
-- PATCH: NHIS inventory price backfill
-- ================================================================
-- Date: 2026-05-18
-- Purpose:
--   Backfills existing NHIS-linked inventory rows whose normal selling
--   price stayed at zero, while preserving any real retail price already
--   entered by the pharmacy.
-- ================================================================

BEGIN;

ALTER TABLE public.drugs
  ADD COLUMN IF NOT EXISTS nhis_code TEXT,
  ADD COLUMN IF NOT EXISTS nhis_price DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS nhis_unit TEXT,
  ADD COLUMN IF NOT EXISTS is_nhis_listed BOOLEAN NOT NULL DEFAULT false;

UPDATE public.drugs AS d
SET
  nhis_code = UPPER(n.code),
  nhis_price = n.unit_price,
  nhis_unit = COALESCE(NULLIF(BTRIM(n.unit), ''), d.nhis_unit, d.unit),
  is_nhis_listed = true,
  price = CASE
    WHEN COALESCE(d.price, 0) <= 0 AND COALESCE(n.unit_price, 0) > 0 THEN n.unit_price
    ELSE d.price
  END,
  updated_at = NOW()
FROM public.nhis_drugs AS n
WHERE n.organization_id = d.organization_id
  AND COALESCE(n.is_active, true) = true
  AND (
    UPPER(COALESCE(d.nhis_code, '')) = UPPER(n.code)
    OR UPPER(COALESCE(d.batch_number, '')) = 'NHIS-' || UPPER(n.code)
    OR LOWER(REGEXP_REPLACE(COALESCE(d.name, ''), '[[:space:]]+', ' ', 'g')) =
       LOWER(REGEXP_REPLACE(COALESCE(n.description, ''), '[[:space:]]+', ' ', 'g'))
  );

UPDATE public.drugs
SET
  price = nhis_price,
  updated_at = NOW()
WHERE is_nhis_listed = true
  AND COALESCE(price, 0) <= 0
  AND COALESCE(nhis_price, 0) > 0;

COMMIT;
