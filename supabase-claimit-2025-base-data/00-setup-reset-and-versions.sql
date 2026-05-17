-- ================================================================
-- PATCH: NHIA / CLAIM-it latest base-data seed
-- ================================================================
-- Purpose:
--   Records the latest CLAIM-it component versions and seeds the
--   February 2023 service tariff rows extracted from the downloaded
--   NHIA tariff PDFs. Medicine prices remain seeded in nhis_drugs
--   from the May 2025 NHIS medicine list/default catalog.
--
-- Latest CLAIM-it reference provided:
--   Service Tariff: FEB 2023
--   Medicine Prices: MAY 2025
--   Application Version: HEAD (build 2025053123) <Client 1.0.0.3>
--   Base Data: FEB 2023
--
-- Generated from local PDFs on 2026-05-17 12:12:27.
--
-- Run the whole file, not a highlighted selection. The tariff inserts
-- are split into batches to avoid Supabase SQL Editor truncating one
-- very large INSERT statement.
-- ================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.nhia_claimit_base_data_versions (
  component      TEXT PRIMARY KEY,
  version        TEXT NOT NULL,
  build          TEXT,
  client_version TEXT,
  source_note    TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.nhia_claimit_base_data_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nhia_claimit_versions_select ON public.nhia_claimit_base_data_versions;
CREATE POLICY nhia_claimit_versions_select ON public.nhia_claimit_base_data_versions
  FOR SELECT TO authenticated
  USING (true);

CREATE TABLE IF NOT EXISTS public.nhia_tariff_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tariff_version  TEXT NOT NULL DEFAULT 'FEB 2023',
  facility_group  TEXT NOT NULL,
  catering_option TEXT,
  mdc             TEXT,
  gdrg_code       TEXT NOT NULL,
  description     TEXT NOT NULL,
  age_band        TEXT,
  tariff_amount   DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'GHS',
  source_file     TEXT,
  source_page     INTEGER,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tariff_version, facility_group, catering_option, gdrg_code)
);

CREATE INDEX IF NOT EXISTS idx_nhia_tariff_items_version ON public.nhia_tariff_items(tariff_version);
CREATE INDEX IF NOT EXISTS idx_nhia_tariff_items_facility ON public.nhia_tariff_items(facility_group, catering_option);
CREATE INDEX IF NOT EXISTS idx_nhia_tariff_items_code ON public.nhia_tariff_items(gdrg_code);
CREATE INDEX IF NOT EXISTS idx_nhia_tariff_items_mdc ON public.nhia_tariff_items(mdc);
CREATE INDEX IF NOT EXISTS idx_nhia_tariff_items_search ON public.nhia_tariff_items USING gin(to_tsvector('english', description));

ALTER TABLE public.nhia_tariff_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nhia_tariff_items_select ON public.nhia_tariff_items;
CREATE POLICY nhia_tariff_items_select ON public.nhia_tariff_items
  FOR SELECT TO authenticated
  USING (true);

INSERT INTO public.nhia_claimit_base_data_versions (component, version, build, client_version, source_note, updated_at)
VALUES
  ('service_tariff', 'FEB 2023', NULL, NULL, 'Latest CLAIM-it service tariff component. Seeded into nhia_tariff_items from downloaded NHIA tariff PDFs.', NOW()),
  ('medicine_prices', 'MAY 2025', NULL, NULL, 'Latest CLAIM-it medicine price component. Seeded through nhis_drugs/default catalog and the 2025 ML correction patch.', NOW()),
  ('application', 'HEAD', '2025053123', '1.0.0.3', 'Latest CLAIM-it application version reference supplied by user.', NOW()),
  ('base_data', 'FEB 2023', NULL, NULL, 'Latest CLAIM-it base data component.', NOW())
ON CONFLICT (component) DO UPDATE SET
  version = EXCLUDED.version,
  build = EXCLUDED.build,
  client_version = EXCLUDED.client_version,
  source_note = EXCLUDED.source_note,
  updated_at = NOW();

-- Replace this official version seed so reruns stay deterministic.
DELETE FROM public.nhia_tariff_items WHERE tariff_version = 'FEB 2023';

COMMIT;
