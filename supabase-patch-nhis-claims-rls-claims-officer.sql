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

-- ================================================================
-- NHIA API config persistence and write policy
-- ================================================================
-- Correct NHIA config table:
--   public.organization_nhia_integrations
-- Canonical credential storage:
--   credential_payload JSONB, with masked has_api_key / has_api_secret
--   flags for the client. Blank API key/secret saves must preserve
--   existing credential_payload values in the Edge Function.

ALTER TABLE public.organization_nhia_integrations
  ADD COLUMN IF NOT EXISTS nhia_api_mode TEXT,
  ADD COLUMN IF NOT EXISTS claim_submit_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS claim_status_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS member_lookup_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS api_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS has_api_key BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_api_secret BOOLEAN NOT NULL DEFAULT false;

UPDATE public.organization_nhia_integrations
SET
  nhia_api_mode = COALESCE(NULLIF(nhia_api_mode, ''), integration_mode, 'claimit_export'),
  claim_submit_endpoint = COALESCE(NULLIF(claim_submit_endpoint, ''), claim_endpoint_path),
  claim_status_endpoint = COALESCE(NULLIF(claim_status_endpoint, ''), claim_status_endpoint_path),
  member_lookup_endpoint = COALESCE(NULLIF(member_lookup_endpoint, ''), member_lookup_endpoint_path),
  has_api_key = COALESCE(has_api_key, false)
    OR COALESCE(credential_payload, '{}'::jsonb) ? 'apiKey'
    OR NULLIF(api_key_encrypted, '') IS NOT NULL,
  has_api_secret = COALESCE(has_api_secret, false)
    OR COALESCE(credential_payload, '{}'::jsonb) ? 'apiSecret'
    OR NULLIF(api_secret_encrypted, '') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_organization_nhia_integrations_aliases()
RETURNS TRIGGER AS $$
DECLARE
  credentials JSONB := COALESCE(NEW.credential_payload, '{}'::jsonb);
BEGIN
  NEW.integration_mode := COALESCE(NULLIF(NEW.integration_mode, ''), NULLIF(NEW.nhia_api_mode, ''), 'claimit_export');
  NEW.nhia_api_mode := COALESCE(NULLIF(NEW.nhia_api_mode, ''), NEW.integration_mode);

  NEW.claim_endpoint_path := COALESCE(NULLIF(NEW.claim_endpoint_path, ''), NULLIF(NEW.claim_submit_endpoint, ''));
  NEW.claim_submit_endpoint := COALESCE(NULLIF(NEW.claim_submit_endpoint, ''), NEW.claim_endpoint_path);

  NEW.claim_status_endpoint_path := COALESCE(NULLIF(NEW.claim_status_endpoint_path, ''), NULLIF(NEW.claim_status_endpoint, ''));
  NEW.claim_status_endpoint := COALESCE(NULLIF(NEW.claim_status_endpoint, ''), NEW.claim_status_endpoint_path);

  NEW.member_lookup_endpoint_path := COALESCE(NULLIF(NEW.member_lookup_endpoint_path, ''), NULLIF(NEW.member_lookup_endpoint, ''));
  NEW.member_lookup_endpoint := COALESCE(NULLIF(NEW.member_lookup_endpoint, ''), NEW.member_lookup_endpoint_path);

  NEW.has_api_key := COALESCE(NEW.has_api_key, false)
    OR credentials ? 'apiKey'
    OR NULLIF(NEW.api_key_encrypted, '') IS NOT NULL;
  NEW.has_api_secret := COALESCE(NEW.has_api_secret, false)
    OR credentials ? 'apiSecret'
    OR NULLIF(NEW.api_secret_encrypted, '') IS NOT NULL;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_organization_nhia_integrations_aliases
  ON public.organization_nhia_integrations;
CREATE TRIGGER trg_sync_organization_nhia_integrations_aliases
  BEFORE INSERT OR UPDATE ON public.organization_nhia_integrations
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_organization_nhia_integrations_aliases();

ALTER TABLE public.organization_nhia_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_nhia_integrations_insert ON public.organization_nhia_integrations;
CREATE POLICY organization_nhia_integrations_insert ON public.organization_nhia_integrations
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND (
          role IN ('admin', 'pharmacist', 'branch_manager', 'claims_officer')
          OR can_manage_claims = true
        )
    )
  );

DROP POLICY IF EXISTS organization_nhia_integrations_update ON public.organization_nhia_integrations;
CREATE POLICY organization_nhia_integrations_update ON public.organization_nhia_integrations
  FOR UPDATE TO authenticated
  USING (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND (
          role IN ('admin', 'pharmacist', 'branch_manager', 'claims_officer')
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
          role IN ('admin', 'pharmacist', 'branch_manager', 'claims_officer')
          OR can_manage_claims = true
        )
    )
  );

COMMIT;
