-- Runtime installer release control.
-- This does not alter installer packaging, first-run setup, branch-token
-- provisioning, sync behavior, NHIS, CCC, pricing, tariffs, claims, or exports.

create table if not exists public.offline_installer_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  download_url text not null,
  file_name text not null,
  file_size bigint not null check (file_size > 0),
  sha256 text not null check (sha256 ~ '^[a-fA-F0-9]{64}$'),
  release_notes text,
  state text not null default 'draft',
  channel text not null default 'stable',
  validation_status text not null default 'not_validated',
  validation_checked_at timestamptz,
  validation_error text,
  manifest jsonb not null default '{}'::jsonb,
  storage_bucket text,
  storage_path text,
  download_count bigint not null default 0,
  last_downloaded_at timestamptz,
  built_at timestamptz,
  git_commit text,
  git_branch text,
  installer_type text,
  minimum_supported_app_version text,
  minimum_supported_local_server_version text,
  enabled boolean not null default false,
  published_at timestamptz,
  published_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint offline_installer_releases_https_url
    check (download_url ~* '^https://'),
  constraint offline_installer_releases_zip_name
    check (file_name ~ '^HealthFlow-Offline-Installer-[A-Za-z0-9._-]+\.zip$'),
  constraint offline_installer_releases_state_check
    check (state in ('draft', 'uploaded', 'validated', 'published', 'disabled', 'superseded')),
  constraint offline_installer_releases_channel_check
    check (channel in ('stable', 'pilot', 'internal')),
  constraint offline_installer_releases_validation_status_check
    check (validation_status in ('not_validated', 'valid', 'invalid')),
  constraint offline_installer_releases_enabled_requires_published
    check (enabled = false or state = 'published')
);

-- If an earlier version of this migration/table was already applied, the
-- create-table body above is skipped. Add lifecycle columns explicitly before
-- indexes, policies, and triggers reference them.
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

create or replace function public.set_offline_installer_releases_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  if new.enabled and new.state <> 'published' then
    raise exception 'Only published installer releases can be enabled.';
  end if;
  if new.state = 'published' and new.validation_status <> 'valid' then
    raise exception 'Only validated installer releases can be published.';
  end if;
  if new.enabled then
    if tg_op = 'INSERT' then
      new.published_at = coalesce(new.published_at, now());
      new.published_by = coalesce(new.published_by, auth.uid());
    elsif tg_op = 'UPDATE' and old.enabled is distinct from new.enabled then
      new.published_at = coalesce(new.published_at, now());
      new.published_by = coalesce(new.published_by, auth.uid());
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_offline_installer_releases_updated_at on public.offline_installer_releases;
create trigger trg_offline_installer_releases_updated_at
before insert or update on public.offline_installer_releases
for each row execute function public.set_offline_installer_releases_updated_at();

alter table public.offline_installer_releases enable row level security;

drop policy if exists "offline_installer_releases_select_enabled_or_super_admin"
  on public.offline_installer_releases;
create policy "offline_installer_releases_select_enabled_or_super_admin"
  on public.offline_installer_releases
  for select
  to authenticated
  using (
    (enabled and state = 'published')
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and lower(coalesce(u.role, '')) = 'super_admin'
    )
  );

drop policy if exists "offline_installer_releases_manage_super_admin"
  on public.offline_installer_releases;
create policy "offline_installer_releases_manage_super_admin"
  on public.offline_installer_releases
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and lower(coalesce(u.role, '')) = 'super_admin'
    )
  )
  with check (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and lower(coalesce(u.role, '')) = 'super_admin'
    )
  );
