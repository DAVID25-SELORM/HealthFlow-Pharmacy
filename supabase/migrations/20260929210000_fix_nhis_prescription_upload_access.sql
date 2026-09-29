-- Match NHIS claim creation access, including delegated and multi-role staff.
-- Preserve the existing branch-manager access and organization folder boundary.
-- Read and delete policies are unchanged.
alter policy nhis_prescriptions_insert on storage.objects
with check (
  bucket_id = 'nhis-prescriptions'
  and (storage.foldername(name))[1] = public.user_organization_id()::text
  and exists (
    select 1 from public.users
    where id = auth.uid()
      and (
        role in ('admin', 'pharmacist', 'assistant', 'billing', 'branch_manager', 'claims_officer', 'records_officer')
        or assigned_roles && array['admin', 'pharmacist', 'assistant', 'billing', 'branch_manager', 'claims_officer', 'records_officer']::text[]
        or can_manage_claims
      )
  )
);

alter policy nhis_prescriptions_update on storage.objects
with check (
  bucket_id = 'nhis-prescriptions'
  and (storage.foldername(name))[1] = public.user_organization_id()::text
  and exists (
    select 1 from public.users
    where id = auth.uid()
      and (
        role in ('admin', 'pharmacist', 'assistant', 'billing', 'branch_manager', 'claims_officer', 'records_officer')
        or assigned_roles && array['admin', 'pharmacist', 'assistant', 'billing', 'branch_manager', 'claims_officer', 'records_officer']::text[]
        or can_manage_claims
      )
  )
);
