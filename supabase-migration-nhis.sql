-- ================================================================
-- MIGRATION: NHIS Drug Catalog & Claims
-- ================================================================
-- Date: 2026-05-06
-- Purpose:
--   Creates nhis_drugs, nhis_claims, and nhis_claim_medicines tables
--   with full multi-tenant RLS.
--   Adds nhis_member_no and nhis_hin fields to the patients table so
--   NHIS member numbers auto-fill on future visits.
-- ================================================================

BEGIN;

-- ----------------------------------------------------------------
-- ADD NHIS FIELDS TO PATIENTS
-- ----------------------------------------------------------------
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS nhis_member_no TEXT,
  ADD COLUMN IF NOT EXISTS nhis_hin       TEXT;

CREATE INDEX IF NOT EXISTS idx_patients_nhis_member ON public.patients(nhis_member_no)
  WHERE nhis_member_no IS NOT NULL;

-- ----------------------------------------------------------------
-- NHIS DRUG CATALOG
-- One shared catalog per organization (org-wide, no qty tracking).
-- Drugs are identified by their NHIA code (unique per org).
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.nhis_drugs (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID          NOT NULL DEFAULT public.user_organization_id()
                                REFERENCES public.organizations(id) ON DELETE CASCADE,
  code            TEXT          NOT NULL,
  description     TEXT          NOT NULL,
  generic_name    TEXT,
  strength        TEXT,
  dosage_form     TEXT,
  category        TEXT,
  unit            TEXT          NOT NULL DEFAULT 'unit',
  unit_price      DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_active       BOOLEAN       NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

ALTER TABLE public.nhis_drugs
  ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

CREATE INDEX IF NOT EXISTS idx_nhis_drugs_org  ON public.nhis_drugs(organization_id);
CREATE INDEX IF NOT EXISTS idx_nhis_drugs_code ON public.nhis_drugs(organization_id, code);
CREATE INDEX IF NOT EXISTS idx_nhis_drugs_desc ON public.nhis_drugs USING gin(to_tsvector('english', description));

ALTER TABLE public.nhis_drugs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nhis_drugs_select ON public.nhis_drugs;
CREATE POLICY nhis_drugs_select ON public.nhis_drugs
  FOR SELECT TO authenticated
  USING (organization_id = public.user_organization_id());

DROP POLICY IF EXISTS nhis_drugs_insert ON public.nhis_drugs;
CREATE POLICY nhis_drugs_insert ON public.nhis_drugs
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'billing', 'branch_manager')
    )
  );

DROP POLICY IF EXISTS nhis_drugs_update ON public.nhis_drugs;
CREATE POLICY nhis_drugs_update ON public.nhis_drugs
  FOR UPDATE TO authenticated
  USING  (organization_id = public.user_organization_id())
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'billing', 'branch_manager')
    )
  );

DROP POLICY IF EXISTS nhis_drugs_delete ON public.nhis_drugs;
CREATE POLICY nhis_drugs_delete ON public.nhis_drugs
  FOR DELETE TO authenticated
  USING (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist')
    )
  );

-- ----------------------------------------------------------------
-- NHIS CLAIMS
-- ----------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.nhis_claim_number_seq START 1;

CREATE TABLE IF NOT EXISTS public.nhis_claims (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id     UUID          NOT NULL DEFAULT public.user_organization_id()
                                      REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id           UUID          REFERENCES public.branches(id),
  claim_number        TEXT          NOT NULL DEFAULT
                                      ('NHIS-' || LPAD(NEXTVAL('public.nhis_claim_number_seq')::TEXT, 6, '0')),
  -- Linked patient (optional — can serve without existing patient record)
  patient_id          UUID          REFERENCES public.patients(id),
  -- NHIA member details
  member_no           TEXT,
  hin                 TEXT,
  surname             TEXT          NOT NULL,
  other_names         TEXT,
  folder_no           TEXT,
  gender              TEXT          CHECK (gender IN ('male', 'female', 'other', NULL)),
  date_of_birth       DATE,
  ccc_no              TEXT,
  -- Service dates
  service_date_from   DATE,
  service_date_to     DATE,
  -- Referral
  referring_facility  TEXT,
  referral_code       TEXT,
  -- Authorization
  physician_name      TEXT,
  pre_auth_codes      TEXT,
  -- Totals and workflow status
  total_amount        DECIMAL(12,2) NOT NULL DEFAULT 0,
  status              TEXT          NOT NULL DEFAULT 'served'
                                    CHECK (status IN ('served', 'submitted', 'paid', 'rejected')),
  rejection_reason    TEXT,
  -- Used for monthly batch exports (YYYY-MM). Maintained by trigger below.
  submission_month    TEXT,
  notes               TEXT,
  created_by          UUID          REFERENCES public.users(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE public.nhis_claims
  ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

CREATE OR REPLACE FUNCTION public.set_nhis_claim_submission_month()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.submission_month := SUBSTRING(COALESCE(NEW.service_date_from, CURRENT_DATE)::TEXT FROM 1 FOR 7);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_nhis_claim_submission_month_trigger ON public.nhis_claims;
CREATE TRIGGER set_nhis_claim_submission_month_trigger
  BEFORE INSERT OR UPDATE OF service_date_from
  ON public.nhis_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.set_nhis_claim_submission_month();

UPDATE public.nhis_claims
SET submission_month = SUBSTRING(COALESCE(service_date_from, created_at::DATE, CURRENT_DATE)::TEXT FROM 1 FOR 7)
WHERE submission_month IS NULL;

CREATE INDEX IF NOT EXISTS idx_nhis_claims_org     ON public.nhis_claims(organization_id);
CREATE INDEX IF NOT EXISTS idx_nhis_claims_patient ON public.nhis_claims(patient_id);
CREATE INDEX IF NOT EXISTS idx_nhis_claims_status  ON public.nhis_claims(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_nhis_claims_month   ON public.nhis_claims(organization_id, submission_month);
CREATE INDEX IF NOT EXISTS idx_nhis_claims_member  ON public.nhis_claims(organization_id, member_no)
  WHERE member_no IS NOT NULL;

ALTER TABLE public.nhis_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nhis_claims_select ON public.nhis_claims;
CREATE POLICY nhis_claims_select ON public.nhis_claims
  FOR SELECT TO authenticated
  USING (organization_id = public.user_organization_id());

DROP POLICY IF EXISTS nhis_claims_insert ON public.nhis_claims;
CREATE POLICY nhis_claims_insert ON public.nhis_claims
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'billing')
    )
  );

DROP POLICY IF EXISTS nhis_claims_update ON public.nhis_claims;
CREATE POLICY nhis_claims_update ON public.nhis_claims
  FOR UPDATE TO authenticated
  USING  (organization_id = public.user_organization_id())
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'billing')
    )
  );

-- ----------------------------------------------------------------
-- NHIS CLAIM MEDICINES
-- One row per medicine dispensed in a claim.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.nhis_claim_medicines (
  id             UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  claim_id       UUID          NOT NULL REFERENCES public.nhis_claims(id) ON DELETE CASCADE,
  nhis_drug_id   UUID          REFERENCES public.nhis_drugs(id),
  drug_code      TEXT,
  description    TEXT          NOT NULL,
  unit           TEXT          DEFAULT 'unit',
  unit_price     DECIMAL(10,2) NOT NULL DEFAULT 0,
  dispensed_qty  DECIMAL(10,2) NOT NULL DEFAULT 1,
  dispensary_date DATE,
  dose           TEXT,
  frequency      TEXT,
  duration       TEXT,
  total_amount   DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nhis_medicines_claim ON public.nhis_claim_medicines(claim_id);
CREATE INDEX IF NOT EXISTS idx_nhis_medicines_drug  ON public.nhis_claim_medicines(nhis_drug_id);

ALTER TABLE public.nhis_claim_medicines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nhis_medicines_select ON public.nhis_claim_medicines;
CREATE POLICY nhis_medicines_select ON public.nhis_claim_medicines
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.nhis_claims c
      WHERE c.id = claim_id
        AND c.organization_id = public.user_organization_id()
    )
  );

DROP POLICY IF EXISTS nhis_medicines_insert ON public.nhis_claim_medicines;
CREATE POLICY nhis_medicines_insert ON public.nhis_claim_medicines
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.nhis_claims c
      WHERE c.id = claim_id
        AND c.organization_id = public.user_organization_id()
    )
  );

DROP POLICY IF EXISTS nhis_medicines_delete ON public.nhis_claim_medicines;
CREATE POLICY nhis_medicines_delete ON public.nhis_claim_medicines
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.nhis_claims c
      WHERE c.id = claim_id
        AND c.organization_id = public.user_organization_id()
    )
  );

COMMIT;
