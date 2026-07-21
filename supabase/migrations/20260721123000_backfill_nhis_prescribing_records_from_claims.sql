-- Backfill NHIS prescriber and prescribing-facility master records from
-- existing claim text fields. This preserves existing claim behavior: no
-- pricing, CCC, duplicate, tariff, export, or submission logic is changed.

with claim_facility_sources as (
  select
    organization_id,
    nullif(btrim(coalesce(prescribing_facility_name_snapshot, referring_facility)), '') as facility_name
  from public.nhis_claims
  where organization_id is not null
    and nullif(btrim(coalesce(prescribing_facility_name_snapshot, referring_facility)), '') is not null
),
distinct_facilities as (
  select
    organization_id,
    min(facility_name) as facility_name
  from claim_facility_sources
  where lower(facility_name) not in ('-', 'n/a', 'na', 'none', 'null', 'unknown', 'not recorded', 'not stated')
  group by organization_id, lower(facility_name)
)
insert into public.nhis_prescribing_facilities (
  organization_id,
  facility_name,
  facility_type,
  status,
  verification_status,
  notes,
  sync_status
)
select
  source.organization_id,
  source.facility_name,
  'Unknown',
  'active',
  'unverified',
  'Backfilled from existing NHIS claim prescribing facility text.',
  'synced'
from distinct_facilities source
where not exists (
  select 1
  from public.nhis_prescribing_facilities existing
  where existing.organization_id = source.organization_id
    and lower(btrim(existing.facility_name)) = lower(btrim(source.facility_name))
);

with claim_prescriber_sources as (
  select
    organization_id,
    nullif(btrim(coalesce(prescriber_name_snapshot, physician_name)), '') as full_name,
    nullif(btrim(coalesce(prescribing_facility_name_snapshot, referring_facility)), '') as facility_name
  from public.nhis_claims
  where organization_id is not null
    and nullif(btrim(coalesce(prescriber_name_snapshot, physician_name)), '') is not null
),
distinct_prescribers as (
  select
    organization_id,
    min(full_name) as full_name,
    max(facility_name) filter (where facility_name is not null) as facility_name
  from claim_prescriber_sources
  where lower(full_name) not in ('-', 'n/a', 'na', 'none', 'null', 'unknown', 'not recorded', 'not stated')
  group by organization_id, lower(full_name)
),
matched_prescribers as (
  select
    source.organization_id,
    source.full_name,
    facility.id as primary_facility_id
  from distinct_prescribers source
  left join public.nhis_prescribing_facilities facility
    on facility.organization_id = source.organization_id
   and lower(btrim(facility.facility_name)) = lower(btrim(source.facility_name))
)
insert into public.nhis_prescribers (
  organization_id,
  full_name,
  professional_type,
  primary_facility_id,
  status,
  verification_status,
  notes,
  sync_status
)
select
  source.organization_id,
  source.full_name,
  'Doctor',
  source.primary_facility_id,
  'active',
  'unverified',
  'Backfilled from existing NHIS claim prescriber text.',
  'synced'
from matched_prescribers source
where not exists (
  select 1
  from public.nhis_prescribers existing
  where existing.organization_id = source.organization_id
    and lower(btrim(existing.full_name)) = lower(btrim(source.full_name))
);

with matched_claim_sources as (
  select
    claim.id,
    facility.id as prescribing_facility_id,
    prescriber.id as prescriber_id,
    nullif(btrim(coalesce(claim.prescribing_facility_name_snapshot, claim.referring_facility)), '') as facility_name,
    nullif(btrim(claim.prescribing_facility_code_snapshot), '') as facility_code,
    nullif(btrim(coalesce(claim.prescriber_name_snapshot, claim.physician_name)), '') as prescriber_name,
    nullif(btrim(claim.prescriber_license_snapshot), '') as prescriber_license
  from public.nhis_claims claim
  left join public.nhis_prescribing_facilities facility
    on facility.organization_id = claim.organization_id
   and lower(btrim(facility.facility_name)) = lower(btrim(coalesce(claim.prescribing_facility_name_snapshot, claim.referring_facility)))
  left join public.nhis_prescribers prescriber
    on prescriber.organization_id = claim.organization_id
   and lower(btrim(prescriber.full_name)) = lower(btrim(coalesce(claim.prescriber_name_snapshot, claim.physician_name)))
  where claim.organization_id is not null
    and (
      claim.prescribing_facility_id is null
      or claim.prescriber_id is null
      or claim.prescribing_facility_name_snapshot is null
      or claim.prescriber_name_snapshot is null
    )
)
update public.nhis_claims claim
set
  prescribing_facility_id = coalesce(claim.prescribing_facility_id, source.prescribing_facility_id),
  prescriber_id = coalesce(claim.prescriber_id, source.prescriber_id),
  prescribing_facility_name_snapshot = coalesce(claim.prescribing_facility_name_snapshot, source.facility_name),
  prescribing_facility_code_snapshot = coalesce(claim.prescribing_facility_code_snapshot, source.facility_code),
  prescriber_name_snapshot = coalesce(claim.prescriber_name_snapshot, source.prescriber_name),
  prescriber_license_snapshot = coalesce(claim.prescriber_license_snapshot, source.prescriber_license)
from matched_claim_sources source
where claim.id = source.id;

with prescriber_facility_sources as (
  select distinct
    claim.organization_id,
    claim.prescriber_id,
    claim.prescribing_facility_id
  from public.nhis_claims claim
  where claim.organization_id is not null
    and claim.prescriber_id is not null
    and claim.prescribing_facility_id is not null
)
insert into public.nhis_prescriber_facilities (
  organization_id,
  prescriber_id,
  facility_id,
  is_primary,
  status
)
select
  source.organization_id,
  source.prescriber_id,
  source.prescribing_facility_id,
  true,
  'active'
from prescriber_facility_sources source
where not exists (
  select 1
  from public.nhis_prescriber_facilities existing
  where existing.prescriber_id = source.prescriber_id
    and existing.facility_id = source.prescribing_facility_id
);
