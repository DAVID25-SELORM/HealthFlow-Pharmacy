-- ================================================================
-- PATCH: NHIS claims RLS for claims officers
-- ================================================================
-- Purpose:
--   Aligns Supabase write policies with the app's NHIS roles so
--   claims officers can create and edit served NHIS claims.
-- ================================================================

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS can_manage_claims BOOLEAN NOT NULL DEFAULT false;

DROP POLICY IF EXISTS nhis_claims_insert ON public.nhis_claims;
CREATE POLICY nhis_claims_insert ON public.nhis_claims
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND (
          role IN ('admin', 'pharmacist', 'billing', 'claims_officer')
          OR can_manage_claims = true
        )
    )
  );

DROP POLICY IF EXISTS nhis_claims_update ON public.nhis_claims;
CREATE POLICY nhis_claims_update ON public.nhis_claims
  FOR UPDATE TO authenticated
  USING (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND (
          role IN ('admin', 'pharmacist', 'billing', 'claims_officer')
          OR can_manage_claims = true
        )
    )
  )
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND (
          role IN ('admin', 'pharmacist', 'billing', 'claims_officer')
          OR can_manage_claims = true
        )
    )
  );

COMMIT;
