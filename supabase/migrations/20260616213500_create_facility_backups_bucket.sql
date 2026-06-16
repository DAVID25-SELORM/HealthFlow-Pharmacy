insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'facility-backups',
  'facility-backups',
  false,
  262144000,
  array['application/json']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = 262144000,
  allowed_mime_types = array['application/json'];
