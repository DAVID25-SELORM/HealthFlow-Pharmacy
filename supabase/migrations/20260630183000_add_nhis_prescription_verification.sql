alter table if exists public.nhis_claims
  add column if not exists prescription_document_type text,
  add column if not exists prescription_verified boolean not null default false,
  add column if not exists prescription_verified_by uuid references auth.users(id),
  add column if not exists prescription_verified_at timestamptz;

alter table if exists public.nhis_claims
  drop constraint if exists nhis_claims_prescription_document_type_check;

alter table if exists public.nhis_claims
  add constraint nhis_claims_prescription_document_type_check
  check (
    prescription_document_type is null
    or prescription_document_type in ('prescription', 'receipt', 'lab_report', 'other')
  );

alter table if exists public.nhis_claims
  drop constraint if exists nhis_claims_prescription_verification_check;

alter table if exists public.nhis_claims
  add constraint nhis_claims_prescription_verification_check
  check (
    (
      prescription_verified = true
      and prescription_document_type = 'prescription'
      and prescription_verified_by is not null
      and prescription_verified_at is not null
    )
    or (
      prescription_verified = false
      and prescription_verified_by is null
      and prescription_verified_at is null
    )
  );

comment on column public.nhis_claims.prescription_document_type is
  'Staff-classified document type for the single NHIS claim attachment.';
comment on column public.nhis_claims.prescription_verified is
  'True only after claims staff confirm the attachment is the patient prescription.';
comment on column public.nhis_claims.prescription_verified_by is
  'Authenticated staff member who verified the prescription attachment.';
comment on column public.nhis_claims.prescription_verified_at is
  'Time at which claims staff verified the prescription attachment.';

-- Existing attachments intentionally remain unverified and require staff review.
