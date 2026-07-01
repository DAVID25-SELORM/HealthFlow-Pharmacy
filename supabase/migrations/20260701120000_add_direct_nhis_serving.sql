alter table if exists public.nhis_claims
  add column if not exists direct_served_by uuid references auth.users(id),
  add column if not exists direct_served_at timestamptz;

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
  v_drug public.drugs%rowtype;
  v_quantity numeric;
  v_previous numeric;
  v_new numeric;
  v_remaining numeric;
  v_deduct numeric;
  v_branch_id uuid;
  v_total numeric := 0;
begin
  select * into v_actor from public.users where id = auth.uid();
  select * into v_claim from public.nhis_claims where id = p_claim_id for update;
  if v_claim.id is null then raise exception 'NHIS claim not found.'; end if;
  if v_actor.organization_id is distinct from v_claim.organization_id
    or not (
      v_actor.role in ('admin', 'super_admin', 'claims_officer')
      or coalesce(v_actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin', 'claims_officer']::text[]
    )
  then raise exception 'Only a Claims Officer or administrator can serve this claim directly.'; end if;
  if v_claim.direct_served_at is not null then
    raise exception 'This claim was already served directly. Stock was not deducted again.';
  end if;
  if v_claim.status in ('served', 'partially_served', 'fully_served', 'submitted', 'paid', 'approved', 'accepted') then
    raise exception 'A claim already served or completed cannot be served directly.';
  end if;

  v_branch_id := coalesce(v_claim.branch_id, v_actor.branch_id);
  if not exists (select 1 from public.nhis_claim_medicines where claim_id = v_claim.id) then
    raise exception 'Add at least one medicine before serving directly.';
  end if;

  for v_line in
    select * from public.nhis_claim_medicines where claim_id = v_claim.id order by id
  loop
    v_quantity := coalesce(nullif(v_line.prescribed_qty, 0), nullif(v_line.dispensed_qty, 0), 0);
    if v_quantity <= 0 then
      raise exception 'Every directly served medicine requires a quantity greater than zero.';
    end if;

    v_remaining := v_quantity;
    for v_drug in
      select d.*
      from public.drugs d
      where d.organization_id = v_claim.organization_id
        and d.status = 'active'
        and coalesce(d.quantity, 0) > 0
        and upper(coalesce(d.nhis_code, '')) = upper(coalesce(v_line.drug_code, ''))
        and (v_branch_id is null or d.branch_id = v_branch_id or d.branch_id is null)
      order by
        case when d.branch_id = v_branch_id then 0 else 1 end,
        d.expiry_date nulls last,
        d.created_at
      for update
    loop
      v_previous := coalesce(v_drug.quantity, 0);
      v_deduct := least(v_previous, v_remaining);
      v_new := v_previous - v_deduct;
      update public.drugs set quantity = v_new, updated_at = now() where id = v_drug.id;
      insert into public.stock_movements (
        drug_id, movement_type, quantity, previous_quantity, new_quantity,
        reference_id, notes, created_by, organization_id, branch_id, created_at
      ) values (
        v_drug.id, 'sale', -v_deduct, v_previous, v_new,
        v_claim.id, 'NHIS claim served directly by Claims Officer',
        auth.uid(), v_claim.organization_id, v_drug.branch_id, now()
      );
      v_remaining := v_remaining - v_deduct;
      exit when v_remaining <= 0;
    end loop;
    if v_remaining > 0 then
      raise exception 'Insufficient stock for %. Required: %, short by: %.',
        coalesce(v_line.description, v_line.drug_code), v_quantity, v_remaining;
    end if;

    update public.nhis_claim_medicines
    set served_qty = v_quantity,
        dispensed_qty = v_quantity,
        serving_status = 'fully_served',
        served_at = now(),
        total_amount = coalesce(unit_price, 0) * v_quantity
    where id = v_line.id;
    v_total := v_total + (coalesce(v_line.unit_price, 0) * v_quantity);
  end loop;

  update public.nhis_claims
  set status = 'served',
      serving_status = 'fully_served',
      serving_reviewed_by = auth.uid(),
      serving_reviewed_at = now(),
      direct_served_by = auth.uid(),
      direct_served_at = now(),
      total_amount = v_total,
      updated_at = now()
  where id = v_claim.id;

  return jsonb_build_object(
    'id', v_claim.id,
    'claim_number', v_claim.claim_number,
    'status', 'served',
    'total_amount', v_total,
    'direct_served_by', auth.uid(),
    'direct_served_at', now()
  );
end;
$$;

revoke all on function public.serve_nhis_claim_direct(uuid) from public;
grant execute on function public.serve_nhis_claim_direct(uuid) to authenticated;
