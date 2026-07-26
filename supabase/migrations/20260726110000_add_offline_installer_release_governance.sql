-- Offline installer release governance: maker-checker approval before publish,
-- and an immutable publish/rollback history separate from the release row.
-- This does not alter installer packaging, first-run setup, sync, NHIS, CCC,
-- pricing, tariff, claim submission, export, or duplicate logic.

alter table public.offline_installer_releases
  add column if not exists approved_by uuid references auth.users(id),
  add column if not exists approved_at timestamptz,
  add column if not exists approval_notes text;

comment on column public.offline_installer_releases.approved_by is
  'Super Admin who approved this release for publish. Must differ from validated_by (maker-checker separation of duties).';

create or replace function public.set_offline_installer_releases_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first_publish_attempt boolean := false;
begin
  if tg_op = 'INSERT' then
    v_first_publish_attempt := true;
  elsif tg_op = 'UPDATE' then
    v_first_publish_attempt := old.published_at is null;
  end if;

  if tg_op = 'UPDATE' and old.published_at is not null then
    if old.version is distinct from new.version
      or old.download_url is distinct from new.download_url
      or old.file_name is distinct from new.file_name
      or old.file_size is distinct from new.file_size
      or old.sha256 is distinct from new.sha256
      or old.manifest is distinct from new.manifest
      or old.storage_bucket is distinct from new.storage_bucket
      or old.storage_path is distinct from new.storage_path
      or old.built_at is distinct from new.built_at
      or old.git_commit is distinct from new.git_commit
      or old.git_branch is distinct from new.git_branch
      or old.installer_type is distinct from new.installer_type
      or old.minimum_supported_app_version is distinct from new.minimum_supported_app_version
      or old.minimum_supported_local_server_version is distinct from new.minimum_supported_local_server_version
      or old.channel is distinct from new.channel
      or old.approved_by is distinct from new.approved_by
      or old.approved_at is distinct from new.approved_at
    then
      raise exception 'Published installer release artifacts are immutable. Create a new version instead.';
    end if;
  end if;

  -- Editing release content after approval (but before publish) withdraws the
  -- approval, so a swapped artifact can never ride on a stale sign-off.
  if tg_op = 'UPDATE' and old.published_at is null and old.approved_by is not null
    and new.approved_by is not distinct from old.approved_by
  then
    if old.version is distinct from new.version
      or old.file_name is distinct from new.file_name
      or old.file_size is distinct from new.file_size
      or old.sha256 is distinct from new.sha256
      or old.manifest is distinct from new.manifest
      or old.storage_bucket is distinct from new.storage_bucket
      or old.storage_path is distinct from new.storage_path
      or old.release_notes is distinct from new.release_notes
    then
      new.approved_by = null;
      new.approved_at = null;
      new.approval_notes = null;
    end if;
  end if;

  new.updated_at = now();
  new.updated_by = auth.uid();

  if new.enabled and new.state <> 'published' then
    raise exception 'Only published installer releases can be enabled.';
  end if;

  if new.state = 'published' and new.validation_status is distinct from 'valid' then
    raise exception 'Only validated installer releases can be published.';
  end if;

  if new.state = 'published' and coalesce(new.validation_critical_count, 0) > 0 then
    raise exception 'Installer releases with critical validation findings cannot be published.';
  end if;

  if new.state = 'published' and v_first_publish_attempt and new.validated_by is null then
    raise exception 'Installer releases must be validated by a Super Admin before publishing.';
  end if;

  if new.state = 'published' and v_first_publish_attempt and new.approved_by is null then
    raise exception 'Installer releases must be approved by a second reviewer before publishing.';
  end if;

  if new.state = 'published'
    and v_first_publish_attempt
    and new.approved_by is not null
    and new.validated_by is not null
    and new.approved_by = new.validated_by
  then
    raise exception 'The installer release approver must be a different reviewer than the one who validated it.';
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

comment on function public.set_offline_installer_releases_updated_at() is
  'Maintains installer release timestamps, requires a second-reviewer approval distinct from the validator before publish, withdraws approval if the artifact changes afterward, and keeps published artifacts immutable.';

-- Immutable publish/rollback history, kept separate from offline_installer_releases
-- so re-publishing an older (superseded) version can never overwrite prior publish
-- history the way editing the release row in place would.
create table if not exists public.offline_installer_release_publish_events (
  id uuid primary key default gen_random_uuid(),
  release_id uuid references public.offline_installer_releases(id) on delete set null,
  previous_release_id uuid references public.offline_installer_releases(id) on delete set null,
  channel text not null,
  action text not null,
  reason text,
  performed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint offline_installer_release_publish_events_action_check
    check (action in ('publish', 'rollback')),
  constraint offline_installer_release_publish_events_channel_check
    check (channel in ('stable', 'pilot', 'internal')),
  constraint offline_installer_release_publish_events_rollback_reason
    check (action <> 'rollback' or coalesce(nullif(trim(reason), ''), null) is not null)
);

comment on table public.offline_installer_release_publish_events is
  'Append-only publish/rollback history for offline installer releases. No update or delete policy exists for any role, so history cannot be edited after the fact.';

create index if not exists idx_offline_installer_release_publish_events_release
  on public.offline_installer_release_publish_events (release_id, created_at desc);

create index if not exists idx_offline_installer_release_publish_events_channel
  on public.offline_installer_release_publish_events (channel, created_at desc);

alter table public.offline_installer_release_publish_events enable row level security;

drop policy if exists offline_installer_release_publish_events_super_admin_select
  on public.offline_installer_release_publish_events;
create policy offline_installer_release_publish_events_super_admin_select
on public.offline_installer_release_publish_events
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

drop policy if exists offline_installer_release_publish_events_super_admin_insert
  on public.offline_installer_release_publish_events;
create policy offline_installer_release_publish_events_super_admin_insert
on public.offline_installer_release_publish_events
for insert
to authenticated
with check (
  performed_by = auth.uid()
  and exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and lower(coalesce(u.role, '')) = 'super_admin'
  )
);
