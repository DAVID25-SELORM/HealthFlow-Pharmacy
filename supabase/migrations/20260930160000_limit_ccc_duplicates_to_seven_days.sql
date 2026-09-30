-- CCC reuse is allowed once service dates are seven days apart.
-- Keep reservation rows as serialization keys, not permanent ownership.
drop trigger if exists release_facility_ccc_reservation on public.nhis_claims;
create or replace function public.guard_facility_ccc_duplicate()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_code text := regexp_replace(coalesce(new.ccc_no, ''), '[^0-9]', '', 'g');
  v_date date := coalesce(new.service_date_from, (new.created_at at time zone 'Africa/Accra')::date, (now() at time zone 'Africa/Accra')::date);
begin
  if tg_op = 'UPDATE' and new.organization_id is not distinct from old.organization_id
    and v_code = regexp_replace(coalesce(old.ccc_no, ''), '[^0-9]', '', 'g')
    and v_date = coalesce(old.service_date_from, (old.created_at at time zone 'Africa/Accra')::date, (now() at time zone 'Africa/Accra')::date) then
    return new;
  end if;
  if v_code = '' or new.organization_id is null then return new; end if;
  -- Concurrent assignments to this facility/code wait on the same unique row.
  insert into public.nhis_ccc_reservations as r (organization_id, ccc, claim_id)
    values (new.organization_id, v_code, new.id)
    on conflict (organization_id, ccc) do update set claim_id = r.claim_id;
  if exists (
    select 1 from public.nhis_claims c where c.organization_id = new.organization_id
      and c.id <> new.id
      and regexp_replace(coalesce(c.ccc_no, ''), '[^0-9]', '', 'g') = v_code
      and coalesce(c.service_date_from, (c.created_at at time zone 'Africa/Accra')::date)
        between v_date - 6 and v_date + 6
  ) then
    raise exception 'This CCC code is already used by another claim in this facility within 7 days of the service date.' using errcode = '23505';
  end if;
  return new;
end $$;
revoke all on function public.guard_facility_ccc_duplicate() from public, anon, authenticated;
