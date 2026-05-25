-- ================================================================
-- PATCH: NHIA API integrations and CCC/CC generation settings
-- ================================================================
-- Purpose:
--   Lets each pharmacy or hospital store NHIA API configuration for
--   direct claim submission and CCC/CC code generation.
--   Credentials are only readable by service-role backend functions.
-- ================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.organization_nhia_integrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  facility_code TEXT,
  provider_number TEXT,
  scheme_name TEXT NOT NULL DEFAULT 'National Health Insurance',
  provider_type_description TEXT,
  provider_class_level TEXT,
  claims_officer_name TEXT,
  admission_payment_option TEXT NOT NULL DEFAULT 'nhis_pays_admission'
    CHECK (admission_payment_option IN ('nhis_pays_admission', 'patient_pays_admission', 'not_applicable')),
  claimit_validation_enabled BOOLEAN NOT NULL DEFAULT true,
  claims_officer_signature_url TEXT,
  submitter_id TEXT,
  api_environment TEXT NOT NULL DEFAULT 'production'
    CHECK (api_environment IN ('sandbox', 'production')),
  api_base_url TEXT,
  claim_endpoint_path TEXT,
  cc_code_endpoint_path TEXT,
  claim_status_endpoint_path TEXT,
  member_lookup_endpoint_path TEXT,
  claim_validation_endpoint_path TEXT,
  connection_profile TEXT NOT NULL DEFAULT 'local_server'
    CHECK (connection_profile IN ('local_server', 'lan_ip', 'production_server')),
  validation_mode TEXT NOT NULL DEFAULT 'validate_before_submit'
    CHECK (validation_mode IN ('validate_before_submit', 'submit_only')),
  direct_api_enabled BOOLEAN NOT NULL DEFAULT false,
  credential_mode TEXT NOT NULL DEFAULT 'api_key'
    CHECK (credential_mode IN ('api_key', 'bearer_token', 'basic_auth', 'oauth_client', 'claimit_token')),
  credential_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  nhis_member_digits INTEGER NOT NULL DEFAULT 8,
  ghana_card_digits INTEGER NOT NULL DEFAULT 10,
  export_format TEXT NOT NULL DEFAULT 'cxf'
    CHECK (export_format IN ('cxf', 'json', 'xml')),
  max_retry_attempts INTEGER NOT NULL DEFAULT 3,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES public.users(id),
  updated_by UUID REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id)
);

ALTER TABLE public.organization_nhia_integrations
  ADD COLUMN IF NOT EXISTS api_environment TEXT NOT NULL DEFAULT 'production',
  ADD COLUMN IF NOT EXISTS scheme_name TEXT NOT NULL DEFAULT 'National Health Insurance',
  ADD COLUMN IF NOT EXISTS provider_type_description TEXT,
  ADD COLUMN IF NOT EXISTS provider_class_level TEXT,
  ADD COLUMN IF NOT EXISTS claims_officer_name TEXT,
  ADD COLUMN IF NOT EXISTS admission_payment_option TEXT NOT NULL DEFAULT 'nhis_pays_admission',
  ADD COLUMN IF NOT EXISTS claimit_validation_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS claims_officer_signature_url TEXT,
  ADD COLUMN IF NOT EXISTS claim_status_endpoint_path TEXT,
  ADD COLUMN IF NOT EXISTS member_lookup_endpoint_path TEXT,
  ADD COLUMN IF NOT EXISTS claim_validation_endpoint_path TEXT,
  ADD COLUMN IF NOT EXISTS connection_profile TEXT NOT NULL DEFAULT 'local_server',
  ADD COLUMN IF NOT EXISTS validation_mode TEXT NOT NULL DEFAULT 'validate_before_submit',
  ALTER COLUMN export_format SET DEFAULT 'cxf',
  ALTER COLUMN claim_endpoint_path DROP DEFAULT,
  ALTER COLUMN claim_endpoint_path DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organization_nhia_integrations_api_environment_check'
      AND conrelid = 'public.organization_nhia_integrations'::regclass
  ) THEN
    ALTER TABLE public.organization_nhia_integrations
      ADD CONSTRAINT organization_nhia_integrations_api_environment_check
      CHECK (api_environment IN ('sandbox', 'production'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organization_nhia_integrations_credential_mode_check'
      AND conrelid = 'public.organization_nhia_integrations'::regclass
  ) THEN
    ALTER TABLE public.organization_nhia_integrations
      DROP CONSTRAINT organization_nhia_integrations_credential_mode_check;
  END IF;

  ALTER TABLE public.organization_nhia_integrations
    ADD CONSTRAINT organization_nhia_integrations_credential_mode_check
      CHECK (credential_mode IN ('api_key', 'bearer_token', 'basic_auth', 'oauth_client', 'claimit_token', 'custom'));
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organization_nhia_integrations_export_format_check'
      AND conrelid = 'public.organization_nhia_integrations'::regclass
  ) THEN
    ALTER TABLE public.organization_nhia_integrations
      DROP CONSTRAINT organization_nhia_integrations_export_format_check;
  END IF;

  ALTER TABLE public.organization_nhia_integrations
    ADD CONSTRAINT organization_nhia_integrations_export_format_check
    CHECK (export_format IN ('cxf', 'json', 'xml'));

  UPDATE public.organization_nhia_integrations
  SET export_format = 'cxf'
  WHERE export_format IS NULL OR export_format NOT IN ('cxf', 'json', 'xml');
END $$;

CREATE INDEX IF NOT EXISTS idx_organization_nhia_integrations_org
  ON public.organization_nhia_integrations(organization_id)
  WHERE is_active = true;

ALTER TABLE public.organization_nhia_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_nhia_integrations_select ON public.organization_nhia_integrations;
-- No client SELECT policy: credential_payload is intentionally service-role only.
-- Use the tier-access Edge Function to return masked settings to the app.

DROP POLICY IF EXISTS organization_nhia_integrations_insert ON public.organization_nhia_integrations;
-- No client INSERT policy: write through the tier-access Edge Function.

DROP POLICY IF EXISTS organization_nhia_integrations_update ON public.organization_nhia_integrations;
-- No client UPDATE policy: write through the tier-access Edge Function.

COMMIT;
