-- Harden offline installer release integrity.
-- This does not alter installer packaging, first-run setup, sync, NHIS, CCC,
-- pricing, tariff, claim submission, export, or duplicate logic.

create or replace function public.set_offline_installer_releases_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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
    then
      raise exception 'Published installer release artifacts are immutable. Create a new version instead.';
    end if;
  end if;

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

comment on function public.set_offline_installer_releases_updated_at() is
  'Maintains installer release timestamps and prevents content-bearing fields from changing after first publication.';
