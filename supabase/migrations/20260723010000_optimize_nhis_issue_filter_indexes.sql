-- Query-only optimization for NHIS issue badges and issue-filtered claim lists.
-- These indexes support missing/invalid/unverified prescription metadata checks
-- without changing CCC, pricing, tariff, export, submission, duplicate, or scrub logic.

create index if not exists idx_nhis_claims_issue_missing_prescription
  on public.nhis_claims (organization_id, status, service_date_from, created_at desc)
  where prescription_file_url is null
    and prescription_file_path is null
    and prescription_file_name is null
    and claimit_attachment_base64 is null;

create index if not exists idx_nhis_claims_issue_prescription_metadata
  on public.nhis_claims (
    organization_id,
    status,
    prescription_document_type,
    prescription_verified,
    service_date_from,
    created_at desc
  )
  where prescription_file_url is not null
     or prescription_file_path is not null
     or prescription_file_name is not null
     or claimit_attachment_base64 is not null;

create index if not exists idx_nhis_claims_issue_intake_status
  on public.nhis_claims (organization_id, status, service_date_from, created_at desc)
  where status in ('pending_serving', 'serving_in_progress', 'returned_for_review');
