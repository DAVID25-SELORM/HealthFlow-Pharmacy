-- Query-only optimization for common production list pages.
-- These indexes support inventory, patient workspace, and report list queries
-- without changing CCC, pricing, tariff, export, submission, duplicate, or NHIS logic.

create index if not exists idx_drugs_org_status_name_id
  on public.drugs (organization_id, status, name, id);

create index if not exists idx_drugs_org_branch_status_name_id
  on public.drugs (organization_id, branch_id, status, name, id);

create index if not exists idx_patients_org_created_at_desc
  on public.patients (organization_id, created_at desc);

