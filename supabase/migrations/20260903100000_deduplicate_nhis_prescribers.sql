-- Collapse deterministic prescriber duplicates created from historical claim
-- text while preserving organization isolation, claim links and facilities.
-- Similar spellings are deliberately not merged without stronger identity data.

create or replace function public.normalize_nhis_prescriber_identity(p_name text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(lower(btrim(coalesce(p_name, ''))), '^(dr|doctor)[[:space:].:-]+', ''),
        '[^a-z0-9]+', ' ', 'g'
      )
    ),
    ''
  );
$$;

revoke all on function public.normalize_nhis_prescriber_identity(text) from public, anon;
grant execute on function public.normalize_nhis_prescriber_identity(text) to authenticated;

-- This trigger runs alphabetically before register_nhis_claim_prescription_source.
-- It reuses an existing deterministic identity so new claim saves do not
-- recreate title/punctuation variants in either existing or future tenants.
create or replace function public.canonicalize_nhis_claim_prescriber()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_name text := nullif(btrim(coalesce(new.prescriber_name_snapshot, new.physician_name)), '');
  v_license text := nullif(btrim(new.prescriber_license_snapshot), '');
begin
  if new.organization_id is null or new.prescriber_id is not null or v_name is null then
    return new;
  end if;

  select prescriber.id
  into new.prescriber_id
  from public.nhis_prescribers prescriber
  where prescriber.organization_id = new.organization_id
    and prescriber.status <> 'inactive'
    and (
      (v_license is not null and lower(btrim(prescriber.license_number)) = lower(v_license))
      or (
        public.normalize_nhis_prescriber_identity(prescriber.full_name)
          = public.normalize_nhis_prescriber_identity(v_name)
        and prescriber.primary_facility_id is not distinct from new.prescribing_facility_id
        and (v_license is null or prescriber.license_number is null)
      )
    )
  order by (prescriber.verification_status = 'verified') desc, prescriber.created_at, prescriber.id
  limit 1;

  return new;
end;
$$;

revoke all on function public.canonicalize_nhis_claim_prescriber() from public, anon, authenticated;

drop trigger if exists canonicalize_nhis_claim_prescriber on public.nhis_claims;
create trigger canonicalize_nhis_claim_prescriber
before insert or update of
  organization_id, prescriber_id, prescribing_facility_id, physician_name,
  prescriber_name_snapshot, prescriber_license_snapshot
on public.nhis_claims
for each row execute function public.canonicalize_nhis_claim_prescriber();

do $$
begin
  create temporary table nhis_prescriber_duplicate_map on commit drop as
  with ranked as (
    select
      p.id,
      first_value(p.id) over (
        partition by
          p.organization_id,
          public.normalize_nhis_prescriber_identity(p.full_name),
          coalesce(lower(btrim(p.license_number)), ''),
          coalesce(p.primary_facility_id::text, '')
        order by
          (p.verification_status = 'verified') desc,
          (p.license_number is not null) desc,
          p.created_at,
          p.id
      ) as winner_id,
      count(*) over (
        partition by
          p.organization_id,
          public.normalize_nhis_prescriber_identity(p.full_name),
          coalesce(lower(btrim(p.license_number)), ''),
          coalesce(p.primary_facility_id::text, '')
      ) as duplicate_count
    from public.nhis_prescribers p
    where public.normalize_nhis_prescriber_identity(p.full_name) is not null
  )
  select id as duplicate_id, winner_id
  from ranked
  where duplicate_count > 1 and id <> winner_id;

  update public.nhis_claims claim
  set prescriber_id = mapping.winner_id
  from nhis_prescriber_duplicate_map mapping
  where claim.prescriber_id = mapping.duplicate_id;

  insert into public.nhis_prescriber_facilities (
    organization_id, prescriber_id, facility_id, is_primary, status,
    created_by, updated_by, created_at, updated_at
  )
  select distinct on (mapping.winner_id, link.facility_id)
    link.organization_id,
    mapping.winner_id,
    link.facility_id,
    bool_or(link.is_primary) over (
      partition by mapping.winner_id, link.facility_id
    ),
    case
      when bool_or(link.status = 'active') over (
        partition by mapping.winner_id, link.facility_id
      ) then 'active'
      else 'inactive'
    end,
    link.created_by,
    link.updated_by,
    min(link.created_at) over (
      partition by mapping.winner_id, link.facility_id
    ),
    max(link.updated_at) over (
      partition by mapping.winner_id, link.facility_id
    )
  from public.nhis_prescriber_facilities link
  join nhis_prescriber_duplicate_map mapping
    on mapping.duplicate_id = link.prescriber_id
  order by
    mapping.winner_id,
    link.facility_id,
    (link.status = 'active') desc,
    link.updated_at desc,
    link.id
  on conflict (prescriber_id, facility_id) do update
    set is_primary = public.nhis_prescriber_facilities.is_primary or excluded.is_primary,
        status = case
          when public.nhis_prescriber_facilities.status = 'active' or excluded.status = 'active'
            then 'active'
          else public.nhis_prescriber_facilities.status
        end,
        updated_at = greatest(public.nhis_prescriber_facilities.updated_at, excluded.updated_at);

  delete from public.nhis_prescribers prescriber
  using nhis_prescriber_duplicate_map mapping
  where prescriber.id = mapping.duplicate_id;
end;
$$;

comment on function public.normalize_nhis_prescriber_identity(text) is
  'Normalizes deterministic title, punctuation, case and whitespace variants for NHIS prescriber matching; it does not perform fuzzy spelling correction.';

notify pgrst, 'reload schema';
