-- Defense in depth for privileged recovery and direct-serving operations.
-- Existing RPCs already enforce organization and role boundaries; these
-- triggers additionally reject disabled/missing staff identities.

create or replace function public.require_active_deleted_record_actor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Inventory recycling is performed by the authorized tier-access service.
  if auth.role() = 'service_role' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if not exists (
    select 1
    from public.users actor
    where actor.id = auth.uid()
      and actor.is_active = true
  ) then
    raise exception 'An active staff account is required for Recycle Bin operations.';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists require_active_deleted_record_actor
  on public.deleted_records;

create trigger require_active_deleted_record_actor
before insert or update or delete on public.deleted_records
for each row
execute function public.require_active_deleted_record_actor();

revoke all on function public.require_active_deleted_record_actor() from public;

create or replace function public.require_active_direct_nhis_serving_actor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.direct_served_at is not null
    and old.direct_served_at is null
    and not exists (
      select 1
      from public.users actor
      where actor.id = auth.uid()
        and actor.is_active = true
    )
  then
    raise exception 'An active staff account is required to serve an NHIS claim directly.';
  end if;

  return new;
end;
$$;

drop trigger if exists require_active_direct_nhis_serving_actor
  on public.nhis_claims;

create trigger require_active_direct_nhis_serving_actor
before update of direct_served_at on public.nhis_claims
for each row
execute function public.require_active_direct_nhis_serving_actor();

revoke all on function public.require_active_direct_nhis_serving_actor() from public;

comment on function public.require_active_deleted_record_actor() is
  'Rejects Recycle Bin mutations from disabled or missing staff accounts while allowing the authorized service role.';

comment on function public.require_active_direct_nhis_serving_actor() is
  'Rejects the first direct-serving transition when the authenticated staff account is disabled or missing.';
