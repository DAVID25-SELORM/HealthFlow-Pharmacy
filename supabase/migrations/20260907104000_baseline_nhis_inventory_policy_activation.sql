-- Preserve the long-standing stock-neutral NHIS history when an organization
-- opts into inventory deduction.  The activation snapshot is a baseline, not
-- a stock movement: only quantities above it can be deducted subsequently.

create table if not exists public.nhis_inventory_policy_activations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  enabled_at timestamptz not null default now(),
  enabled_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_nhis_inventory_policy_activations_org_enabled
  on public.nhis_inventory_policy_activations (organization_id, enabled_at desc);

create table if not exists public.nhis_inventory_policy_activation_baselines (
  activation_id uuid not null references public.nhis_inventory_policy_activations(id) on delete restrict,
  claim_id uuid not null references public.nhis_claims(id) on delete restrict,
  claim_medicine_key text not null,
  served_quantity numeric not null check (served_quantity > 0),
  primary key (activation_id, claim_id, claim_medicine_key)
);

alter table public.nhis_inventory_policy_activations enable row level security;
alter table public.nhis_inventory_policy_activation_baselines enable row level security;
revoke all on public.nhis_inventory_policy_activations,
  public.nhis_inventory_policy_activation_baselines from public, anon, authenticated;

create or replace function public.guard_nhis_inventory_policy_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activation_id uuid;
begin
  if new.nhis_deduct_inventory_on_serve is not distinct from old.nhis_deduct_inventory_on_serve then
    return new;
  end if;

  if not exists (
    select 1 from public.users actor
    where actor.id = auth.uid() and actor.organization_id = new.organization_id
      and actor.is_active is distinct from false
      and (actor.role in ('admin', 'super_admin')
        or coalesce(actor.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[])
  ) then
    raise exception 'Only an active administrator can change the NHIS inventory policy.' using errcode = '42501';
  end if;

  if new.nhis_deduct_inventory_on_serve and exists (
    select 1 from public.branch_sync_clients client
    where client.organization_id = new.organization_id and client.is_active
      and coalesce(client.nhis_inventory_protocol_version, 0) < 1
  ) then
    raise exception 'Update every active branch server before enabling NHIS inventory deduction.' using errcode = '55000';
  end if;

  if new.nhis_deduct_inventory_on_serve then
    insert into public.nhis_inventory_policy_activations (organization_id, enabled_by)
    values (new.organization_id, auth.uid())
    returning id into v_activation_id;

    insert into public.nhis_inventory_policy_activation_baselines (
      activation_id, claim_id, claim_medicine_key, served_quantity
    )
    select
      v_activation_id,
      claim.id,
      coalesce(nullif(medicine.nhis_drug_id::text, ''), upper(nullif(btrim(medicine.drug_code), ''))),
      sum(medicine.served_qty)
    from public.nhis_claims claim
    join public.nhis_claim_medicines medicine on medicine.claim_id = claim.id
    where claim.organization_id = new.organization_id
      and coalesce(medicine.served_qty, 0) > 0
      and coalesce(nullif(medicine.nhis_drug_id::text, ''), upper(nullif(btrim(medicine.drug_code), ''))) is not null
    group by claim.id, coalesce(nullif(medicine.nhis_drug_id::text, ''), upper(nullif(btrim(medicine.drug_code), '')));
  end if;

  perform public.log_audit_event(
    'settings.nhis_inventory_policy_changed', 'pharmacy_settings', new.id, 'update',
    jsonb_build_object(
      'organization_id', new.organization_id,
      'previous_value', old.nhis_deduct_inventory_on_serve,
      'new_value', new.nhis_deduct_inventory_on_serve,
      'activation_id', v_activation_id
    ), new.organization_id
  );
  return new;
end;
$$;

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
  v_activation_id uuid;
  v_line record;
  v_drug public.drugs%rowtype;
  v_required numeric;
  v_applied numeric;
  v_baseline numeric;
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
  if auth.uid() is not null and v_claim.organization_id is distinct from public.user_organization_id() then
    raise exception 'NHIS claim is outside your organization.' using errcode = '42501';
  end if;

  select coalesce(nhis_deduct_inventory_on_serve, false) into v_enabled
  from public.pharmacy_settings where organization_id = v_claim.organization_id
  order by updated_at desc limit 1;

  select id into v_activation_id from public.nhis_inventory_policy_activations
  where organization_id = v_claim.organization_id
  order by enabled_at desc, id desc limit 1;

  select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb)::text)
  into v_payload_hash from public.nhis_claim_medicines m where m.claim_id = v_claim.id;

  insert into public.nhis_serving_events (
    organization_id, branch_id, claim_id, idempotency_key, source, actor_user_id, payload_hash
  ) values (
    v_claim.organization_id, v_claim.branch_id, v_claim.id, p_idempotency_key,
    p_source, auth.uid(), coalesce(v_payload_hash, md5('[]'))
  ) on conflict (organization_id, idempotency_key) do nothing returning id into v_event_id;

  if v_event_id is null then
    select id into v_existing_event from public.nhis_serving_events
    where organization_id = v_claim.organization_id and idempotency_key = p_idempotency_key;
    return jsonb_build_object('event_id', v_existing_event, 'deducted', false, 'idempotent_replay', true);
  end if;
  if not coalesce(v_enabled, false) then
    return jsonb_build_object('event_id', v_event_id, 'deducted', false, 'inventory_policy', 'off');
  end if;

  for v_line in
    select
      coalesce(nullif(m.nhis_drug_id::text, ''), upper(nullif(btrim(m.drug_code), ''))) as medicine_key,
      max(m.drug_code) as drug_code,
      max(m.description) as description,
      sum(m.served_qty) as served_qty
    from public.nhis_claim_medicines m
    where m.claim_id = v_claim.id and coalesce(m.served_qty, 0) > 0
    group by coalesce(nullif(m.nhis_drug_id::text, ''), upper(nullif(btrim(m.drug_code), '')))
  loop
    if v_line.medicine_key is null or nullif(btrim(coalesce(v_line.drug_code, '')), '') is null then
      raise exception 'Served medicine % has no authoritative NHIS code.', coalesce(v_line.description, v_line.medicine_key, 'unknown');
    end if;
    v_required := v_line.served_qty;
    select coalesce(sum(-quantity_delta), 0) into v_applied
    from public.nhis_inventory_ledger
    where claim_id = v_claim.id and claim_medicine_key = v_line.medicine_key;
    select coalesce(served_quantity, 0) into v_baseline
    from public.nhis_inventory_policy_activation_baselines
    where activation_id = v_activation_id and claim_id = v_claim.id and claim_medicine_key = v_line.medicine_key;
    v_baseline := coalesce(v_baseline, 0);
    if v_required < v_baseline + v_applied and v_applied > 0 then
      raise exception 'A served NHIS medicine cannot be reduced through ordinary editing after inventory was deducted. Use the controlled correction workflow.' using errcode = '55000';
    end if;
    v_remaining := v_required - v_baseline - v_applied;
    if v_remaining <= 0 then continue; end if;

    for v_drug in
      select * from public.drugs d
      where d.organization_id = v_claim.organization_id and d.status = 'active'
        and upper(coalesce(d.nhis_code, '')) = upper(v_line.drug_code)
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
        v_line.medicine_key, -v_take, 'nhis_dispensing', auth.uid()
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

comment on table public.nhis_inventory_policy_activation_baselines is
  'Served quantities already present when a facility enables NHIS stock deduction; they are never retroactively deducted.';

-- Branch record replication is authenticated by a branch-sync token rather
-- than auth.uid().  Its dedicated completion RPC below is the only branch
-- path allowed to apply a stock effect; otherwise the generic record upsert
-- could bypass the policy-version comparison.
create or replace function public.apply_direct_nhis_inventory_effect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and old.direct_served_at is null and new.direct_served_at is not null then
    perform public.apply_nhis_inventory_serving_effect(
      new.id, concat('direct:', new.id::text), 'cloud_direct_serve'
    );
  end if;
  return new;
end;
$$;

create or replace function public.apply_dispensary_nhis_inventory_effect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and new.status = 'returned_for_review'
     and new.updated_at is distinct from old.updated_at then
    perform public.apply_nhis_inventory_serving_effect(
      new.id, concat('dispensary:', new.id::text, ':', new.updated_at::text), 'cloud_serve'
    );
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
