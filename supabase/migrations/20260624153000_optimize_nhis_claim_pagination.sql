-- Indexes for paginated NHIS claim browsing and filtering.
-- Supports organization-scoped RLS queries ordered by created_at, status tabs,
-- service date filters, submission month filters, and claim/member searches.

create index if not exists idx_nhis_claims_org_created_at_desc
  on public.nhis_claims (organization_id, created_at desc);

create index if not exists idx_nhis_claims_org_status_created_at_desc
  on public.nhis_claims (organization_id, status, created_at desc);

create index if not exists idx_nhis_claims_org_service_date_created_at_desc
  on public.nhis_claims (organization_id, service_date_from, created_at desc);

create index if not exists idx_nhis_claims_org_submission_month_created_at_desc
  on public.nhis_claims (organization_id, submission_month, created_at desc);

create index if not exists idx_nhis_claims_org_claim_number
  on public.nhis_claims (organization_id, claim_number);

create index if not exists idx_nhis_claims_org_member_no
  on public.nhis_claims (organization_id, member_no);

create index if not exists idx_nhis_claims_org_hin
  on public.nhis_claims (organization_id, hin);

create extension if not exists pg_trgm;

create index if not exists idx_nhis_claims_claim_number_trgm
  on public.nhis_claims using gin (claim_number gin_trgm_ops);

create index if not exists idx_nhis_claims_member_no_trgm
  on public.nhis_claims using gin (member_no gin_trgm_ops);

create index if not exists idx_nhis_claims_hin_trgm
  on public.nhis_claims using gin (hin gin_trgm_ops);

create index if not exists idx_nhis_claims_surname_trgm
  on public.nhis_claims using gin (surname gin_trgm_ops);

create index if not exists idx_nhis_claims_other_names_trgm
  on public.nhis_claims using gin (other_names gin_trgm_ops);

create or replace function public.get_nhis_claim_stats()
returns table (
  total bigint,
  pending_serving bigint,
  returned_for_review bigint,
  served bigint,
  submitted bigint,
  paid bigint,
  rejected bigint,
  total_paid numeric
)
language sql
stable
as $$
  select
    count(*)::bigint as total,
    count(*) filter (where status = 'pending_serving')::bigint as pending_serving,
    count(*) filter (where status = 'returned_for_review')::bigint as returned_for_review,
    count(*) filter (where status = 'served')::bigint as served,
    count(*) filter (where status = 'submitted')::bigint as submitted,
    count(*) filter (where status = 'paid')::bigint as paid,
    count(*) filter (where status = 'rejected')::bigint as rejected,
    coalesce(sum(total_amount) filter (where status = 'paid'), 0)::numeric as total_paid
  from public.nhis_claims;
$$;
