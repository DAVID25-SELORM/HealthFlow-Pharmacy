-- Keep stock history independently of the live claim and its Recycle Bin entry.
-- No historic ledger/event/baseline rows are removed, including after permanent deletion.
begin;
set local lock_timeout = '5s';
-- Prevent inserts between identity backfill and trigger installation.
lock table public.nhis_claims in share row exclusive mode;

create table public.nhis_inventory_claim_references (
  claim_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict
);
alter table public.nhis_inventory_claim_references enable row level security;
revoke all on public.nhis_inventory_claim_references from public, anon, authenticated;
insert into public.nhis_inventory_claim_references select id, organization_id from public.nhis_claims;

create function public.retain_nhis_inventory_claim_reference() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  insert into public.nhis_inventory_claim_references values (new.id, new.organization_id)
    on conflict (claim_id) do nothing;
  if not exists (select 1 from public.nhis_inventory_claim_references
      where claim_id = new.id and organization_id = new.organization_id) then
    raise exception 'The claim inventory identity belongs to another organization.';
  end if;
  return new;
end;
$$;
revoke all on function public.retain_nhis_inventory_claim_reference() from public, anon, authenticated;
create trigger retain_nhis_inventory_claim_reference before insert or update of organization_id
on public.nhis_claims for each row execute function public.retain_nhis_inventory_claim_reference();

alter table public.nhis_serving_events drop constraint nhis_serving_events_claim_id_fkey,
  add constraint nhis_serving_events_claim_id_fkey foreign key (claim_id)
    references public.nhis_inventory_claim_references(claim_id) on delete restrict;
alter table public.nhis_inventory_ledger drop constraint nhis_inventory_ledger_claim_id_fkey,
  add constraint nhis_inventory_ledger_claim_id_fkey foreign key (claim_id)
    references public.nhis_inventory_claim_references(claim_id) on delete restrict;
alter table public.nhis_inventory_policy_activation_baselines
  drop constraint nhis_inventory_policy_activation_baselines_claim_id_fkey,
  add constraint nhis_inventory_policy_activation_baselines_claim_id_fkey foreign key (claim_id)
    references public.nhis_inventory_claim_references(claim_id) on delete restrict;
alter table public.nhis_serving_events drop constraint nhis_serving_events_source_check,
  add constraint nhis_serving_events_source_check check (source in
    ('cloud_serve', 'cloud_direct_serve', 'branch_offline_sync', 'claim_recycle', 'claim_restore'));

-- Private helper: callers hold the claim/bin row lock and have checked authorization.
-- Recycle compensates the NET amount per original batch and medicine key, not served_qty.
-- Restore reverses exactly that recycle event, even if the inventory policy changed.
create function public.apply_nhis_recycle_stock(p_claim_id uuid, p_recycle_event uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_claim public.nhis_claims%rowtype;
  v_event uuid := gen_random_uuid();
  v_line record;
  v_drug public.drugs%rowtype;
  v_delta numeric;
  v_activation uuid;
begin
  select * into strict v_claim from public.nhis_claims where id = p_claim_id for update;
  if p_recycle_event is not null then
    -- Serialize baseline reconstruction with policy activation snapshots.
    perform 1 from public.facility_settings where organization_id = v_claim.organization_id for share;
  end if;
  if p_recycle_event is not null and not exists (
    select 1 from public.nhis_serving_events where id = p_recycle_event
      and claim_id = p_claim_id and organization_id = v_claim.organization_id and source = 'claim_recycle'
  ) then raise exception 'Invalid claim stock reversal reference.'; end if;
  insert into public.nhis_serving_events
    (id, organization_id, branch_id, claim_id, idempotency_key, source, actor_user_id, payload_hash)
  values (v_event, v_claim.organization_id, v_claim.branch_id, p_claim_id,
    'recycle-stock:' || v_event::text,
    case when p_recycle_event is null then 'claim_recycle' else 'claim_restore' end,
    auth.uid(), md5(p_claim_id::text || coalesce(p_recycle_event::text, 'recycle')));

  for v_line in
    select inventory_drug_id, claim_medicine_key, sum(quantity_delta) as balance,
      case when p_recycle_event is not null then min(id::text)::uuid else null::uuid end as reversed_id
    from public.nhis_inventory_ledger
    where claim_id = p_claim_id
      and (p_recycle_event is null or serving_event_id = p_recycle_event)
    group by inventory_drug_id, claim_medicine_key
    having sum(quantity_delta) <> 0
    order by inventory_drug_id, claim_medicine_key
  loop
    v_delta := -v_line.balance;
    if (p_recycle_event is null and v_delta < 0) or (p_recycle_event is not null and v_delta > 0) then
      raise exception 'Unexpected claim inventory balance; review stock history before continuing.';
    end if;
    select * into v_drug from public.drugs where id = v_line.inventory_drug_id for update;
    if not found or v_drug.organization_id is distinct from v_claim.organization_id then
      raise exception 'The original inventory item is unavailable in this organization.';
    end if;
    if v_delta < 0 and (coalesce(v_drug.quantity, 0) + v_delta < 0 or v_drug.status is distinct from 'active') then
      raise exception 'Cannot restore claim: an original inventory item is inactive or has insufficient stock.';
    end if;
    update public.drugs set quantity = coalesce(quantity, 0) + v_delta, updated_at = now()
      where id = v_drug.id;
    insert into public.stock_movements
      (drug_id, movement_type, source_type, quantity, previous_quantity, new_quantity,
       reference_id, notes, created_by, organization_id, branch_id, created_at)
    values (v_drug.id, case when v_delta > 0 then 'return' else 'sale' end,
      'nhis_dispensing', v_delta, coalesce(v_drug.quantity, 0), coalesce(v_drug.quantity, 0) + v_delta,
      p_claim_id, case when v_delta > 0 then 'NHIS claim recycled: ' else 'NHIS claim restored: ' end
        || coalesce(v_claim.claim_number, p_claim_id::text), auth.uid(), v_claim.organization_id, v_drug.branch_id, now());
    insert into public.nhis_inventory_ledger
      (organization_id, branch_id, claim_id, serving_event_id, inventory_drug_id,
       claim_medicine_key, quantity_delta, movement_type, reversal_of_ledger_id, actor_user_id)
    values (v_claim.organization_id, v_drug.branch_id, p_claim_id, v_event, v_drug.id,
      v_line.claim_medicine_key, v_delta,
      case when v_delta > 0 then 'nhis_dispensing_reversal' else 'nhis_dispensing' end,
      v_line.reversed_id, auth.uid());
  end loop;
  -- If policy was enabled while the claim was in the bin, it was absent from
  -- that activation's snapshot. Preserve its stock-neutral historic quantity
  -- so a later partial serve cannot deduct it retroactively.
  if p_recycle_event is not null then
    select id into v_activation from public.nhis_inventory_policy_activations
      where organization_id = v_claim.organization_id order by enabled_at desc, id desc limit 1;
    if v_activation is not null then
      insert into public.nhis_inventory_policy_activation_baselines
        (activation_id, claim_id, claim_medicine_key, served_quantity)
      select v_activation, p_claim_id, m.medicine_key,
        m.served + coalesce((select sum(l.quantity_delta) from public.nhis_inventory_ledger l
          where l.claim_id = p_claim_id and l.claim_medicine_key = m.medicine_key), 0)
      from (select coalesce(nhis_drug_id::text, upper(btrim(drug_code))) as medicine_key,
          sum(served_qty) as served from public.nhis_claim_medicines
          where claim_id = p_claim_id and served_qty > 0 group by 1) m
      where m.medicine_key is not null and m.served + coalesce(
        (select sum(l.quantity_delta) from public.nhis_inventory_ledger l
          where l.claim_id = p_claim_id and l.claim_medicine_key = m.medicine_key), 0) > 0
      on conflict (activation_id, claim_id, claim_medicine_key) do nothing;
    end if;
  end if;
  return v_event;
end;
$$;
revoke all on function public.apply_nhis_recycle_stock(uuid, uuid) from public, anon, authenticated;

-- Removing the live-claim FKs must not let a raw DELETE bypass compensation.
create function public.guard_nhis_stock_claim_delete() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if exists (select 1 from public.nhis_inventory_ledger where claim_id = old.id) then
    if not exists (select 1 from public.deleted_records where entity_type = 'nhis_claim'
        and entity_id = old.id and organization_id = old.organization_id
        and snapshot->>'inventory_recycle_event' is not null)
      or exists (select 1 from public.nhis_inventory_ledger where claim_id = old.id
        group by inventory_drug_id, claim_medicine_key having sum(quantity_delta) <> 0) then
      raise exception 'Use the Recycle Bin workflow to return this claim inventory.';
    end if;
  end if;
  return old;
end;
$$;
revoke all on function public.guard_nhis_stock_claim_delete() from public, anon, authenticated;
create trigger guard_nhis_stock_claim_delete before delete on public.nhis_claims
for each row execute function public.guard_nhis_stock_claim_delete();

-- RPC definitions follow; retain existing authorization and all claim archives.

create or replace function public.recycle_nhis_claim(p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_claim public.nhis_claims%rowtype;
  v_user public.users%rowtype;
  v_deleted_id uuid;
  v_stock_event uuid;
  v_previous_replacement text := current_setting('healthflow.nhis_serving_replacement', true);
  v_corrections jsonb := '[]'::jsonb;
  v_duration_repairs jsonb := '[]'::jsonb;
  v_serving_events jsonb := '[]'::jsonb;
  v_signatures jsonb := '[]'::jsonb;
  v_cxf_events jsonb := '[]'::jsonb;
  v_remediation jsonb := '[]'::jsonb;
begin
  select * into v_user from public.users where id = auth.uid();
  select * into v_claim from public.nhis_claims where id = p_claim_id for update;

  if v_claim.id is null then
    raise exception 'NHIS claim not found.';
  end if;

  if v_user.id is null or v_user.is_active is false
    or v_user.organization_id is distinct from v_claim.organization_id
    or not (
      coalesce(v_user.role in ('admin', 'super_admin'), false)
      or coalesce(v_user.can_delete_nhis_claims, false)
      or coalesce(v_user.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
    ) then
    raise exception 'You do not have permission to delete this NHIS claim.';
  end if;

  v_stock_event := public.apply_nhis_recycle_stock(v_claim.id);

  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at, e.id), '[]'::jsonb)
    into v_serving_events from public.nhis_serving_events e where e.claim_id = v_claim.id;

  -- These audit tables were added after the initial Recycle Bin migration.
  -- Keep the checks so installations upgraded part-way through the historical
  -- migration sequence can still recycle an otherwise valid claim safely.
  if to_regclass('public.nhis_claim_corrections') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at, c.id), '[]'::jsonb)
      from public.nhis_claim_corrections c
      where c.claim_id = $1
    $sql$ into v_corrections using v_claim.id;
  end if;

  if to_regclass('public.nhis_duration_repair_audit') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at, a.id), '[]'::jsonb)
      from public.nhis_duration_repair_audit a
      where a.claim_id = $1
    $sql$ into v_duration_repairs using v_claim.id;
  end if;

  -- Added by the 2026-09-20 Claim-IT signing/export-gate migration.
  if to_regclass('public.nhis_cxf_events') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at, e.id), '[]'::jsonb)
      from public.nhis_cxf_events e
      where e.claim_id = $1
    $sql$ into v_cxf_events using v_claim.id;
  end if;

  if to_regclass('public.nhis_claim_signatures') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(s) order by s.signed_on, s.id), '[]'::jsonb)
      from public.nhis_claim_signatures s
      where s.claim_id = $1
    $sql$ into v_signatures using v_claim.id;
  end if;

  if to_regclass('public.nhis_claim_remediation') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
      from public.nhis_claim_remediation r
      where r.claim_id = $1
    $sql$ into v_remediation using v_claim.id;
  end if;

  insert into public.deleted_records (
    organization_id, entity_type, entity_id, display_name, snapshot, deleted_by
  ) values (
    v_claim.organization_id,
    'nhis_claim',
    v_claim.id,
    coalesce(v_claim.claim_number, v_claim.id::text),
    jsonb_build_object(
      'record', to_jsonb(v_claim),
      'inventory_recycle_event', v_stock_event,
      'medicines', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at, m.id) from public.nhis_claim_medicines m where m.claim_id = v_claim.id), '[]'::jsonb),
      'services', coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at, s.id) from public.nhis_claim_services s where s.claim_id = v_claim.id), '[]'::jsonb),
      'corrections', v_corrections,
      'duration_repairs', v_duration_repairs,
      'serving_events', v_serving_events,
      'cxf_events', v_cxf_events,
      'signatures', v_signatures,
      'remediation', v_remediation
    ),
    auth.uid()
  )
  on conflict (organization_id, entity_type, entity_id)
  do update set snapshot = excluded.snapshot, deleted_by = excluded.deleted_by, deleted_at = now()
  returning id into v_deleted_id;

  -- Remove leaf records first. The enclosing function call is one database
  -- transaction: any error below rolls the archive insert back as well.
  -- nhis_cxf_events references nhis_claim_signatures, so it goes first.
  if to_regclass('public.nhis_cxf_events') is not null then
    execute 'delete from public.nhis_cxf_events where claim_id = $1' using v_claim.id;
  end if;

  if to_regclass('public.nhis_claim_signatures') is not null then
    execute 'delete from public.nhis_claim_signatures where claim_id = $1' using v_claim.id;
  end if;

  if to_regclass('public.nhis_claim_remediation') is not null then
    execute 'delete from public.nhis_claim_remediation where claim_id = $1' using v_claim.id;
  end if;

  if to_regclass('public.nhis_duration_repair_audit') is not null then
    execute 'delete from public.nhis_duration_repair_audit where claim_id = $1'
      using v_claim.id;
  end if;

  if to_regclass('public.nhis_claim_corrections') is not null then
    execute 'delete from public.nhis_claim_corrections where claim_id = $1'
      using v_claim.id;
  end if;

  -- Events and ledger remain immutable in their original tables.
  perform set_config('healthflow.nhis_serving_replacement', 'true', true);
  delete from public.nhis_claim_medicines where claim_id = v_claim.id;
  delete from public.nhis_claim_services where claim_id = v_claim.id;
  delete from public.nhis_claims where id = v_claim.id;
  perform set_config('healthflow.nhis_serving_replacement', coalesce(v_previous_replacement, ''), true);

  return jsonb_build_object(
    'id', v_deleted_id,
    'entity_id', v_claim.id,
    'claim_number', v_claim.claim_number
  );
end;
$$;

-- Restore the newly-archived rows in addition to everything the previous
-- version already restored. Existing recycle-bin snapshots do not have these
-- keys, so they restore normally (the inserts below are no-ops on '[]').
create or replace function public.restore_deleted_record(p_deleted_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_bin public.deleted_records%rowtype;
  v_previous_replacement text := current_setting('healthflow.nhis_serving_replacement', true);
  v_user public.users%rowtype;
begin
  select * into v_user from public.users where id = auth.uid();
  select * into v_bin from public.deleted_records where id = p_deleted_id for update;
  if v_bin.id is null then raise exception 'Deleted record not found.'; end if;
  if v_user.id is null or v_user.is_active is false
    or v_user.organization_id is distinct from v_bin.organization_id
    or not (coalesce(v_user.role in ('admin', 'super_admin'), false) or coalesce(v_user.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[])
  then raise exception 'Only an administrator can restore deleted records.'; end if;

  if v_bin.entity_type = 'inventory_drug' then
    update public.drugs
      set status = coalesce(nullif(v_bin.snapshot->'record'->>'status', ''), 'active'),
          updated_at = now()
      where id = v_bin.entity_id and organization_id = v_bin.organization_id;
    if not found then
      insert into public.drugs
      select (jsonb_populate_record(null::public.drugs, v_bin.snapshot->'record')).*;
    end if;
  elsif v_bin.entity_type = 'nhis_claim' then
    perform set_config('healthflow.nhis_serving_replacement', 'true', true);
    insert into public.nhis_claims
    select (jsonb_populate_record(null::public.nhis_claims, v_bin.snapshot->'record')).*;
    insert into public.nhis_claim_medicines
    select (jsonb_populate_record(null::public.nhis_claim_medicines, value)).*
    from jsonb_array_elements(coalesce(v_bin.snapshot->'medicines', '[]'::jsonb));
    insert into public.nhis_claim_services
    select (jsonb_populate_record(null::public.nhis_claim_services, value)).*
    from jsonb_array_elements(coalesce(v_bin.snapshot->'services', '[]'::jsonb));

    -- Old archives moved their events; new archives retain them in place.
    insert into public.nhis_serving_events
    select (jsonb_populate_record(null::public.nhis_serving_events, value)).*
    from jsonb_array_elements(coalesce(v_bin.snapshot->'serving_events', '[]'::jsonb))
    on conflict (id) do nothing;

    if v_bin.snapshot->>'inventory_recycle_event' is not null then
      perform public.apply_nhis_recycle_stock(v_bin.entity_id, (v_bin.snapshot->>'inventory_recycle_event')::uuid);
    end if;
    perform set_config('healthflow.nhis_serving_replacement', coalesce(v_previous_replacement, ''), true);

    if to_regclass('public.nhis_claim_corrections') is not null then
      execute $sql$
        insert into public.nhis_claim_corrections
        select (jsonb_populate_record(null::public.nhis_claim_corrections, value)).*
        from jsonb_array_elements(coalesce($1->'corrections', '[]'::jsonb))
      $sql$ using v_bin.snapshot;
    end if;

    if to_regclass('public.nhis_duration_repair_audit') is not null then
      execute $sql$
        insert into public.nhis_duration_repair_audit
        select (jsonb_populate_record(null::public.nhis_duration_repair_audit, value)).*
        from jsonb_array_elements(coalesce($1->'duration_repairs', '[]'::jsonb))
      $sql$ using v_bin.snapshot;
    end if;

    -- Signatures before cxf_events: cxf_events.signature_id references them.
    if to_regclass('public.nhis_claim_signatures') is not null then
      execute $sql$
        insert into public.nhis_claim_signatures
        select (jsonb_populate_record(null::public.nhis_claim_signatures, value)).*
        from jsonb_array_elements(coalesce($1->'signatures', '[]'::jsonb))
      $sql$ using v_bin.snapshot;
    end if;

    if to_regclass('public.nhis_cxf_events') is not null then
      execute $sql$
        insert into public.nhis_cxf_events
        select (jsonb_populate_record(null::public.nhis_cxf_events, value)).*
        from jsonb_array_elements(coalesce($1->'cxf_events', '[]'::jsonb))
      $sql$ using v_bin.snapshot;
    end if;

    if to_regclass('public.nhis_claim_remediation') is not null then
      execute $sql$
        insert into public.nhis_claim_remediation
        select (jsonb_populate_record(null::public.nhis_claim_remediation, value)).*
        from jsonb_array_elements(coalesce($1->'remediation', '[]'::jsonb))
      $sql$ using v_bin.snapshot;
    end if;
  end if;

  delete from public.deleted_records where id = v_bin.id;
  return jsonb_build_object('entity_type', v_bin.entity_type, 'entity_id', v_bin.entity_id);
end;
$$;

revoke all on function public.recycle_nhis_claim(uuid) from public, anon;
grant execute on function public.recycle_nhis_claim(uuid) to authenticated;
revoke all on function public.restore_deleted_record(uuid) from public, anon;
grant execute on function public.restore_deleted_record(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
