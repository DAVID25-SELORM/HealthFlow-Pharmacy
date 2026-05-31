alter table if exists public.nhis_claims
  add column if not exists nhia_transaction_id text,
  add column if not exists nhia_eligibility_start_date date,
  add column if not exists nhia_eligibility_end_date date,
  add column if not exists nhia_attendance_date date,
  add column if not exists nhia_member_status text,
  add column if not exists nhia_member_lookup_payload jsonb;

create index if not exists idx_nhis_claims_nhia_transaction_id
  on public.nhis_claims (nhia_transaction_id)
  where nhia_transaction_id is not null;
