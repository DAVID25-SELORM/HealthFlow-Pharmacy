-- ================================================================
-- PATCH: Add organization-level module privileges
-- ================================================================
-- Date: 2026-05-07
-- Purpose:
--   Let super admins unlock Purchases and NHIS per pharmacy tenant.
--   Both modules are locked by default until explicitly allowed.
-- ================================================================

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS can_use_purchases BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_use_nhis      BOOLEAN NOT NULL DEFAULT false;

COMMIT;
