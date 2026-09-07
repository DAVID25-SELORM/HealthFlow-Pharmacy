-- The existing generic claim correction flow replaces medicine rows.  It has
-- no safe compensating-stock workflow, so prevent it from silently changing a
-- claim after NHIS inventory has been consumed.  The authoritative dispensary
-- serving function is explicitly allowed through this guard for cumulative
-- partial serving; its ledger reconciliation rejects reductions.

create or replace function public.guard_nhis_inventory_medicine_correction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_id uuid := coalesce(new.claim_id, old.claim_id);
begin
  if current_setting('healthflow.nhis_serving_replacement', true) = 'true' then
    return coalesce(new, old);
  end if;
  if exists (select 1 from public.nhis_inventory_ledger where claim_id = v_claim_id) then
    raise exception 'This served claim has an NHIS inventory movement. Use the controlled stock-correction workflow before changing its medicines.' using errcode = '55000';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists guard_nhis_inventory_medicine_correction on public.nhis_claim_medicines;
create trigger guard_nhis_inventory_medicine_correction
before insert or update or delete on public.nhis_claim_medicines
for each row execute function public.guard_nhis_inventory_medicine_correction();

create or replace function public.serve_nhis_claim_medicines(
  p_claim_id uuid,
  p_medicines jsonb,
  p_total_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.nhis_claims%rowtype;
  v_medicine jsonb;
  v_serving_status text := 'not_served';
  v_line_statuses text[] := array[]::text[];
begin
  if not exists (
    select 1 from public.users
    where id = auth.uid() and is_active = true
      and (role in ('admin', 'pharmacist', 'assistant', 'billing', 'claims_officer', 'records_officer')
        or assigned_roles && array['admin', 'pharmacist', 'assistant', 'billing', 'claims_officer', 'records_officer']::text[]
        or can_manage_claims)
  ) then
    raise exception 'You do not have permission to serve NHIS medicines.';
  end if;

  select * into v_claim from public.nhis_claims
  where id = p_claim_id and organization_id = public.user_organization_id()
  for update;
  if not found then raise exception 'NHIS claim not found.'; end if;

  perform set_config('healthflow.nhis_serving_replacement', 'true', true);
  delete from public.nhis_claim_medicines where claim_id = p_claim_id;

  for v_medicine in select value from jsonb_array_elements(coalesce(p_medicines, '[]'::jsonb)) loop
    v_line_statuses := array_append(v_line_statuses, coalesce(nullif(v_medicine->>'serving_status', ''), 'pending'));
    insert into public.nhis_claim_medicines (
      claim_id, nhis_drug_id, drug_code, description, unit, unit_price,
      dispensed_qty, dispensary_date, dose, frequency, duration, total_amount,
      medicine_access_level, required_pharmacy_level, prescribed_qty, served_qty,
      serving_status, reason_if_not_fully_served, entered_by_claims_officer,
      served_by_mca, entered_at, served_at
    ) values (
      p_claim_id, nullif(v_medicine->>'nhis_drug_id', '')::uuid,
      nullif(v_medicine->>'drug_code', ''), coalesce(nullif(v_medicine->>'description', ''), 'Medicine'),
      coalesce(nullif(v_medicine->>'unit', ''), 'unit'), coalesce(nullif(v_medicine->>'unit_price', '')::numeric, 0),
      coalesce(nullif(v_medicine->>'dispensed_qty', '')::numeric, 0), nullif(v_medicine->>'dispensary_date', '')::date,
      nullif(v_medicine->>'dose', ''), nullif(v_medicine->>'frequency', ''), nullif(v_medicine->>'duration', ''),
      coalesce(nullif(v_medicine->>'total_amount', '')::numeric, 0), nullif(v_medicine->>'medicine_access_level', ''),
      nullif(v_medicine->>'required_pharmacy_level', ''),
      coalesce(nullif(v_medicine->>'prescribed_qty', '')::numeric, coalesce(nullif(v_medicine->>'dispensed_qty', '')::numeric, 0)),
      coalesce(nullif(v_medicine->>'served_qty', '')::numeric, coalesce(nullif(v_medicine->>'dispensed_qty', '')::numeric, 0)),
      coalesce(nullif(v_medicine->>'serving_status', ''), 'pending'), nullif(v_medicine->>'reason_if_not_fully_served', ''),
      nullif(v_medicine->>'entered_by_claims_officer', '')::uuid, coalesce(nullif(v_medicine->>'served_by_mca', '')::uuid, auth.uid()),
      coalesce(nullif(v_medicine->>'entered_at', '')::timestamptz, now()), coalesce(nullif(v_medicine->>'served_at', '')::timestamptz, now())
    );
  end loop;

  if array_length(v_line_statuses, 1) is null then
    v_serving_status := 'not_served';
  elsif not exists (select 1 from unnest(v_line_statuses) as line_status(value) where value <> 'fully_served') then
    v_serving_status := 'fully_served';
  elsif exists (select 1 from unnest(v_line_statuses) as line_status(value) where value in ('fully_served', 'partially_served')) then
    v_serving_status := 'partially_served';
  end if;

  update public.nhis_claims
  set total_amount = coalesce(p_total_amount, total_amount), status = 'returned_for_review',
      serving_status = v_serving_status, updated_at = now()
  where id = p_claim_id returning * into v_claim;
  return to_jsonb(v_claim);
end;
$$;

revoke all on function public.guard_nhis_inventory_medicine_correction() from public, anon, authenticated;
revoke all on function public.serve_nhis_claim_medicines(uuid, jsonb, numeric) from public;
grant execute on function public.serve_nhis_claim_medicines(uuid, jsonb, numeric) to authenticated;

comment on function public.guard_nhis_inventory_medicine_correction() is
  'Blocks generic post-deduction claim medicine edits until an audited compensating correction workflow is available.';

notify pgrst, 'reload schema';
