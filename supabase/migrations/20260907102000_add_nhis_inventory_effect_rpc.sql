-- Shared stock-effect primitive. Serving flows call this inside their own
-- transaction after the claim medicine rows have been validated and locked.

alter table public.stock_movements
  add column if not exists source_type text;

create index if not exists idx_stock_movements_source_type_created
  on public.stock_movements (organization_id, source_type, created_at desc);

create or replace function public.apply_nhis_inventory_serving_effect(
  p_claim_id uuid,
  p_idempotency_key text,
  p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.nhis_claims%rowtype;
  v_event_id uuid;
  v_existing_event uuid;
  v_enabled boolean := false;
  v_line record;
  v_drug public.drugs%rowtype;
  v_key text;
  v_required numeric;
  v_applied numeric;
  v_remaining numeric;
  v_take numeric;
  v_previous numeric;
  v_payload_hash text;
begin
  if p_source not in ('cloud_serve', 'cloud_direct_serve', 'branch_offline_sync') then
    raise exception 'Invalid NHIS serving source.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception 'NHIS serving idempotency key is required.' using errcode = '22023';
  end if;

  select * into v_claim from public.nhis_claims where id = p_claim_id for update;
  if not found then raise exception 'NHIS claim not found.' using errcode = 'P0002'; end if;
  if auth.uid() is not null
     and v_claim.organization_id is distinct from public.user_organization_id() then
    raise exception 'NHIS claim is outside your organization.' using errcode = '42501';
  end if;

  select coalesce(nhis_deduct_inventory_on_serve, false)
  into v_enabled
  from public.pharmacy_settings
  where organization_id = v_claim.organization_id
  order by updated_at desc
  limit 1;

  select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb)::text)
  into v_payload_hash
  from public.nhis_claim_medicines m where m.claim_id = v_claim.id;

  insert into public.nhis_serving_events (
    organization_id, branch_id, claim_id, idempotency_key, source, actor_user_id, payload_hash
  ) values (
    v_claim.organization_id, v_claim.branch_id, v_claim.id, p_idempotency_key,
    p_source, auth.uid(), coalesce(v_payload_hash, md5('[]'))
  ) on conflict (organization_id, idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select id into v_existing_event from public.nhis_serving_events
    where organization_id = v_claim.organization_id and idempotency_key = p_idempotency_key;
    return jsonb_build_object('event_id', v_existing_event, 'deducted', false, 'idempotent_replay', true);
  end if;

  if not coalesce(v_enabled, false) then
    return jsonb_build_object('event_id', v_event_id, 'deducted', false, 'inventory_policy', 'off');
  end if;

  for v_line in
    select id, drug_code, nhis_drug_id, description, served_qty
    from public.nhis_claim_medicines
    where claim_id = v_claim.id and coalesce(served_qty, 0) > 0
    order by id
  loop
    v_key := coalesce(nullif(v_line.nhis_drug_id::text, ''), upper(nullif(btrim(v_line.drug_code), '')));
    if v_key is null then
      raise exception 'Served medicine % has no authoritative NHIS code.', coalesce(v_line.description, v_line.id::text);
    end if;
    v_required := v_line.served_qty;
    select coalesce(sum(-quantity_delta), 0) into v_applied
    from public.nhis_inventory_ledger
    where claim_id = v_claim.id and claim_medicine_key = v_key;
    if v_required < v_applied then
      raise exception 'A served NHIS medicine cannot be reduced through ordinary editing after inventory was deducted. Use the controlled correction workflow.' using errcode = '55000';
    end if;
    v_remaining := v_required - v_applied;
    if v_remaining <= 0 then continue; end if;

    for v_drug in
      select * from public.drugs d
      where d.organization_id = v_claim.organization_id
        and d.status = 'active'
        and upper(coalesce(d.nhis_code, '')) = upper(coalesce(v_line.drug_code, ''))
        and (v_claim.branch_id is null or d.branch_id = v_claim.branch_id or d.branch_id is null)
        and coalesce(d.quantity, 0) > 0
      order by case when d.branch_id = v_claim.branch_id then 0 else 1 end, d.expiry_date nulls last, d.created_at
      for update
    loop
      v_previous := coalesce(v_drug.quantity, 0);
      v_take := least(v_previous, v_remaining);
      update public.drugs set quantity = v_previous - v_take, updated_at = now() where id = v_drug.id;
      insert into public.stock_movements (
        drug_id, movement_type, source_type, quantity, previous_quantity, new_quantity,
        reference_id, notes, created_by, organization_id, branch_id, created_at
      ) values (
        v_drug.id, 'sale', 'nhis_dispensing', -v_take, v_previous, v_previous - v_take,
        v_claim.id, concat('NHIS Dispensing: ', coalesce(v_claim.claim_number, v_claim.id::text)),
        auth.uid(), v_claim.organization_id, v_drug.branch_id, now()
      );
      insert into public.nhis_inventory_ledger (
        organization_id, branch_id, claim_id, serving_event_id, inventory_drug_id,
        claim_medicine_key, quantity_delta, movement_type, actor_user_id
      ) values (
        v_claim.organization_id, v_drug.branch_id, v_claim.id, v_event_id, v_drug.id,
        v_key, -v_take, 'nhis_dispensing', auth.uid()
      );
      v_remaining := v_remaining - v_take;
      exit when v_remaining <= 0;
    end loop;
    if v_remaining > 0 then
      raise exception 'Insufficient stock for %. Required additional quantity: %.', coalesce(v_line.description, v_line.drug_code), v_remaining;
    end if;
  end loop;
  return jsonb_build_object('event_id', v_event_id, 'deducted', true, 'idempotent_replay', false);
end;
$$;

revoke all on function public.apply_nhis_inventory_serving_effect(uuid, text, text) from public, anon, authenticated;

comment on function public.apply_nhis_inventory_serving_effect(uuid, text, text) is
  'Atomic, idempotent stock effect for a locked NHIS claim. OFF policy records only the serving event.';

-- Both existing server-side serving flows finish by updating the claim. These
-- narrowly scoped triggers converge them on the same stock primitive without
-- adding a browser-side deduction path. Repeated saves can create an audit
-- event, but the ledger is reconciled cumulatively and cannot deduct twice.
create or replace function public.apply_direct_nhis_inventory_effect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.direct_served_at is null and new.direct_served_at is not null then
    perform public.apply_nhis_inventory_serving_effect(
      new.id,
      concat('direct:', new.id::text),
      'cloud_direct_serve'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists apply_direct_nhis_inventory_effect on public.nhis_claims;
create trigger apply_direct_nhis_inventory_effect
after update of direct_served_at on public.nhis_claims
for each row execute function public.apply_direct_nhis_inventory_effect();

create or replace function public.apply_dispensary_nhis_inventory_effect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'returned_for_review'
     and new.updated_at is distinct from old.updated_at then
    perform public.apply_nhis_inventory_serving_effect(
      new.id,
      concat('dispensary:', new.id::text, ':', new.updated_at::text),
      'cloud_serve'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists apply_dispensary_nhis_inventory_effect on public.nhis_claims;
create trigger apply_dispensary_nhis_inventory_effect
after update of serving_status, updated_at on public.nhis_claims
for each row execute function public.apply_dispensary_nhis_inventory_effect();

create or replace function public.branch_sync_complete_nhis_serving(
  p_sync_token text,
  p_local_event_id uuid,
  p_claim_id uuid,
  p_policy_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
set row_security = off
as $$
declare
  v_client public.branch_sync_clients%rowtype;
  v_claim public.nhis_claims%rowtype;
  v_existing public.branch_sync_events%rowtype;
  v_result jsonb;
  v_cloud_policy boolean := false;
begin
  if p_local_event_id is null or p_claim_id is null then
    raise exception 'Offline NHIS serving event and claim IDs are required.' using errcode = '22023';
  end if;
  v_client := public.get_branch_sync_client(p_sync_token);
  select * into v_existing from public.branch_sync_events
  where sync_client_id = v_client.id
    and event_type = 'nhis.serving.completed'
    and local_id = p_local_event_id;
  if found then return v_existing.response; end if;
  select * into v_claim from public.nhis_claims
  where id = p_claim_id and organization_id = v_client.organization_id
    and (branch_id is null or branch_id = v_client.branch_id)
  for update;
  if not found then raise exception 'Branch NHIS claim was not found.' using errcode = 'P0002'; end if;
  select coalesce(nhis_deduct_inventory_on_serve, false) into v_cloud_policy
  from public.pharmacy_settings where organization_id = v_client.organization_id
  order by updated_at desc limit 1;
  if coalesce(p_policy_enabled, false) is distinct from coalesce(v_cloud_policy, false) then
    raise exception 'Branch NHIS inventory policy is stale. Refresh the branch configuration and reconcile inventory before retrying.' using errcode = '55000';
  end if;
  v_result := public.apply_nhis_inventory_serving_effect(
    v_claim.id,
    concat('branch:', v_client.id::text, ':', p_local_event_id::text),
    'branch_offline_sync'
  );
  insert into public.branch_sync_events (
    sync_client_id, event_type, local_id, remote_id, remote_number, response
  ) values (
    v_client.id, 'nhis.serving.completed', p_local_event_id, v_claim.id,
    v_claim.claim_number, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.branch_sync_complete_nhis_serving(text, uuid, uuid, boolean) from public;
grant execute on function public.branch_sync_complete_nhis_serving(text, uuid, uuid, boolean) to anon, authenticated;

notify pgrst, 'reload schema';
