-- Repair/ensure lifecycle columns for older offline_installer_releases tables.
-- Run this if a partial/older release table exists and the lifecycle index fails
-- with: column "state" does not exist.
--
-- This is metadata-only for installer release management. It does not alter
-- installer packaging, setup wizard, sync, branch-token provisioning, NHIS,
-- CCC, pricing, tariffs, claim submission, duplicate checks, or exports.

create table if not exists public.offline_installer_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  download_url text not null,
  file_name text not null,
  file_size bigint not null check (file_size > 0),
  sha256 text not null check (sha256 ~ '^[a-fA-F0-9]{64}$'),
  release_notes text,
  enabled boolean not null default false,
  published_at timestamptz,
  published_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.offline_installer_releases
  add column if not exists state text not null default 'draft',
  add column if not exists channel text not null default 'stable',
  add column if not exists validation_status text not null default 'not_validated',
  add column if not exists validation_checked_at timestamptz,
  add column if not exists validation_error text,
  add column if not exists manifest jsonb not null default '{}'::jsonb,
  add column if not exists storage_bucket text,
  add column if not exists storage_path text,
  add column if not exists download_count bigint not null default 0,
  add column if not exists last_downloaded_at timestamptz,
  add column if not exists built_at timestamptz,
  add column if not exists git_commit text,
  add column if not exists git_branch text,
  add column if not exists installer_type text,
  add column if not exists minimum_supported_app_version text,
  add column if not exists minimum_supported_local_server_version text;

update public.offline_installer_releases
set state = case when enabled then 'published' else coalesce(nullif(state, ''), 'draft') end,
    channel = coalesce(nullif(channel, ''), 'stable'),
    validation_status = case
      when enabled then 'valid'
      else coalesce(nullif(validation_status, ''), 'not_validated')
    end
where state is null
   or state = ''
   or channel is null
   or channel = ''
   or validation_status is null
   or validation_status = ''
   or enabled;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'offline_installer_releases_state_check'
      and conrelid = 'public.offline_installer_releases'::regclass
  ) then
    alter table public.offline_installer_releases
      add constraint offline_installer_releases_state_check
      check (state in ('draft', 'uploaded', 'validated', 'published', 'disabled', 'superseded'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'offline_installer_releases_channel_check'
      and conrelid = 'public.offline_installer_releases'::regclass
  ) then
    alter table public.offline_installer_releases
      add constraint offline_installer_releases_channel_check
      check (channel in ('stable', 'pilot', 'internal'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'offline_installer_releases_validation_status_check'
      and conrelid = 'public.offline_installer_releases'::regclass
  ) then
    alter table public.offline_installer_releases
      add constraint offline_installer_releases_validation_status_check
      check (validation_status in ('not_validated', 'valid', 'invalid'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'offline_installer_releases_enabled_requires_published'
      and conrelid = 'public.offline_installer_releases'::regclass
  ) then
    alter table public.offline_installer_releases
      add constraint offline_installer_releases_enabled_requires_published
      check (enabled = false or state = 'published');
  end if;
end;
$$;

create unique index if not exists idx_offline_installer_releases_version
  on public.offline_installer_releases (version);

drop index if exists public.idx_offline_installer_releases_single_enabled;

create unique index if not exists idx_offline_installer_releases_single_enabled_stable
  on public.offline_installer_releases (channel)
  where enabled and state = 'published' and channel = 'stable';

create index if not exists idx_offline_installer_releases_enabled_published
  on public.offline_installer_releases (enabled, state, channel, published_at desc);
