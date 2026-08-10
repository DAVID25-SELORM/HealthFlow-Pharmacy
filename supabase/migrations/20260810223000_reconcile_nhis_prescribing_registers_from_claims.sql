-- Forward repair for claims saved after the original one-time backfill.
-- Only real values already stored on an organization's claims are promoted.

with claim_facility_sources as (
  select organization_id,
    nullif(btrim(coalesce(prescribing_facility_name_snapshot, referring_facility)), '') as facility_name
  from public.nhis_claims
  where organization_id is not null
), distinct_facilities as (
  select organization_id, min(facility_name) as facility_name
  from claim_facility_sources
  where facility_name is not null
    and lower(facility_name) not in ('-', 'n/a', 'na', 'none', 'null', 'unknown', 'not recorded', 'not stated')
  group by organization_id, lower(facility_name)
)
insert into public.nhis_prescribing_facilities (
  organization_id, facility_name, facility_type, status, verification_status, notes, sync_status
)
select organization_id, facility_name, 'Unknown', 'active', 'unverified',
  'Reconciled from an existing NHIS claim prescribing facility.', 'synced'
from distinct_facilities source
where not exists (
  select 1 from public.nhis_prescribing_facilities existing
  where existing.organization_id = source.organization_id
    and lower(btrim(existing.facility_name)) = lower(btrim(source.facility_name))
);

with claim_prescriber_sources as (
  select organization_id,
    nullif(btrim(coalesce(prescriber_name_snapshot, physician_name)), '') as full_name,
    nullif(btrim(coalesce(prescribing_facility_name_snapshot, referring_facility)), '') as facility_name
  from public.nhis_claims
  where organization_id is not null
), distinct_prescribers as (
  select organization_id, min(full_name) as full_name,
    max(facility_name) filter (where facility_name is not null) as facility_name
  from claim_prescriber_sources
  where full_name is not null
    and lower(full_name) not in ('-', 'n/a', 'na', 'none', 'null', 'unknown', 'not recorded', 'not stated')
  group by organization_id, lower(full_name)
)
insert into public.nhis_prescribers (
  organization_id, full_name, professional_type, primary_facility_id,
  status, verification_status, notes, sync_status
)
select source.organization_id, source.full_name, 'Doctor', facility.id,
  'active', 'unverified', 'Reconciled from an existing NHIS claim prescriber.', 'synced'
from distinct_prescribers source
left join public.nhis_prescribing_facilities facility
  on facility.organization_id = source.organization_id
 and lower(btrim(facility.facility_name)) = lower(btrim(source.facility_name))
where not exists (
  select 1 from public.nhis_prescribers existing
  where existing.organization_id = source.organization_id
    and lower(btrim(existing.full_name)) = lower(btrim(source.full_name))
);

with matched_claims as (
  select claim.id, facility.id as facility_id, prescriber.id as prescriber_id
  from public.nhis_claims claim
  left join public.nhis_prescribing_facilities facility
    on facility.organization_id = claim.organization_id
   and lower(btrim(facility.facility_name)) = lower(btrim(coalesce(
     claim.prescribing_facility_name_snapshot, claim.referring_facility
   )))
  left join public.nhis_prescribers prescriber
    on prescriber.organization_id = claim.organization_id
   and lower(btrim(prescriber.full_name)) = lower(btrim(coalesce(
     claim.prescriber_name_snapshot, claim.physician_name
   )))
  where claim.prescribing_facility_id is null or claim.prescriber_id is null
)
update public.nhis_claims claim
set prescribing_facility_id = coalesce(claim.prescribing_facility_id, source.facility_id),
    prescriber_id = coalesce(claim.prescriber_id, source.prescriber_id)
from matched_claims source
where claim.id = source.id
  and ((claim.prescribing_facility_id is null and source.facility_id is not null)
    or (claim.prescriber_id is null and source.prescriber_id is not null));

insert into public.nhis_prescriber_facilities (
  organization_id, prescriber_id, facility_id, is_primary, status
)
select distinct claim.organization_id, claim.prescriber_id, claim.prescribing_facility_id, true, 'active'
from public.nhis_claims claim
where claim.organization_id is not null
  and claim.prescriber_id is not null
  and claim.prescribing_facility_id is not null
  and not exists (
    select 1 from public.nhis_prescriber_facilities existing
    where existing.prescriber_id = claim.prescriber_id
      and existing.facility_id = claim.prescribing_facility_id
  );

notify pgrst, 'reload schema';
