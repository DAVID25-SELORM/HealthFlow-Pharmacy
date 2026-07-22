-- Additive hospital encounter documentation for claim scrubbing.
-- These nullable fields explain legitimate no-medicine/lab/procedure pathways
-- without changing CCC, pricing, tariff, export, submission, or duplicate logic.

alter table if exists public.nhis_claims
  add column if not exists encounter_outcome text,
  add column if not exists no_medicine_reason text,
  add column if not exists no_lab_reason text,
  add column if not exists no_procedure_reason text,
  add column if not exists external_prescription_status text;

comment on column public.nhis_claims.encounter_outcome is
  'Optional hospital encounter outcome used by claim scrubbing to explain valid pathways such as advice only, referral, admission, awaiting lab result, or external prescription.';

comment on column public.nhis_claims.no_medicine_reason is
  'Optional hospital reason explaining why no internal medicine was dispensed.';

comment on column public.nhis_claims.no_lab_reason is
  'Optional hospital reason explaining why no laboratory test was ordered/performed.';

comment on column public.nhis_claims.no_procedure_reason is
  'Optional hospital reason explaining why no procedure was performed.';

comment on column public.nhis_claims.external_prescription_status is
  'Optional hospital note/status when medicine was prescribed for external collection instead of internal dispensing.';
