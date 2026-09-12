-- Prospective enforcement only: no historical claims are rewritten.
begin;
create or replace function public.assert_nhis_ccc_for_progress(p_ccc text)
returns void language plpgsql immutable set search_path = public, pg_catalog as $$
begin
  if regexp_replace(coalesce(p_ccc, ''), '[^0-9]', '', 'g') !~ '^[0-9]{5}$' then
    raise exception 'CCC/CC code must contain exactly 5 digits before completing or serving this NHIS claim.' using errcode = '23514';
  end if;
end $$;
create or replace function public.guard_nhis_ccc_claim_progress()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin
  if new.status in ('served','claim_ready','partially_served','fully_served','submitted','approved','accepted','paid')
     or new.serving_status in ('fully_served','partially_served') then
    perform public.assert_nhis_ccc_for_progress(new.ccc_no);
  end if;
  return new;
end $$;
create trigger guard_nhis_ccc_claim_progress before insert or update on public.nhis_claims
for each row execute function public.guard_nhis_ccc_claim_progress();
create or replace function public.guard_nhis_ccc_medicine_serving()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_ccc text;
begin
  if coalesce(new.served_qty, 0) > 0 or new.serving_status in ('fully_served','partially_served') then
    -- Serialize against concurrent CCC edits. Existing caller authorization/RLS remains in force.
    select ccc_no into v_ccc from public.nhis_claims where id = new.claim_id for update;
    perform public.assert_nhis_ccc_for_progress(v_ccc);
  end if;
  return new;
end $$;
create trigger guard_nhis_ccc_medicine_serving before insert or update on public.nhis_claim_medicines
for each row execute function public.guard_nhis_ccc_medicine_serving();
revoke all on function public.assert_nhis_ccc_for_progress(text) from public, anon;
grant execute on function public.assert_nhis_ccc_for_progress(text) to authenticated, service_role;
revoke all on function public.guard_nhis_ccc_claim_progress() from public, anon, authenticated;
revoke all on function public.guard_nhis_ccc_medicine_serving() from public, anon, authenticated;

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

  perform public.assert_nhis_ccc_for_progress(v_claim.ccc_no);

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

create or replace function public.serve_nhis_claim_direct(p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.nhis_claims%rowtype;
  v_actor public.users%rowtype;
  v_line public.nhis_claim_medicines%rowtype;
  v_quantity numeric;
  v_total numeric := 0;
  v_served_at timestamptz := now();
begin
  select *
  into v_actor
  from public.users
  where id = auth.uid();

  select *
  into v_claim
  from public.nhis_claims
  where id = p_claim_id
  for update;

  if v_claim.id is null then
    raise exception 'NHIS claim not found.';
  end if;

  if v_actor.organization_id is distinct from v_claim.organization_id
    or not (
      v_actor.role in ('admin', 'super_admin', 'claims_officer')
      or coalesce(v_actor.assigned_roles, '{}'::text[])
        && array['admin', 'super_admin', 'claims_officer']::text[]
    )
  then
    raise exception 'Only a Claims Officer or administrator can serve this claim directly.';
  end if;

  if v_claim.direct_served_at is not null then
    raise exception 'This claim was already served directly.';
  end if;

  perform public.assert_nhis_ccc_for_progress(v_claim.ccc_no);

  if v_claim.status in (
    'served',
    'partially_served',
    'fully_served',
    'submitted',
    'paid',
    'approved',
    'accepted'
  ) then
    raise exception 'A claim already served or completed cannot be served directly.';
  end if;

  if not exists (
    select 1
    from public.nhis_claim_medicines
    where claim_id = v_claim.id
  ) then
    raise exception 'Add at least one medicine before serving directly.';
  end if;

  for v_line in
    select *
    from public.nhis_claim_medicines
    where claim_id = v_claim.id
    order by id
  loop
    v_quantity := coalesce(
      nullif(v_line.prescribed_qty, 0),
      nullif(v_line.dispensed_qty, 0),
      0
    );

    if v_quantity <= 0 then
      raise exception 'Every directly served medicine requires a quantity greater than zero.';
    end if;

    update public.nhis_claim_medicines
    set served_qty = v_quantity,
        dispensed_qty = v_quantity,
        serving_status = 'fully_served',
        served_at = v_served_at,
        total_amount = coalesce(unit_price, 0) * v_quantity
    where id = v_line.id;

    v_total := v_total + (coalesce(v_line.unit_price, 0) * v_quantity);
  end loop;

  update public.nhis_claims
  set status = 'served',
      serving_status = 'fully_served',
      serving_reviewed_by = auth.uid(),
      serving_reviewed_at = v_served_at,
      direct_served_by = auth.uid(),
      direct_served_at = v_served_at,
      total_amount = v_total,
      updated_at = v_served_at
  where id = v_claim.id;

  return jsonb_build_object(
    'id', v_claim.id,
    'claim_number', v_claim.claim_number,
    'status', 'served',
    'serving_status', 'fully_served',
    'total_amount', v_total,
    'direct_served_by', auth.uid(),
    'direct_served_at', v_served_at
  );
end;
$$;

notify pgrst, 'reload schema';
commit;
