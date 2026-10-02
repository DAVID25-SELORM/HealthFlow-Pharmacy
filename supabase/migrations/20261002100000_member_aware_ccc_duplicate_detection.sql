-- Replace the facility/code-only guard with member + CCC + service-day protection.
-- CCC is externally issued; matching CCC values never establish patient identity.
-- No rows are deleted or rewritten. Index creation deliberately fails if historical
-- active duplicates need resolution before rollout; do not silently discard claims.
begin;

create or replace function public.nhis_duplicate_identity(p_member text, p_hin text, p_patient uuid)
returns text language sql immutable parallel safe set search_path = public, pg_catalog as $$
  select coalesce(
    'member:' || nullif(regexp_replace(coalesce(p_member, ''), '[^0-9]', '', 'g'), ''),
    'member:' || nullif(regexp_replace(coalesce(p_hin, ''), '[^0-9]', '', 'g'), ''),
    'patient:' || p_patient::text
  );
$$;

create unique index if not exists nhis_claims_member_ccc_duplicate_idx on public.nhis_claims (
  organization_id,
  (public.nhis_duplicate_identity(member_no, hin, patient_id)),
  (regexp_replace(coalesce(ccc_no, ''), '[^0-9]', '', 'g')),
  service_date_from
) where lower(trim(coalesce(status, ''))) not in ('rejected', 'failed', 'cancelled', 'canceled', 'voided')
  and public.nhis_duplicate_identity(member_no, hin, patient_id) is not null
  and regexp_replace(coalesce(ccc_no, ''), '[^0-9]', '', 'g') <> ''
  and service_date_from is not null;

create or replace function public.guard_facility_ccc_duplicate()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_code text := regexp_replace(coalesce(new.ccc_no, ''), '[^0-9]', '', 'g');
  v_identity text := public.nhis_duplicate_identity(new.member_no, new.hin, new.patient_id);
  v_conflict record;
begin
  if lower(trim(coalesce(new.status, ''))) in ('rejected', 'failed', 'cancelled', 'canceled', 'voided')
     or v_code = '' or v_identity is null or new.organization_id is null or new.service_date_from is null then
    return new;
  end if;

  select c.id, c.claim_number into v_conflict
  from public.nhis_claims c
  where c.organization_id = new.organization_id
    and c.id is distinct from new.id
    and lower(trim(coalesce(c.status, ''))) not in ('rejected', 'failed', 'cancelled', 'canceled', 'voided')
    and c.service_date_from = new.service_date_from
    and regexp_replace(coalesce(c.ccc_no, ''), '[^0-9]', '', 'g') = v_code
    and public.nhis_duplicate_identity(c.member_no, c.hin, c.patient_id) = v_identity
  limit 1;

  if found then
    raise exception
      'Possible duplicate claim: this patient already has a claim (%) using this CCC/CC code for the same service date. Review the existing claim before continuing.',
      coalesce(v_conflict.claim_number, v_conflict.id::text)
      using errcode = '23505';
  end if;
  return new;
end $$;

-- Preserve existing production wiring, but also install the guard on clean databases.
do $$
begin
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.nhis_claims'::regclass
      and tgfoid = 'public.guard_facility_ccc_duplicate()'::regprocedure and not tgisinternal
  ) then
    create trigger guard_facility_ccc_duplicate before insert or update on public.nhis_claims
      for each row execute function public.guard_facility_ccc_duplicate();
  end if;
end $$;
revoke all on function public.guard_facility_ccc_duplicate() from public, anon, authenticated;

-- Support both candidate lookup branches without a full facility-history scan.
create index if not exists nhis_claims_ccc_review_lookup_idx on public.nhis_claims (
  organization_id, (regexp_replace(coalesce(ccc_no, ''), '[^0-9]', '', 'g'))
);
create index if not exists nhis_claims_member_day_review_lookup_idx on public.nhis_claims (
  organization_id, (public.nhis_duplicate_identity(member_no, hin, patient_id)), service_date_from
);

-- SECURITY INVOKER retains claim/medicine RLS; explicit facility scope also protects
-- users whose read policy permits more than one facility. No names or raw NHIA payloads.
create or replace function public.get_nhis_ccc_duplicate_candidates(
  p_member text, p_patient_id uuid, p_ccc text, p_service_date date,
  p_ignore_id uuid default null, p_offset integer default 0, p_limit integer default 200
) returns setof jsonb language sql stable security invoker
set search_path = public, pg_catalog as $$
  select jsonb_build_object(
    'id', c.id, 'organization_id', c.organization_id, 'patient_id', c.patient_id,
    'claim_number', c.claim_number, 'member_no', c.member_no, 'hin', c.hin,
    'ccc_no', c.ccc_no, 'service_date_from', c.service_date_from,
    'status', c.status, 'total_amount', c.total_amount,
    'medicines', coalesce((select jsonb_agg(m.drug_code order by m.drug_code)
      from public.nhis_claim_medicines m where m.claim_id = c.id), '[]'::jsonb)
  )
  from public.nhis_claims c
  where c.organization_id = public.user_organization_id()
    and c.id is distinct from p_ignore_id
    and (
      (nullif(regexp_replace(coalesce(p_ccc, ''), '[^0-9]', '', 'g'), '') is not null
       and regexp_replace(coalesce(c.ccc_no, ''), '[^0-9]', '', 'g') = regexp_replace(p_ccc, '[^0-9]', '', 'g'))
      or (c.service_date_from = p_service_date
          and public.nhis_duplicate_identity(c.member_no, c.hin, c.patient_id)
            = public.nhis_duplicate_identity(p_member, null, p_patient_id))
    )
  order by c.id
  limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
$$;
revoke all on function public.get_nhis_ccc_duplicate_candidates(text, uuid, text, date, uuid, integer, integer) from public, anon;
grant execute on function public.get_nhis_ccc_duplicate_candidates(text, uuid, text, date, uuid, integer, integer) to authenticated;
commit;
