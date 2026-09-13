-- Prospective validation only. No existing clinical durations are rewritten.
begin;
create or replace function public.is_valid_nhis_clinical_duration(p_duration text)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select coalesce(btrim(p_duration) ~ '^1 (day|week|month)$'
    or btrim(p_duration) ~ '^([2-9]|[1-9][0-9]+) (days|weeks|months)$', false);
$$;
create or replace function public.lock_nhis_duration_parent()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  perform 1 from public.nhis_claims where id = new.claim_id for update;
  return new;
end $$;
create trigger lock_nhis_duration_parent before insert or update on public.nhis_claim_medicines
for each row execute function public.lock_nhis_duration_parent();

-- Deferred validation reads the final transaction state, allowing atomic medicine
-- replacement and multi-row corrections without validating an intermediate state.
create or replace function public.guard_nhis_duration_integrity()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_claim_id uuid; v_draft boolean; v_serving boolean;
begin
  if tg_table_name = 'nhis_claims' then v_claim_id := new.id;
  else v_claim_id := new.claim_id; end if;
  select status = 'draft', serving_status in ('fully_served','partially_served')
    into v_draft, v_serving from public.nhis_claims where id = v_claim_id;
  if not found then return null; end if;
  if coalesce(v_draft, false) and not coalesce(v_serving, false)
    and not exists (select 1 from public.nhis_claim_medicines where claim_id = v_claim_id
      and (coalesce(served_qty, 0) > 0 or serving_status in ('fully_served','partially_served')))
    then return null;
  end if;
  if exists (select 1 from public.nhis_claim_medicines where claim_id = v_claim_id
    and not public.is_valid_nhis_clinical_duration(duration)) then
    raise exception 'Valid medicine duration is required before completing or serving this claim. Keep incomplete intake as Draft.' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger guard_nhis_claim_duration_integrity after insert or update on public.nhis_claims
  deferrable initially deferred for each row execute function public.guard_nhis_duration_integrity();
create constraint trigger guard_nhis_medicine_duration_integrity after insert or update on public.nhis_claim_medicines
  deferrable initially deferred for each row execute function public.guard_nhis_duration_integrity();
revoke all on function public.lock_nhis_duration_parent() from public, anon, authenticated;
revoke all on function public.guard_nhis_duration_integrity() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
