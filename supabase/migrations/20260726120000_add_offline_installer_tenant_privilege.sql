-- Tenant-level permission for offline installer downloads.
-- This only controls installer availability; it does not alter CCC, NHIS
-- pricing, tariffs, export, submission, duplicate detection, or sync logic.

alter table if exists public.organizations
  add column if not exists can_use_offline_installer boolean not null default false;

comment on column public.organizations.can_use_offline_installer is
  'When true, authorized facility admins can request signed HealthFlow offline installer downloads.';
