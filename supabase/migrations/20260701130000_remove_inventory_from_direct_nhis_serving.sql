-- NHIS pharmacy serving is a claims workflow, not an inventory transaction.
-- Facilities may serve NHIS medicines without maintaining HealthFlow stock.
-- Keep the direct-serving action transactional and auditable, but do not read
-- from or write to drugs/stock_movements.

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

revoke all on function public.serve_nhis_claim_direct(uuid) from public;
grant execute on function public.serve_nhis_claim_direct(uuid) to authenticated;

comment on function public.serve_nhis_claim_direct(uuid) is
  'Marks an authorized NHIS claim and its medicines fully served without requiring or changing inventory stock.';
