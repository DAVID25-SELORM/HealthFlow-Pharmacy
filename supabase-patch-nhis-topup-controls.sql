-- ================================================================
-- PATCH: Add tenant-level NHIS top-up control
-- ================================================================
-- Purpose:
--   Keep normal NHIS claim workflows without patient top-up by default,
--   while allowing selected pharmacies to collect NHIS patient top-ups.
-- ================================================================

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS can_use_nhis_topups BOOLEAN NOT NULL DEFAULT false;

UPDATE public.organizations
SET can_use_nhis_topups = false
WHERE can_use_nhis_topups IS NULL
   OR COALESCE(can_use_nhis, false) = false;

COMMIT;
