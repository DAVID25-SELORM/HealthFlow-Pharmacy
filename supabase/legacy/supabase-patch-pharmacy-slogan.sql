-- ================================================================
-- PATCH: Add pharmacy slogan/tagline support
-- ================================================================
-- Date: 2026-05-01
-- Purpose:
--   Lets each pharmacy store a short slogan for dashboard branding,
--   onboarding, settings, and receipts.
-- ================================================================

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS slogan TEXT;

ALTER TABLE public.pharmacy_settings
  ADD COLUMN IF NOT EXISTS slogan TEXT;

UPDATE public.pharmacy_settings ps
SET slogan = org.slogan
FROM public.organizations org
WHERE ps.organization_id = org.id
  AND ps.slogan IS NULL
  AND org.slogan IS NOT NULL;

COMMIT;
