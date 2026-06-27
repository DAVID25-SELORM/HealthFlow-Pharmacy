-- ================================================================
-- PATCH: Add granular privilege columns to users table
-- ================================================================
-- Date: 2026-05-01
-- Purpose:
--   Allow admins to grant assistants (and optionally pharmacists)
--   specific elevated privileges beyond their base role:
--     can_manage_inventory  - access inventory page / add & edit drugs
--     can_view_reports      - access reports page
--     can_manage_claims     - create and manage insurance claims
--   The existing can_refund column is already present.
-- ================================================================

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS can_manage_inventory BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_view_reports     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_manage_claims    BOOLEAN NOT NULL DEFAULT false;

COMMIT;

DO $$
BEGIN
    RAISE NOTICE 'Staff privilege columns patch applied successfully.';
END $$;
