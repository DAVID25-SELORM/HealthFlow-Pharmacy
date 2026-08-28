-- Recycling an NHIS claim archives its complete state before removing it from
-- the active workspace.  The original recycle routine attempted to delete the
-- claim parent while its medicine rows still existed, which PostgreSQL rightly
-- rejects.  Keep the operation atomic and retain the audit trail for restore.
create or replace function public.recycle_nhis_claim(p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.nhis_claims%rowtype;
  v_user public.users%rowtype;
  v_deleted_id uuid;
  v_corrections jsonb := '[]'::jsonb;
  v_duration_repairs jsonb := '[]'::jsonb;
begin
  select * into v_user from public.users where id = auth.uid();
  select * into v_claim from public.nhis_claims where id = p_claim_id for update;

  if v_claim.id is null then
    raise exception 'NHIS claim not found.';
  end if;

  if v_user.organization_id is distinct from v_claim.organization_id
    or not (
      v_user.role in ('admin', 'super_admin')
      or coalesce(v_user.can_delete_nhis_claims, false)
      or coalesce(v_user.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
    ) then
    raise exception 'You do not have permission to delete this NHIS claim.';
  end if;

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
      'duration_repairs', v_duration_repairs
    ),
    auth.uid()
  )
  on conflict (organization_id, entity_type, entity_id)
  do update set snapshot = excluded.snapshot, deleted_by = excluded.deleted_by, deleted_at = now()
  returning id into v_deleted_id;

  -- Remove leaf records first.  The enclosing function call is one database
  -- transaction: any error below rolls the archive insert back as well.
  if to_regclass('public.nhis_duration_repair_audit') is not null then
    execute 'delete from public.nhis_duration_repair_audit where claim_id = $1'
      using v_claim.id;
  end if;

  if to_regclass('public.nhis_claim_corrections') is not null then
    execute 'delete from public.nhis_claim_corrections where claim_id = $1'
      using v_claim.id;
  end if;

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

-- Restore the audit rows in addition to the claim and its line items.  Existing
-- recycle-bin snapshots do not have these keys, so they restore normally.
create or replace function public.restore_deleted_record(p_deleted_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bin public.deleted_records%rowtype;
  v_user public.users%rowtype;
begin
  select * into v_user from public.users where id = auth.uid();
  select * into v_bin from public.deleted_records where id = p_deleted_id for update;
  if v_bin.id is null then raise exception 'Deleted record not found.'; end if;
  if v_user.organization_id is distinct from v_bin.organization_id
    or not (v_user.role in ('admin', 'super_admin') or coalesce(v_user.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[])
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
