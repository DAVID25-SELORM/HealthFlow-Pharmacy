-- Speed up NHIS CLAIM-it exports by supporting the new lightweight parent
-- claim fetch followed by batched child-row hydration.

create index if not exists idx_nhis_claims_org_status_service_date_created_at
  on public.nhis_claims (organization_id, status, service_date_from, created_at);

create index if not exists idx_nhis_claims_org_status_submission_month_created_at
  on public.nhis_claims (organization_id, status, submission_month, created_at);

create index if not exists idx_nhis_claim_medicines_claim_id_created_at
  on public.nhis_claim_medicines (claim_id, created_at);

create index if not exists idx_nhis_claim_services_claim_id_created_at
  on public.nhis_claim_services (claim_id, created_at);
