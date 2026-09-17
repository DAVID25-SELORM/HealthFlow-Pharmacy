-- Add shared reference rows to the existing prescribing facility register.
-- No organization accounts and no updates/backfills to existing claims.
begin;
alter table public.nhis_prescribing_facilities
  add column if not exists is_shared boolean not null default false,
  add column if not exists canonical_name text generated always as
    (regexp_replace(lower(btrim(facility_name)), '[[:space:]]+', ' ', 'g')) stored,
  add column if not exists aliases text[] not null default '{}',
  add column if not exists area text,
  add column if not exists nhis_enabled boolean;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.nhis_prescribing_facilities'::regclass and conname='shared_prescribing_facility_no_tenant') then
    alter table public.nhis_prescribing_facilities add constraint shared_prescribing_facility_no_tenant check
      (not is_shared or (organization_id is null and branch_id is null));
  end if;
end $$;
create unique index if not exists prescribing_directory_canonical_name
  on public.nhis_prescribing_facilities(canonical_name) where is_shared;

create or replace function public.can_manage_prescribing_directory()
returns boolean language sql stable security definer set search_path = public, pg_catalog as $$
  select exists(select 1 from public.users where id=auth.uid()
    and is_active is true and role='super_admin');
$$;
revoke all on function public.can_manage_prescribing_directory() from public, anon;
grant execute on function public.can_manage_prescribing_directory() to authenticated;

drop policy if exists prescribing_directory_read on public.nhis_prescribing_facilities;
create policy prescribing_directory_read on public.nhis_prescribing_facilities
for select to authenticated using (is_shared and exists (
  select 1 from public.users where id=auth.uid() and is_active is true));
drop policy if exists prescribing_directory_insert on public.nhis_prescribing_facilities;
create policy prescribing_directory_insert on public.nhis_prescribing_facilities
for insert to authenticated with check (is_shared and public.can_manage_prescribing_directory());
drop policy if exists prescribing_directory_update on public.nhis_prescribing_facilities;
create policy prescribing_directory_update on public.nhis_prescribing_facilities
for update to authenticated using (is_shared and public.can_manage_prescribing_directory())
with check (is_shared and public.can_manage_prescribing_directory());
-- Preserve tenant-private register permissions; shared writes require platform authority.
drop policy if exists prescribing_directory_write_boundary on public.nhis_prescribing_facilities;
create policy prescribing_directory_write_boundary on public.nhis_prescribing_facilities
as restrictive for all to authenticated using
  (not is_shared or exists(select 1 from public.users where id=auth.uid() and is_active is true))
with check (not is_shared or public.can_manage_prescribing_directory());
grant select, insert, update on public.nhis_prescribing_facilities to authenticated;

create or replace function public.protect_shared_prescribing_facility()
returns trigger language plpgsql set search_path=public,pg_catalog as $$
begin
  if old.is_shared and (tg_op='DELETE' or not new.is_shared) then
    raise exception 'Deactivate shared facilities; do not delete or privatize them.' using errcode='23514';
  end if;
  if (old.is_shared or (tg_op='UPDATE' and new.is_shared)) and not public.can_manage_prescribing_directory() then
    raise exception 'Only platform administrators may edit the shared directory.' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists protect_shared_prescribing_facility on public.nhis_prescribing_facilities;
create trigger protect_shared_prescribing_facility before update or delete
on public.nhis_prescribing_facilities for each row execute function public.protect_shared_prescribing_facility();

-- Stable seed IDs also prevent re-creating a renamed seed on re-run.
-- Supplied names/aliases only. NHIS eligibility and unverified provider IDs remain NULL.
insert into public.nhis_prescribing_facilities(id,facility_name,is_shared,aliases,status)
values ('cbe330a7-af02-5651-8608-b1ff93136a31','Korle Bu Teaching Hospital',true,'{}','active'),
 ('1456bcfe-9ed2-5126-940e-a1d3bb4b70d9','Greater Accra Regional Hospital',true,array['Ridge Hospital','Ridge'],'active'),
 ('c01f08ae-3ca8-5678-b2ff-78857a114b3a','37 Military Hospital',true,'{}','active'),
 ('7bc4dfbd-b4b8-5be5-8ea1-8f56028e8400','University of Ghana Medical Centre',true,array['UGMC'],'active'),
 ('0f530cb2-00c5-5f6c-acc3-d634bb430419','LEKMA Hospital',true,'{}','active'), ('0202e131-c64a-5282-aa7c-4a8c849be227','Police Hospital',true,'{}','active'),
 ('d9e6e011-52f0-53d2-9ef0-b47ffa0dfa2e','Ga East Municipal Hospital',true,'{}','active'), ('27d0ebe5-cee4-5ddc-962a-ffa9fe63f17d','Adabraka Polyclinic',true,'{}','active'),
 ('10d8585b-fcfc-5b0d-8b55-65d317860cd9','Kaneshie Polyclinic',true,'{}','active')
on conflict do nothing;

create or replace function public.search_prescribing_directory(
 p_search text default '', p_nhis_only boolean default false,
 p_include_inactive boolean default false, p_limit integer default 30, p_offset integer default 0)
returns setof public.nhis_prescribing_facilities
language sql stable security invoker set search_path=public,pg_catalog as $$
 select f.* from public.nhis_prescribing_facilities f
 where f.is_shared and (f.status='active' or (p_include_inactive and public.can_manage_prescribing_directory()))
 and (not p_nhis_only or f.nhis_enabled is true)
 and (nullif(btrim(p_search),'') is null or
   strpos(lower(concat_ws(' ', f.facility_name, array_to_string(f.aliases,' '),f.area,f.town,f.region)),lower(btrim(p_search)))>0)
 order by (f.nhis_enabled is true) desc, f.canonical_name, f.id
 limit least(greatest(coalesce(p_limit,30),1),100) offset greatest(coalesce(p_offset,0),0);
$$;
revoke all on function public.search_prescribing_directory(text,boolean,boolean,integer,integer) from public,anon;
grant execute on function public.search_prescribing_directory(text,boolean,boolean,integer,integer) to authenticated;

create or replace function public.register_nhis_claim_prescription_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_facility_name text := nullif(btrim(coalesce(
    new.prescribing_facility_name_snapshot,
    new.referring_facility
  )), '');
  v_facility_code text := nullif(btrim(new.prescribing_facility_code_snapshot), '');
  v_prescriber_name text := nullif(btrim(coalesce(
    new.prescriber_name_snapshot,
    new.physician_name
  )), '');
  v_prescriber_license text := nullif(btrim(new.prescriber_license_snapshot), '');
  v_facility_id uuid;
  v_prescriber_id uuid;
begin
  if new.organization_id is null then
    return new;
  end if;

  -- Private references belong to the claim tenant; shared reference rows are allowed.
  if new.prescribing_facility_id is not null and not exists (
    select 1 from public.nhis_prescribing_facilities facility
    where facility.id = new.prescribing_facility_id
      and (facility.organization_id = new.organization_id or facility.is_shared)
  ) then
    raise exception 'Prescribing facility does not belong to the claim organization.'
      using errcode = '42501';
  end if;
  if new.prescriber_id is not null and not exists (
    select 1 from public.nhis_prescribers prescriber
    where prescriber.id = new.prescriber_id
      and prescriber.organization_id = new.organization_id
  ) then
    raise exception 'Prescriber does not belong to the claim organization.'
      using errcode = '42501';
  end if;

  v_facility_id := new.prescribing_facility_id;
  if v_facility_id is not null and (tg_op = 'INSERT' or
      new.prescribing_facility_id is distinct from old.prescribing_facility_id) then
    if not exists (select 1 from public.nhis_prescribing_facilities
      where id = v_facility_id and status = 'active') then
      raise exception 'Select an active prescribing facility.' using errcode = '23514';
    end if;
    -- The stable identity and export snapshot travel together. Existing records
    -- keep their snapshots when the directory changes or is deactivated.
    select facility_name, nhia_facility_code into
      new.prescribing_facility_name_snapshot, new.prescribing_facility_code_snapshot
    from public.nhis_prescribing_facilities where id = v_facility_id;
    new.referring_facility := new.prescribing_facility_name_snapshot;
  end if;
  -- Unlisted names remain claim snapshots with a NULL facility ID. Never
  -- create shared or private facilities implicitly from a typed name.
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text, 1));

  if new.prescriber_id is null
     and v_prescriber_name is not null
     and lower(v_prescriber_name) not in (
       '-', 'n/a', 'na', 'none', 'null', 'unknown', 'not recorded', 'not stated'
     ) then
    select prescriber.id into v_prescriber_id
    from public.nhis_prescribers prescriber
    where prescriber.organization_id = new.organization_id
      and (
        (v_prescriber_license is not null and lower(btrim(prescriber.license_number)) = lower(v_prescriber_license))
        or lower(btrim(prescriber.full_name)) = lower(v_prescriber_name)
      )
    order by prescriber.created_at, prescriber.id
    limit 1;

    if v_prescriber_id is null then
      insert into public.nhis_prescribers (
        organization_id, full_name, professional_type, license_number,
        primary_facility_id, status, verification_status, notes,
        created_by, updated_by, sync_status
      ) values (
        new.organization_id, v_prescriber_name, 'Doctor', v_prescriber_license,
        v_facility_id, 'active', 'unverified',
        'Automatically registered from an NHIS claim.',
        v_actor_id, v_actor_id, 'synced'
      )
      returning id into v_prescriber_id;
    end if;

    new.prescriber_id := v_prescriber_id;
  else
    v_prescriber_id := new.prescriber_id;
  end if;

  if v_prescriber_id is not null and v_facility_id is not null then
    insert into public.nhis_prescriber_facilities (
      organization_id, prescriber_id, facility_id, is_primary, status,
      created_by, updated_by
    ) values (
      new.organization_id, v_prescriber_id, v_facility_id, true, 'active',
      v_actor_id, v_actor_id
    )
    on conflict (prescriber_id, facility_id) do nothing;
  end if;

  return new;
end;
$$;

revoke all on function public.register_nhis_claim_prescription_source() from public, anon, authenticated;

drop trigger if exists register_nhis_claim_prescription_source on public.nhis_claims;
create trigger register_nhis_claim_prescription_source
before insert or update of
  organization_id,
  prescriber_id,
  prescribing_facility_id,
  physician_name,
  referring_facility,
  prescriber_name_snapshot,
  prescriber_license_snapshot,
  prescribing_facility_name_snapshot,
  prescribing_facility_code_snapshot
on public.nhis_claims
for each row
execute function public.register_nhis_claim_prescription_source();


notify pgrst, 'reload schema';
commit;
