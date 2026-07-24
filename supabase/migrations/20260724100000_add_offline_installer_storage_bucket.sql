-- Private storage for HealthFlow offline installer releases.
-- This only supports installer release publishing/download control; it does not
-- alter installer packaging, first-run setup, branch-token provisioning, sync,
-- NHIS, CCC, pricing, tariffs, claim submission, duplicate checks, or exports.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'healthflow-offline-installers',
  'healthflow-offline-installers',
  false,
  1073741824,
  array[
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = 1073741824,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists healthflow_offline_installers_super_admin_insert
  on storage.objects;
create policy healthflow_offline_installers_super_admin_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'healthflow-offline-installers'
  and exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and lower(coalesce(u.role, '')) = 'super_admin'
  )
);

drop policy if exists healthflow_offline_installers_super_admin_select
  on storage.objects;
create policy healthflow_offline_installers_super_admin_select
on storage.objects
for select
to authenticated
using (
  bucket_id = 'healthflow-offline-installers'
  and exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and lower(coalesce(u.role, '')) = 'super_admin'
  )
);

drop policy if exists healthflow_offline_installers_super_admin_update
  on storage.objects;
create policy healthflow_offline_installers_super_admin_update
on storage.objects
for update
to authenticated
using (
  bucket_id = 'healthflow-offline-installers'
  and exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and lower(coalesce(u.role, '')) = 'super_admin'
  )
)
with check (
  bucket_id = 'healthflow-offline-installers'
  and exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and lower(coalesce(u.role, '')) = 'super_admin'
  )
);

drop policy if exists healthflow_offline_installers_super_admin_delete
  on storage.objects;
create policy healthflow_offline_installers_super_admin_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'healthflow-offline-installers'
  and exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and lower(coalesce(u.role, '')) = 'super_admin'
  )
);
