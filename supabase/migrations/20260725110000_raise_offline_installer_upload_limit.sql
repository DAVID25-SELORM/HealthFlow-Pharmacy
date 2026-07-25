-- Ensure the private offline-installer bucket accepts full installer ZIPs.
-- This is storage metadata only. It does not change installer packaging,
-- first-run setup, branch-token provisioning, sync, NHIS, CCC, pricing,
-- tariffs, claim submission, duplicate checks, or exports.

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

