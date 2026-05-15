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
  submitter_id TEXT,
  api_base_url TEXT,
  claim_endpoint_path TEXT NOT NULL DEFAULT '/claims',
  cc_code_endpoint_path TEXT,
  direct_api_enabled BOOLEAN NOT NULL DEFAULT false,
  credential_mode TEXT NOT NULL DEFAULT 'api_key'
    CHECK (credential_mode IN ('api_key', 'bearer_token', 'basic_auth', 'oauth_client')),
  credential_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  nhis_member_digits INTEGER NOT NULL DEFAULT 8,
  ghana_card_digits INTEGER NOT NULL DEFAULT 10,
  export_format TEXT NOT NULL DEFAULT 'json'
    CHECK (export_format IN ('json', 'xml')),
  max_retry_attempts INTEGER NOT NULL DEFAULT 3,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES public.users(id),
  updated_by UUID REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id)
);

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
