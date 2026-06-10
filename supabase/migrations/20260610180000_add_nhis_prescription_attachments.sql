alter table if exists public.nhis_claims
  add column if not exists prescription_file_url text,
  add column if not exists prescription_file_path text,
  add column if not exists prescription_file_name text,
  add column if not exists prescription_file_type text,
  add column if not exists prescription_file_size integer,
  add column if not exists claimit_attachment_file_name text,
  add column if not exists claimit_attachment_file_type text,
  add column if not exists claimit_attachment_mime_type text,
  add column if not exists claimit_attachment_base64 text;

create index if not exists idx_nhis_claims_prescription_file
  on public.nhis_claims (organization_id, prescription_file_path)
  where prescription_file_path is not null;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'nhis-prescriptions',
  'nhis-prescriptions',
  false,
  3145728,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = 3145728,
  allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png'];

drop policy if exists nhis_prescriptions_select on storage.objects;
create policy nhis_prescriptions_select
on storage.objects
for select to authenticated
using (
  bucket_id = 'nhis-prescriptions'
  and (storage.foldername(name))[1] = public.user_organization_id()::text
);

drop policy if exists nhis_prescriptions_insert on storage.objects;
create policy nhis_prescriptions_insert
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'nhis-prescriptions'
  and (storage.foldername(name))[1] = public.user_organization_id()::text
  and exists (
    select 1
    from public.users
    where id = auth.uid()
      and role in ('admin', 'pharmacist', 'billing', 'branch_manager', 'claims_officer')
  )
);

drop policy if exists nhis_prescriptions_update on storage.objects;
create policy nhis_prescriptions_update
on storage.objects
for update to authenticated
using (
  bucket_id = 'nhis-prescriptions'
  and (storage.foldername(name))[1] = public.user_organization_id()::text
)
with check (
  bucket_id = 'nhis-prescriptions'
  and (storage.foldername(name))[1] = public.user_organization_id()::text
  and exists (
    select 1
    from public.users
    where id = auth.uid()
      and role in ('admin', 'pharmacist', 'billing', 'branch_manager', 'claims_officer')
  )
);

drop policy if exists nhis_prescriptions_delete on storage.objects;
create policy nhis_prescriptions_delete
on storage.objects
for delete to authenticated
using (
  bucket_id = 'nhis-prescriptions'
  and (storage.foldername(name))[1] = public.user_organization_id()::text
  and exists (
    select 1
    from public.users
    where id = auth.uid()
      and role in ('admin', 'pharmacist', 'billing', 'branch_manager', 'claims_officer')
  )
);
