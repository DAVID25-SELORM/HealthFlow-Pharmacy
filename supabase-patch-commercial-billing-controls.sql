-- ================================================================
-- PATCH: Add commercial billing and module controls
-- ================================================================
-- Date: 2026-05-07
-- Purpose:
--   Add manual SaaS billing metadata and module flags that super
--   admins can manage per pharmacy tenant.
-- ================================================================

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS plan_code              TEXT NOT NULL DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS billing_status         TEXT NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS support_level          TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS can_use_claims         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_use_accounting     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_use_multi_branch   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_use_nhis_topups    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_notes          TEXT,
  ADD COLUMN IF NOT EXISTS last_payment_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_payment_due_at    TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organizations_plan_code_check'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_plan_code_check
      CHECK (plan_code IN ('starter', 'professional', 'premium'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organizations_billing_status_check'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_billing_status_check
      CHECK (billing_status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organizations_support_level_check'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_support_level_check
      CHECK (support_level IN ('standard', 'priority', 'premium'));
  END IF;
END $$;

COMMIT;
