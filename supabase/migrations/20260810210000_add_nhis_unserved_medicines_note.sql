-- Forward repair: the application and privileged correction RPC use this field,
-- but its original schema patch remained under supabase/legacy and was never
-- promoted into the tracked migration chain.
alter table if exists public.nhis_claims
  add column if not exists unserved_medicines_note text;

comment on column public.nhis_claims.unserved_medicines_note is
  'Optional note explaining medicines that were not served on an NHIS claim.';

notify pgrst, 'reload schema';
