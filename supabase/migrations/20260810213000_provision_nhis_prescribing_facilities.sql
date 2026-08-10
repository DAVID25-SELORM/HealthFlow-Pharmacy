-- Make NHIS prescribing-record setup consistent for new and existing tenants.
-- Prescribers remain real, organization-owned people and are never fabricated.

create or replace function public.provision_nhis_prescribing_facility(p_organization_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_facility_id uuid;
  v_actor_id uuid := auth.uid();
begin
  if p_organization_id is null then
    raise exception 'Organization ID is required.' using errcode = '22023';
  end if;

  if auth.role() <> 'service_role' and not exists (
    select 1
    from public.users actor
    where actor.id = v_actor_id
      and actor.organization_id = p_organization_id
      and actor.is_active = true
      and (
        actor.role in ('admin', 'super_admin')
        or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
      )
  ) then
    raise exception 'Only an active organization administrator can provision NHIS prescribing records.'
      using errcode = '42501';
  end if;

  -- Serialize retries for the same organization so concurrent onboarding or
  -- repair requests cannot create duplicate own-facility rows.
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 0));

  select facility.id
  into v_facility_id
  from public.nhis_prescribing_facilities facility
  join public.organizations organization on organization.id = facility.organization_id
  where facility.organization_id = p_organization_id
    and lower(btrim(facility.facility_name)) = lower(btrim(organization.name))
  order by facility.created_at
  limit 1;

  if v_facility_id is not null then
    return v_facility_id;
  end if;

  insert into public.nhis_prescribing_facilities (
    organization_id,
    branch_id,
    facility_name,
    facility_type,
    ownership_type,
    address,
    region,
    town,
    phone,
    email,
    status,
    verification_status,
    notes,
    created_by,
    updated_by
  )
  select
    organization.id,
    branch.id,
    organization.name,
    case lower(coalesce(organization.organization_type, ''))
      when 'hospital' then 'Hospital'
      when 'clinic' then 'Clinic'
      when 'health_centre' then 'Health Centre'
      when 'health centre' then 'Health Centre'
      when 'chemical_shop' then 'Community Pharmacy'
      when 'chemical shop' then 'Community Pharmacy'
      else 'Community Pharmacy'
    end,
    null,
    organization.address,
    organization.region,
    organization.city,
    organization.phone,
    organization.email,
    'active',
    'unverified',
    'Created by canonical NHIS organization provisioning.',
    v_actor_id,
    v_actor_id
  from public.organizations organization
  left join lateral (
    select candidate.id
    from public.branches candidate
    where candidate.organization_id = organization.id
      and candidate.is_main = true
      and candidate.is_active = true
    order by candidate.created_at
    limit 1
  ) branch on true
  where organization.id = p_organization_id
    and organization.can_use_nhis = true
  returning id into v_facility_id;

  return v_facility_id;
end;
$$;

revoke all on function public.provision_nhis_prescribing_facility(uuid) from public, anon, authenticated;
grant execute on function public.provision_nhis_prescribing_facility(uuid) to service_role;

create or replace function public.list_nhis_prescribing_provisioning_gaps()
returns table (
  organization_id uuid,
  organization_name text,
  facility_count bigint,
  prescriber_count bigint
)
language sql
security definer
set search_path = public
as $$
  select
    organization.id,
    organization.name,
    (select count(*) from public.nhis_prescribing_facilities facility where facility.organization_id = organization.id),
    (select count(*) from public.nhis_prescribers prescriber where prescriber.organization_id = organization.id)
  from public.organizations organization
  where organization.can_use_nhis = true
    and (
      not exists (select 1 from public.nhis_prescribing_facilities facility where facility.organization_id = organization.id)
      or not exists (select 1 from public.nhis_prescribers prescriber where prescriber.organization_id = organization.id)
    )
  order by organization.name;
$$;

revoke all on function public.list_nhis_prescribing_provisioning_gaps() from public, anon, authenticated;
grant execute on function public.list_nhis_prescribing_provisioning_gaps() to service_role;

drop policy if exists nhis_prescribing_facilities_select_org on public.nhis_prescribing_facilities;
create policy nhis_prescribing_facilities_select_org
  on public.nhis_prescribing_facilities for select to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users viewer
      where viewer.id = auth.uid()
        and viewer.is_active = true
        and viewer.organization_id = nhis_prescribing_facilities.organization_id
        and (
          viewer.role in ('admin', 'super_admin')
          or coalesce(viewer.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
          or nhis_prescribing_facilities.branch_id is null
          or nhis_prescribing_facilities.branch_id = viewer.branch_id
        )
    )
  );

drop policy if exists nhis_prescribers_select_org on public.nhis_prescribers;
create policy nhis_prescribers_select_org
  on public.nhis_prescribers for select to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users viewer
      where viewer.id = auth.uid()
        and viewer.is_active = true
        and viewer.organization_id = nhis_prescribers.organization_id
        and (
          viewer.role in ('admin', 'super_admin')
          or coalesce(viewer.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
          or nhis_prescribers.branch_id is null
          or nhis_prescribers.branch_id = viewer.branch_id
        )
    )
  );

drop policy if exists nhis_prescribing_facilities_write_org on public.nhis_prescribing_facilities;
create policy nhis_prescribing_facilities_write_org
  on public.nhis_prescribing_facilities for all to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users actor
      where actor.id = auth.uid() and actor.is_active = true
        and actor.organization_id = nhis_prescribing_facilities.organization_id
        and (
          actor.role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer']::text[]
        )
        and (
          actor.role in ('admin', 'super_admin')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
          or nhis_prescribing_facilities.branch_id is null
          or nhis_prescribing_facilities.branch_id = actor.branch_id
        )
    )
  )
  with check (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users actor
      where actor.id = auth.uid() and actor.is_active = true
        and actor.organization_id = nhis_prescribing_facilities.organization_id
        and (
          actor.role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer']::text[]
        )
        and (
          actor.role in ('admin', 'super_admin')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
          or nhis_prescribing_facilities.branch_id is null
          or nhis_prescribing_facilities.branch_id = actor.branch_id
        )
    )
  );

drop policy if exists nhis_prescribers_write_org on public.nhis_prescribers;
create policy nhis_prescribers_write_org
  on public.nhis_prescribers for all to authenticated
  using (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users actor
      where actor.id = auth.uid() and actor.is_active = true
        and actor.organization_id = nhis_prescribers.organization_id
        and (
          actor.role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer']::text[]
        )
        and (
          actor.role in ('admin', 'super_admin')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
          or nhis_prescribers.branch_id is null
          or nhis_prescribers.branch_id = actor.branch_id
        )
    )
  )
  with check (
    organization_id = public.user_organization_id()
    and exists (
      select 1 from public.users actor
      where actor.id = auth.uid() and actor.is_active = true
        and actor.organization_id = nhis_prescribers.organization_id
        and (
          actor.role in ('admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin', 'pharmacist', 'claims_officer', 'records_officer']::text[]
        )
        and (
          actor.role in ('admin', 'super_admin')
          or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
          or nhis_prescribers.branch_id is null
          or nhis_prescribers.branch_id = actor.branch_id
        )
    )
  );

comment on function public.provision_nhis_prescribing_facility(uuid) is
  'Idempotently creates the NHIS organization own-facility master record. It never creates prescribers or copies another tenant records.';
comment on function public.list_nhis_prescribing_provisioning_gaps() is
  'Metadata-only preview of NHIS organizations missing facilities or prescribers; exposes no patient or claim data and performs no writes.';

notify pgrst, 'reload schema';
