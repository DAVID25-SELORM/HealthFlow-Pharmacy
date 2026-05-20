-- ================================================================
-- PATCH: NHIS internal unserved-medicines audit note
-- ================================================================
-- Purpose:
--   Stores medicines that could not be served for internal audit only.
--   This field is intentionally excluded from CLAIM-it exports.
-- ================================================================

BEGIN;

ALTER TABLE public.nhis_claims
  ADD COLUMN IF NOT EXISTS unserved_medicines_note TEXT;

COMMENT ON COLUMN public.nhis_claims.unserved_medicines_note IS
  'Internal audit note for medicines prescribed/requested but not served. Excluded from CLAIM-it exports.';

COMMIT;
