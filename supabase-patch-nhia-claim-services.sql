-- ================================================================
-- PATCH: NHIA / CLAIM-it hospital tariff service lines
-- ================================================================
-- Run after supabase-migration-nhis.sql and after the NHIA tariff seed.
-- Adds first-class hospital service/G-DRG lines to NHIS claims while
-- keeping pharmacy medicine claims on nhis_claim_medicines.
-- ================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.nhis_claim_services (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  claim_id            UUID NOT NULL REFERENCES public.nhis_claims(id) ON DELETE CASCADE,
  nhia_tariff_item_id  UUID REFERENCES public.nhia_tariff_items(id),
  tariff_version      TEXT NOT NULL DEFAULT 'FEB 2023',
  facility_group      TEXT,
  catering_option     TEXT,
  mdc                 TEXT,
  gdrg_code           TEXT NOT NULL,
  description         TEXT NOT NULL,
  age_band            TEXT,
  unit_price          DECIMAL(12,2) NOT NULL DEFAULT 0,
  quantity            DECIMAL(10,2) NOT NULL DEFAULT 1,
  service_date        DATE,
  total_amount        DECIMAL(12,2) NOT NULL DEFAULT 0,
  source_file         TEXT,
  source_page         INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nhis_claim_services_claim ON public.nhis_claim_services(claim_id);
CREATE INDEX IF NOT EXISTS idx_nhis_claim_services_tariff ON public.nhis_claim_services(nhia_tariff_item_id);
CREATE INDEX IF NOT EXISTS idx_nhis_claim_services_code ON public.nhis_claim_services(gdrg_code);

ALTER TABLE public.nhis_claim_services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nhis_claim_services_select ON public.nhis_claim_services;
CREATE POLICY nhis_claim_services_select ON public.nhis_claim_services
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.nhis_claims c
      WHERE c.id = claim_id
        AND c.organization_id = public.user_organization_id()
    )
  );

DROP POLICY IF EXISTS nhis_claim_services_insert ON public.nhis_claim_services;
CREATE POLICY nhis_claim_services_insert ON public.nhis_claim_services
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.nhis_claims c
      WHERE c.id = claim_id
        AND c.organization_id = public.user_organization_id()
    )
  );

DROP POLICY IF EXISTS nhis_claim_services_delete ON public.nhis_claim_services;
CREATE POLICY nhis_claim_services_delete ON public.nhis_claim_services
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.nhis_claims c
      WHERE c.id = claim_id
        AND c.organization_id = public.user_organization_id()
    )
  );

COMMIT;
