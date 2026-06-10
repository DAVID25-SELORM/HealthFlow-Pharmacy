alter table if exists public.nhia_configuration
  add column if not exists hpn text,
  add column if not exists hp_code text;

alter table if exists public.nhis_claims
  add column if not exists card_type text,
  add column if not exists nhia_auth_id text,
  add column if not exists nhia_auth_type text,
  add column if not exists nhia_new_ccc_status text,
  add column if not exists nhia_otac text,
  add column if not exists nhia_attendance_verification_status text,
  add column if not exists nhia_attendance_verification_source text;

create index if not exists idx_nhis_claims_nhia_auth_id
  on public.nhis_claims (nhia_auth_id)
  where nhia_auth_id is not null;

create index if not exists idx_nhis_claims_card_type
  on public.nhis_claims (card_type)
  where card_type is not null;
