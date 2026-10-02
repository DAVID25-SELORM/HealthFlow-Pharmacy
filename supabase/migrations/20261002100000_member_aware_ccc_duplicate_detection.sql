-- Stop the database from rejecting claims on a shared CCC, and add member-aware review lookups.
-- CCC is externally issued per NHIA visit; matching CCC values never establish patient identity,
-- and one visit code can cover several prescriptions (each its own claim with its own total).
-- Duplicate review and the exact-repeat block now live in the application classifier.
-- No rows are deleted or rewritten.
begin;

create or replace function public.nhis_duplicate_identity(p_member text, p_hin text, p_patient uuid)
returns text language sql immutable parallel safe set search_path = public, pg_catalog as $$
  select coalesce(
    'member:' || nullif(regexp_replace(coalesce(p_member, ''), '[^0-9]', '', 'g'), ''),
    'member:' || nullif(regexp_replace(coalesce(p_hin, ''), '[^0-9]', '', 'g'), ''),
    'patient:' || p_patient::text
  );
$$;

-- Never created in production; dropped only so an earlier draft of this migration cannot leave a stricter index behind.
drop index if exists public.nhis_claims_member_ccc_duplicate_idx;

-- Replaces the facility-wide "same CCC within 7 days" rejection (live in production, not in repository history).
-- The existing trigger wiring is kept; the function simply no longer raises.
create or replace function public.guard_facility_ccc_duplicate()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin
  return new;
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
