-- ================================================
-- PATCH: Add DEFAULT organization_id to accounting tables
-- ================================================
-- Date: April 16, 2026
-- Description: Fixes 403 RLS errors on INSERT by letting the DB
--              auto-populate organization_id from the current user's
--              org context when the client omits it.
-- Run in: Supabase SQL Editor
-- ================================================

ALTER TABLE public.expense_categories
  ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

ALTER TABLE public.expenses
  ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

ALTER TABLE public.cashbook_sessions
  ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

ALTER TABLE public.cashbook_entries
  ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

ALTER TABLE public.claim_payments
  ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

DO $$
BEGIN
  RAISE NOTICE 'Accounting defaults patch applied — organization_id will now auto-populate on INSERT.';
END $$;
