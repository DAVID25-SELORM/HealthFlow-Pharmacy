-- ================================================================
-- PATCH: NHIS claims officer review permissions
-- ================================================================
-- Purpose:
--   Allows claims officers to review, correct, and submit NHIS claims
--   that are auto-created from POS NHIA sales before pushing to CLAIM-it.
-- ================================================================

BEGIN;

DROP POLICY IF EXISTS nhis_claims_insert ON public.nhis_claims;
CREATE POLICY nhis_claims_insert ON public.nhis_claims
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'billing', 'claims_officer')
    )
  );

DROP POLICY IF EXISTS nhis_claims_update ON public.nhis_claims;
CREATE POLICY nhis_claims_update ON public.nhis_claims
  FOR UPDATE TO authenticated
  USING (organization_id = public.user_organization_id())
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'billing', 'claims_officer')
    )
  );

COMMIT;
