-- ================================================================
-- PATCH: NHIS Medicines List 2025 catalog correction
-- ================================================================
-- Source: 2025 NHIS ML PDF, March 2025, page 23.
-- GLTRSUTA1 uses unit "100 Tablets" and price GHS 121.63.
-- Earlier import output could read the split "100" unit line as price.
-- ================================================================

BEGIN;

ALTER TABLE public.drugs
  ADD COLUMN IF NOT EXISTS nhis_code TEXT,
  ADD COLUMN IF NOT EXISTS nhis_price DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS nhis_unit TEXT,
  ADD COLUMN IF NOT EXISTS is_nhis_listed BOOLEAN NOT NULL DEFAULT false;

UPDATE public.nhis_drugs
SET
  description = 'Glyceryl Trinitrate Sublingual Tablet, 500 microgram',
  unit = '100 Tablets',
  unit_price = 121.63,
  category = 'C',
  updated_at = NOW()
WHERE code = 'GLTRSUTA1';

UPDATE public.drugs
SET
  name = CASE
    WHEN BTRIM(COALESCE(name, '')) = ''
      OR LOWER(BTRIM(name)) = LOWER('Glyceryl Trinitrate Sublingual Tablet, 500 microgram')
    THEN 'Glyceryl Trinitrate Sublingual Tablet, 500 microgram'
    ELSE name
  END,
  unit = CASE
    WHEN nhis_code = 'GLTRSUTA1' THEN '100 Tablets'
    ELSE unit
  END,
  price = CASE
    WHEN BTRIM(COALESCE(batch_number, '')) = 'NHIS-GLTRSUTA1' THEN 121.63
    ELSE price
  END,
  nhis_price = 121.63,
  nhis_unit = '100 Tablets',
  is_nhis_listed = true,
  updated_at = NOW()
WHERE nhis_code = 'GLTRSUTA1';

COMMIT;
