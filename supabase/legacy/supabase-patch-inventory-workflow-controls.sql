-- ================================================================
-- PATCH: Inventory workflow controls
-- ================================================================
-- Purpose:
--   Make batch numbers optional and add a sale-on-return inventory flag.
-- ================================================================

BEGIN;

ALTER TABLE public.drugs
  ALTER COLUMN batch_number DROP NOT NULL;

ALTER TABLE public.drugs
  ADD COLUMN IF NOT EXISTS sale_on_return BOOLEAN NOT NULL DEFAULT false;

COMMIT;
