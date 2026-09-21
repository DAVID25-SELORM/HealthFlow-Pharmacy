-- LOCAL REHEARSAL ONLY: not a production migration or tariff price reset.
-- Schema section recovered from Git commit 6f3ef88eb4bb450a7b2c87f027e9b593f4081014:
-- supabase-claimit-2025-base-data/00-setup-reset-and-versions.sql.
-- The original seed's version writes and DELETE are deliberately excluded.
-- Current tariff prices remain sourced from the tracked 617-row migration.
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
  FOR SELECT TO authenticated USING (true);

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
  FOR SELECT TO authenticated USING (true);
COMMIT;
