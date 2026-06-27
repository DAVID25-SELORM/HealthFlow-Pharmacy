-- ================================================================
-- PATCH: NHIS Clinical Diagnosis/Treatment Rules
-- ================================================================
-- Purpose:
--   Adds configurable hospital-only rules used before final NHIA
--   submission/export to reduce claim rejections caused by diagnosis
--   and treatment mismatches.
-- ================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.nhis_clinical_rules (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id       UUID        NOT NULL DEFAULT public.user_organization_id()
                                    REFERENCES public.organizations(id) ON DELETE CASCADE,
  diagnosis_label       TEXT        NOT NULL,
  diagnosis_keywords    TEXT[]      NOT NULL DEFAULT '{}',
  allowed_drug_codes    TEXT[]      NOT NULL DEFAULT '{}',
  allowed_drug_keywords TEXT[]      NOT NULL DEFAULT '{}',
  severity              TEXT        NOT NULL DEFAULT 'block'
                                    CHECK (severity IN ('block', 'warn')),
  organization_type     TEXT        NOT NULL DEFAULT 'hospital'
                                    CHECK (organization_type IN ('hospital', 'pharmacy', 'all')),
  notes                 TEXT,
  is_active             BOOLEAN     NOT NULL DEFAULT true,
  created_by            UUID        REFERENCES public.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.nhis_clinical_rules
  ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

DROP INDEX IF EXISTS public.idx_nhis_clinical_rules_org_label;
CREATE UNIQUE INDEX idx_nhis_clinical_rules_org_label
  ON public.nhis_clinical_rules(organization_id, diagnosis_label);

CREATE INDEX IF NOT EXISTS idx_nhis_clinical_rules_org_active
  ON public.nhis_clinical_rules(organization_id, is_active, organization_type);

ALTER TABLE public.nhis_clinical_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nhis_clinical_rules_select ON public.nhis_clinical_rules;
CREATE POLICY nhis_clinical_rules_select ON public.nhis_clinical_rules
  FOR SELECT TO authenticated
  USING (organization_id = public.user_organization_id());

DROP POLICY IF EXISTS nhis_clinical_rules_insert ON public.nhis_clinical_rules;
CREATE POLICY nhis_clinical_rules_insert ON public.nhis_clinical_rules
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'billing', 'branch_manager')
    )
  );

DROP POLICY IF EXISTS nhis_clinical_rules_update ON public.nhis_clinical_rules;
CREATE POLICY nhis_clinical_rules_update ON public.nhis_clinical_rules
  FOR UPDATE TO authenticated
  USING (organization_id = public.user_organization_id())
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'billing', 'branch_manager')
    )
  );

DROP POLICY IF EXISTS nhis_clinical_rules_delete ON public.nhis_clinical_rules;
CREATE POLICY nhis_clinical_rules_delete ON public.nhis_clinical_rules
  FOR DELETE TO authenticated
  USING (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist')
    )
  );

CREATE OR REPLACE FUNCTION public.set_nhis_clinical_rule_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_nhis_clinical_rule_updated_at_trigger ON public.nhis_clinical_rules;
CREATE TRIGGER set_nhis_clinical_rule_updated_at_trigger
  BEFORE UPDATE ON public.nhis_clinical_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.set_nhis_clinical_rule_updated_at();

COMMIT;
