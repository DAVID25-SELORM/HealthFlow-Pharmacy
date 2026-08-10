-- Keep organization-private prescribing registers current as new claims arrive.
-- Claim snapshots remain the export source of truth; this trigger only creates
-- reusable unverified master rows for real values supplied on the claim.

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

  -- A supplied foreign key must belong to the claim organization.
  if new.prescribing_facility_id is not null and not exists (
    select 1 from public.nhis_prescribing_facilities facility
    where facility.id = new.prescribing_facility_id
      and facility.organization_id = new.organization_id
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

  -- Serialize name/code matching so concurrent claim saves cannot create the
  -- same organization-owned register entry twice.
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text, 1));

  if new.prescribing_facility_id is null
     and v_facility_name is not null
     and lower(v_facility_name) not in (
       '-', 'n/a', 'na', 'none', 'null', 'unknown', 'not recorded', 'not stated'
     ) then
    select facility.id into v_facility_id
    from public.nhis_prescribing_facilities facility
    where facility.organization_id = new.organization_id
      and (
        (v_facility_code is not null and lower(btrim(facility.nhia_facility_code)) = lower(v_facility_code))
        or lower(btrim(facility.facility_name)) = lower(v_facility_name)
      )
    order by facility.created_at, facility.id
    limit 1;

    if v_facility_id is null then
      insert into public.nhis_prescribing_facilities (
        organization_id, facility_name, facility_type, nhia_facility_code,
        status, verification_status, notes, created_by, updated_by, sync_status
      ) values (
        new.organization_id, v_facility_name, 'Unknown', v_facility_code,
        'active', 'unverified', 'Automatically registered from an NHIS claim.',
        v_actor_id, v_actor_id, 'synced'
      )
      returning id into v_facility_id;
    end if;

    new.prescribing_facility_id := v_facility_id;
  else
    v_facility_id := new.prescribing_facility_id;
  end if;

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

comment on function public.register_nhis_claim_prescription_source() is
  'Registers real claim-supplied prescribers and originating facilities inside the claim organization and rejects cross-organization foreign keys.';

notify pgrst, 'reload schema';
