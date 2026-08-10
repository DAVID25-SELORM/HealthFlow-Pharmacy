-- Correct the source-of-prescription model after the provisioning migration:
-- the HealthFlow tenant is the dispensing organization, not automatically the
-- external hospital/clinic that originated a prescription.

drop function if exists public.provision_nhis_prescribing_facility(uuid);

create or replace function public.list_generated_own_prescribing_facilities()
returns table (
  facility_id uuid,
  organization_id uuid,
  organization_name text,
  referenced_claim_count bigint,
  linked_prescriber_count bigint
)
language sql
security definer
set search_path = public
as $$
  select
    facility.id,
    facility.organization_id,
    organization.name,
    (select count(*) from public.nhis_claims claim where claim.prescribing_facility_id = facility.id),
    (select count(*) from public.nhis_prescribers prescriber where prescriber.primary_facility_id = facility.id)
  from public.nhis_prescribing_facilities facility
  join public.organizations organization on organization.id = facility.organization_id
  where facility.notes = 'Created by canonical NHIS organization provisioning.'
  order by organization.name, facility.created_at;
$$;

revoke all on function public.list_generated_own_prescribing_facilities() from public, anon, authenticated;
grant execute on function public.list_generated_own_prescribing_facilities() to service_role;

create or replace function public.remove_unused_generated_own_prescribing_facilities()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Service-role authorization is required.' using errcode = '42501';
  end if;

  delete from public.nhis_prescribing_facilities facility
  where facility.notes = 'Created by canonical NHIS organization provisioning.'
    and not exists (
      select 1 from public.nhis_claims claim
      where claim.prescribing_facility_id = facility.id
    )
    and not exists (
      select 1 from public.nhis_prescribers prescriber
      where prescriber.primary_facility_id = facility.id
    )
    and not exists (
      select 1 from public.nhis_prescriber_facilities link
      where link.facility_id = facility.id
    );

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.remove_unused_generated_own_prescribing_facilities() from public, anon, authenticated;
grant execute on function public.remove_unused_generated_own_prescribing_facilities() to service_role;

comment on function public.list_generated_own_prescribing_facilities() is
  'Metadata-only preview of dispensing-organization rows created by the retired provisioning function.';
comment on function public.remove_unused_generated_own_prescribing_facilities() is
  'Removes only provisioning-generated own-facility rows that are not referenced by a claim or prescriber relationship.';

notify pgrst, 'reload schema';
