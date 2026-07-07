-- Match the hosted export request shape used by PostgREST when RLS predicates
-- are not visible in the browser URL.

create index if not exists idx_nhis_claims_status_submission_month_created_at
  on public.nhis_claims (status, submission_month, created_at);

create index if not exists idx_nhis_claims_status_service_date_created_at
  on public.nhis_claims (status, service_date_from, created_at);
