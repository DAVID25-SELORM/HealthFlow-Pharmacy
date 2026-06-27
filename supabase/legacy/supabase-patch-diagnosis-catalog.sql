-- ================================================================
-- PATCH: Diagnosis Catalog and Structured Claim Diagnoses
-- ================================================================
-- Purpose:
--   Stores ICD-10 / Ghana STG diagnosis options in Supabase instead
--   of relying only on the bundled app catalog, and preserves selected
--   claim diagnoses as structured code/label/source JSON.
-- ================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.diagnosis_catalog (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  source         TEXT        NOT NULL
                             CHECK (source IN ('ICD-10', 'Ghana STG 2017', 'Custom')),
  code           TEXT        NOT NULL,
  label          TEXT        NOT NULL,
  source_version TEXT,
  search_text    TEXT        GENERATED ALWAYS AS (
                               lower(
                                 coalesce(code, '') || ' ' ||
                                 coalesce(label, '') || ' ' ||
                                 coalesce(source, '') || ' ' ||
                                 coalesce(source_version, '')
                               )
                             ) STORED,
  search_compact TEXT        GENERATED ALWAYS AS (
                               regexp_replace(
                                 lower(
                                   coalesce(code, '') || ' ' ||
                                   coalesce(label, '') || ' ' ||
                                   coalesce(source, '') || ' ' ||
                                   coalesce(source_version, '')
                                 ),
                                 '[^a-z0-9]+',
                                 '',
                                 'g'
                               )
                             ) STORED,
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.diagnosis_catalog
  ADD COLUMN IF NOT EXISTS search_compact TEXT GENERATED ALWAYS AS (
    regexp_replace(
      lower(
        coalesce(code, '') || ' ' ||
        coalesce(label, '') || ' ' ||
        coalesce(source, '') || ' ' ||
        coalesce(source_version, '')
      ),
      '[^a-z0-9]+',
      '',
      'g'
    )
  ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_diagnosis_catalog_source_code_label
  ON public.diagnosis_catalog(source, code, label);

CREATE INDEX IF NOT EXISTS idx_diagnosis_catalog_source_active
  ON public.diagnosis_catalog(source, is_active, code);

CREATE INDEX IF NOT EXISTS idx_diagnosis_catalog_search_text
  ON public.diagnosis_catalog USING gin (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_diagnosis_catalog_search_compact
  ON public.diagnosis_catalog USING gin (search_compact gin_trgm_ops);

ALTER TABLE public.diagnosis_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS diagnosis_catalog_select ON public.diagnosis_catalog;
CREATE POLICY diagnosis_catalog_select ON public.diagnosis_catalog
  FOR SELECT TO authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS diagnosis_catalog_insert ON public.diagnosis_catalog;
CREATE POLICY diagnosis_catalog_insert ON public.diagnosis_catalog
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS diagnosis_catalog_update ON public.diagnosis_catalog;
CREATE POLICY diagnosis_catalog_update ON public.diagnosis_catalog
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'super_admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS diagnosis_catalog_delete ON public.diagnosis_catalog;
CREATE POLICY diagnosis_catalog_delete ON public.diagnosis_catalog
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'super_admin')
    )
  );

CREATE OR REPLACE FUNCTION public.set_diagnosis_catalog_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_diagnosis_catalog_updated_at_trigger ON public.diagnosis_catalog;
CREATE TRIGGER set_diagnosis_catalog_updated_at_trigger
  BEFORE UPDATE ON public.diagnosis_catalog
  FOR EACH ROW
  EXECUTE FUNCTION public.set_diagnosis_catalog_updated_at();

ALTER TABLE public.nhis_claims
  ADD COLUMN IF NOT EXISTS diagnosis_details JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'nhis_claims_diagnosis_details_array'
  ) THEN
    ALTER TABLE public.nhis_claims
      ADD CONSTRAINT nhis_claims_diagnosis_details_array
      CHECK (jsonb_typeof(diagnosis_details) = 'array');
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_nhis_claims_diagnosis_details
  ON public.nhis_claims USING gin (diagnosis_details);

COMMIT;
