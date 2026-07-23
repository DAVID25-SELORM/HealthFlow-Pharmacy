-- Additive NHIS prescription traceability.
-- This records who entered or last changed prescription-source details without
-- changing CCC, pricing, tariff, export, submission, or duplicate logic.

alter table if exists public.nhis_claims
  add column if not exists prescription_entered_by uuid references public.users(id) on delete set null,
  add column if not exists prescription_entered_at timestamptz,
  add column if not exists prescription_updated_by uuid references public.users(id) on delete set null,
  add column if not exists prescription_updated_at timestamptz,
  add column if not exists prescription_entry_user_name text,
  add column if not exists prescription_update_user_name text;

create index if not exists idx_nhis_claims_prescription_reference
  on public.nhis_claims (organization_id, prescription_reference)
  where prescription_reference is not null;

create index if not exists idx_nhis_claims_prescription_entered_by
  on public.nhis_claims (organization_id, prescription_entered_by, prescription_entered_at desc)
  where prescription_entered_by is not null;

comment on column public.nhis_claims.prescription_entered_by is
  'Staff user who first entered prescription-source details for this NHIS claim.';
comment on column public.nhis_claims.prescription_entered_at is
  'Time prescription-source details were first entered for this NHIS claim.';
comment on column public.nhis_claims.prescription_updated_by is
  'Staff user who last updated prescription-source details for this NHIS claim.';
comment on column public.nhis_claims.prescription_updated_at is
  'Time prescription-source details were last updated for this NHIS claim.';
comment on column public.nhis_claims.prescription_entry_user_name is
  'Display name or email snapshot for the staff user who first entered prescription-source details.';
comment on column public.nhis_claims.prescription_update_user_name is
  'Display name or email snapshot for the staff user who last updated prescription-source details.';
