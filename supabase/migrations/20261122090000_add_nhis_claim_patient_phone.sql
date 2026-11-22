-- NHIS patients are mostly known only through their claims (almost none have a
-- separate patients row), so the telephone number entered while serving is kept
-- on the claim and carried forward to that patient's next claim.
-- Additive and nullable: nothing existing reads or writes this column.

alter table public.nhis_claims
  add column if not exists patient_phone text;

comment on column public.nhis_claims.patient_phone is
  'Patient telephone number entered on the NHIS serving form (optional).';

notify pgrst, 'reload schema';
