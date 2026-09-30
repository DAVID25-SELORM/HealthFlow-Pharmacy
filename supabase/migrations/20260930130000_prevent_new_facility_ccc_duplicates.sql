-- Preserve historical duplicates; reject new CCC assignments across facility branches.
create table public.nhis_ccc_reservations (
  organization_id uuid not null,
  ccc text not null,
  claim_id uuid not null,
  primary key (organization_id, ccc)
);
alter table public.nhis_ccc_reservations enable row level security;
revoke all on public.nhis_ccc_reservations from public, anon, authenticated;

create or replace function public.guard_facility_ccc_duplicate()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_code text := regexp_replace(coalesce(new.ccc_no, ''), '[^0-9]', '', 'g');
  v_owner uuid;
begin
  if tg_op = 'UPDATE' and new.organization_id is not distinct from old.organization_id
    and v_code = regexp_replace(coalesce(old.ccc_no, ''), '[^0-9]', '', 'g') then
    return new;
  end if;
  if v_code = '' or new.organization_id is null then return new; end if;
  -- The unique reservation serializes simultaneous assignments to the same code.
  insert into public.nhis_ccc_reservations as r (organization_id, ccc, claim_id)
    values (new.organization_id, v_code, new.id)
    on conflict (organization_id, ccc) do update set claim_id = r.claim_id
    returning claim_id into v_owner;
  if v_owner <> new.id or exists (
    select 1 from public.nhis_claims c where c.organization_id = new.organization_id
      and c.id <> new.id and regexp_replace(coalesce(c.ccc_no, ''), '[^0-9]', '', 'g') = v_code
  ) then
    raise exception 'This CCC code is already used by another claim in this facility.' using errcode = '23505';
  end if;
  return new;
end $$;
create or replace function public.release_facility_ccc_reservation()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if tg_op = 'DELETE' then
    delete from public.nhis_ccc_reservations where claim_id = old.id;
  else
    delete from public.nhis_ccc_reservations where claim_id = old.id
      and (organization_id is distinct from new.organization_id
        or ccc <> regexp_replace(coalesce(new.ccc_no, ''), '[^0-9]', '', 'g'));
  end if;
  return null;
end $$;
create index if not exists nhis_claims_facility_normalized_ccc_idx on public.nhis_claims
  (organization_id, (regexp_replace(coalesce(ccc_no, ''), '[^0-9]', '', 'g')));
create trigger guard_facility_ccc_duplicate before insert or update on public.nhis_claims
  for each row execute function public.guard_facility_ccc_duplicate();
create trigger release_facility_ccc_reservation after update or delete on public.nhis_claims
  for each row execute function public.release_facility_ccc_reservation();
revoke all on function public.guard_facility_ccc_duplicate() from public, anon, authenticated;
revoke all on function public.release_facility_ccc_reservation() from public, anon, authenticated;
