-- Adds NHIA rejection-prevention fields used by the NHIS claim checklist.
-- Run in Supabase SQL Editor before saving new NHIS claims from the updated app.

BEGIN;

ALTER TABLE public.nhis_claims
  ADD COLUMN IF NOT EXISTS patient_address TEXT,
  ADD COLUMN IF NOT EXISTS child_weight_kg DECIMAL(6,2),
  ADD COLUMN IF NOT EXISTS diagnosis TEXT;

CREATE INDEX IF NOT EXISTS idx_nhis_claims_diagnosis
  ON public.nhis_claims(organization_id, diagnosis)
  WHERE diagnosis IS NOT NULL;

COMMIT;
