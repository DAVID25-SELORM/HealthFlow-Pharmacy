-- Deleting (recycling) an NHIS claim has been failing with a raw foreign key
-- violation ("update or delete on table nhis_claims violates foreign key
-- constraint nhis_cxf_events_claim_id_fkey ...") for any claim that has ever
-- been CXF-exported, signed, or flagged for remediation. Those three tables
-- (nhis_claim_signatures, nhis_cxf_events, nhis_claim_remediation) were added
-- by the 2026-09-20 Claim-IT signing/export-gate migration, after this
-- function's last update, and it was never taught to archive them.
--
-- This follows the exact pattern already used for nhis_claim_corrections and
-- nhis_duration_repair_audit: archive into deleted_records.snapshot, then
-- delete, restorable by restore_deleted_record. It does not touch
-- nhis_inventory_ledger or nhis_inventory_policy_activation_baselines, whose
-- RESTRICT protections remain: those hold cross-claim stock/policy state and
-- are deliberately left blocking deletion.
begin;

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

  -- Locking the parent above serializes this operation with serving. Preserve
  -- all stock history, including fully compensated movements. A zero net balance
  -- does not mean the ledger can be removed.
  if exists (select 1 from public.nhis_inventory_ledger where claim_id = v_claim.id) then
    raise exception 'This claim has recorded inventory movements and cannot be deleted. Keep the claim and use the controlled correction workflow.' using errcode = '55000';
  end if;

  -- A claim served under a duplicate-serving policy activation carries a
  -- baseline shared with that activation window. Removing it here could
  -- misstate quantities the policy tracks for other claims, so it is left
  -- as a hard block too, same as the inventory ledger above.
  if to_regclass('public.nhis_inventory_policy_activation_baselines') is not null
    and exists (select 1 from public.nhis_inventory_policy_activation_baselines where claim_id = v_claim.id) then
    raise exception 'This claim has a recorded inventory policy baseline and cannot be deleted. Keep the claim and use the controlled correction workflow.' using errcode = '55000';
  end if;

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

  -- Event-only serving attempts (for example when stock deduction was off)
  -- move to the archive intact. Events with ledger effects are rejected above;
  -- the ledger's RESTRICT foreign key remains a final integrity backstop.
  delete from public.nhis_serving_events where claim_id = v_claim.id;
  delete from public.nhis_claim_medicines where claim_id = v_claim.id;
  delete from public.nhis_claim_services where claim_id = v_claim.id;
  delete from public.nhis_claims where id = v_claim.id;

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
    insert into public.nhis_claims
    select (jsonb_populate_record(null::public.nhis_claims, v_bin.snapshot->'record')).*;
    insert into public.nhis_claim_medicines
    select (jsonb_populate_record(null::public.nhis_claim_medicines, value)).*
    from jsonb_array_elements(coalesce(v_bin.snapshot->'medicines', '[]'::jsonb));
    insert into public.nhis_claim_services
    select (jsonb_populate_record(null::public.nhis_claim_services, value)).*
    from jsonb_array_elements(coalesce(v_bin.snapshot->'services', '[]'::jsonb));

    -- Restore the original IDs, timestamps and idempotency keys. Do not call
    -- serving or stock-effect functions while restoring an archived claim.
    insert into public.nhis_serving_events
    select (jsonb_populate_record(null::public.nhis_serving_events, value)).*
    from jsonb_array_elements(coalesce(v_bin.snapshot->'serving_events', '[]'::jsonb));

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

revoke all on function public.recycle_nhis_claim(uuid) from public;
grant execute on function public.recycle_nhis_claim(uuid) to authenticated;
revoke all on function public.restore_deleted_record(uuid) from public;
grant execute on function public.restore_deleted_record(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
