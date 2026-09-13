-- Follow-up to the already applied original duration migration.
-- Replace function bodies only; preserve existing triggers and clinical records.
begin;
create or replace function public.guard_nhis_duration_integrity()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_claim_id uuid; v_draft boolean; v_serving boolean;
begin
  if tg_table_name = 'nhis_claims' then
    -- Metadata corrections do not constitute another serving/export transition.
    if tg_op = 'UPDATE' and new.status is not distinct from old.status
      and new.serving_status is not distinct from old.serving_status then return null; end if;
    v_claim_id := new.id;
  else
    v_claim_id := new.claim_id;
    -- A valid individual correction must remain possible while other legacy
    -- lines await review. Unchanged invalid directions may be retained only
    -- when this update does not add serving or move the line to another claim.
    if tg_op = 'UPDATE' and new.claim_id = old.claim_id
      and new.served_qty is not distinct from old.served_qty
      and new.serving_status is not distinct from old.serving_status then
      if public.is_valid_nhis_clinical_duration(new.duration)
        or new.duration is not distinct from old.duration then return null; end if;
    end if;
  end if;
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
create or replace function public.guard_nhis_ccc_claim_progress()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status
    and new.serving_status is not distinct from old.serving_status
    and new.ccc_no is not distinct from old.ccc_no then return new; end if;
  if new.status in ('served','claim_ready','partially_served','fully_served','submitted','approved','accepted','paid')
    or new.serving_status in ('fully_served','partially_served') then
    perform public.assert_nhis_ccc_for_progress(new.ccc_no);
  end if;
  return new;
end $$;
create or replace function public.guard_nhis_ccc_medicine_serving()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_ccc text;
begin
  if tg_op = 'UPDATE' and new.claim_id = old.claim_id
    and new.served_qty is not distinct from old.served_qty
    and new.serving_status is not distinct from old.serving_status then return new; end if;
  if coalesce(new.served_qty,0)>0 or new.serving_status in ('fully_served','partially_served') then
    select ccc_no into v_ccc from public.nhis_claims where id=new.claim_id for update;
    perform public.assert_nhis_ccc_for_progress(v_ccc);
  end if;
  return new;
end $$;
revoke all on function public.guard_nhis_duration_integrity() from public, anon, authenticated;
revoke all on function public.guard_nhis_ccc_claim_progress() from public, anon, authenticated;
revoke all on function public.guard_nhis_ccc_medicine_serving() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
