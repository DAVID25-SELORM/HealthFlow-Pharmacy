-- Offline installer release assurance.
-- Additive only: no installer setup, sync, NHIS, CCC, pricing, tariff,
-- submission, duplicate detection, or existing facility data behavior changes.

alter table public.offline_installer_releases
  add column if not exists validation_report jsonb not null default '[]'::jsonb,
  add column if not exists validation_critical_count integer not null default 0,
  add column if not exists validation_warning_count integer not null default 0,
  add column if not exists validation_info_count integer not null default 0,
  add column if not exists validated_by uuid references auth.users(id);

comment on column public.offline_installer_releases.validation_report is
  'Safe release validation checklist report. Does not store archive contents, secrets, signed URLs, tokens, or patient/claim data.';
comment on column public.offline_installer_releases.validated_by is
  'Super Admin user who last validated the installer release.';

create table if not exists public.offline_installer_installation_events (
  id uuid primary key default gen_random_uuid(),
  release_id uuid references public.offline_installer_releases(id) on delete set null,
  organization_id uuid references public.organizations(id) on delete set null,
  branch_id uuid,
  sync_client_id uuid references public.branch_sync_clients(id) on delete set null,
  event_status text not null,
  installer_version text,
  machine_label text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint offline_installer_installation_events_status_check
    check (event_status in (
      'download_requested',
      'installer_started',
      'installer_completed',
      'service_started',
      'machine_registered',
      'initial_sync_started',
      'initial_sync_completed',
      'readiness_passed',
      'installation_failed'
    ))
);

comment on table public.offline_installer_installation_events is
  'Privacy-safe offline installer lifecycle events. Do not store patient data, claim data, passwords, branch tokens, local database contents, signed URLs, or authorization headers.';

create index if not exists idx_offline_installer_installation_events_release_created
  on public.offline_installer_installation_events (release_id, created_at desc);

create index if not exists idx_offline_installer_installation_events_org_created
  on public.offline_installer_installation_events (organization_id, created_at desc);

alter table public.offline_installer_installation_events enable row level security;

drop policy if exists offline_installer_installation_events_super_admin_select
  on public.offline_installer_installation_events;
create policy offline_installer_installation_events_super_admin_select
on public.offline_installer_installation_events
for select
to authenticated
using (
  exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and lower(coalesce(u.role, '')) = 'super_admin'
  )
);

drop policy if exists offline_installer_installation_events_authenticated_insert
  on public.offline_installer_installation_events;
create policy offline_installer_installation_events_authenticated_insert
on public.offline_installer_installation_events
for insert
to authenticated
with check (
  created_by = auth.uid()
  and (
    organization_id is null
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and (
          lower(coalesce(u.role, '')) = 'super_admin'
          or u.organization_id = offline_installer_installation_events.organization_id
        )
    )
  )
);

-- Preserve rollback history while ensuring only one enabled published release can
-- exist per channel (internal, pilot, stable).
drop index if exists public.idx_offline_installer_releases_single_enabled_stable;

create unique index if not exists idx_offline_installer_releases_single_enabled_channel
  on public.offline_installer_releases (channel)
  where enabled and state = 'published';
