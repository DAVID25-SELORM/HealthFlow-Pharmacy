-- ================================================
-- PATCH: Pharmacy logo support for receipts
-- Date: 2026-04-27
-- ================================================

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

ALTER TABLE public.pharmacy_settings
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

UPDATE public.pharmacy_settings ps
SET logo_url = o.logo_url
FROM public.organizations o
WHERE ps.organization_id = o.id
  AND ps.logo_url IS NULL
  AND o.logo_url IS NOT NULL;

COMMIT;
