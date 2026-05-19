-- ✅ NHIS PHARMACY LEVEL PATCH START
-- Adds facility pharmacy levels and medicine-level access fields used by
-- HealthFlow UI validation before dispensing or NHIS claim export/submission.

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS pharmacy_level TEXT
    CHECK (pharmacy_level IS NULL OR pharmacy_level IN ('P1', 'P2', 'LCS', 'HP'));

ALTER TABLE public.pharmacy_settings
  ADD COLUMN IF NOT EXISTS pharmacy_level TEXT
    CHECK (pharmacy_level IS NULL OR pharmacy_level IN ('P1', 'P2', 'LCS', 'HP'));

ALTER TABLE public.drugs
  ADD COLUMN IF NOT EXISTS required_pharmacy_level TEXT
    CHECK (required_pharmacy_level IS NULL OR required_pharmacy_level IN ('P1', 'P2', 'LCS', 'HP')),
  ADD COLUMN IF NOT EXISTS medicine_access_level TEXT
    CHECK (medicine_access_level IS NULL OR medicine_access_level IN ('OTC', 'Prescription', 'Specialist', 'Controlled'));

ALTER TABLE public.nhis_drugs
  ADD COLUMN IF NOT EXISTS required_pharmacy_level TEXT
    CHECK (required_pharmacy_level IS NULL OR required_pharmacy_level IN ('P1', 'P2', 'LCS', 'HP')),
  ADD COLUMN IF NOT EXISTS medicine_access_level TEXT
    CHECK (medicine_access_level IS NULL OR medicine_access_level IN ('OTC', 'Prescription', 'Specialist', 'Controlled'));

ALTER TABLE public.nhis_claim_medicines
  ADD COLUMN IF NOT EXISTS required_pharmacy_level TEXT
    CHECK (required_pharmacy_level IS NULL OR required_pharmacy_level IN ('P1', 'P2', 'LCS', 'HP')),
  ADD COLUMN IF NOT EXISTS medicine_access_level TEXT
    CHECK (medicine_access_level IS NULL OR medicine_access_level IN ('OTC', 'Prescription', 'Specialist', 'Controlled'));

UPDATE public.organizations
SET pharmacy_level = 'HP'
WHERE organization_type = 'hospital'
  AND pharmacy_level IS NULL;

COMMIT;

-- ✅ NHIS PHARMACY LEVEL PATCH END
