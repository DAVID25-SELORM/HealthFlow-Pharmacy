create table if not exists public.deleted_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_type text not null check (entity_type in ('inventory_drug', 'nhis_claim')),
  entity_id uuid not null,
  display_name text not null,
  snapshot jsonb not null,
  deleted_by uuid references auth.users(id),
  deleted_at timestamptz not null default now(),
  unique (organization_id, entity_type, entity_id)
);

create index if not exists idx_deleted_records_org_deleted_at
  on public.deleted_records (organization_id, deleted_at desc);

alter table public.deleted_records enable row level security;
revoke all on table public.deleted_records from anon, authenticated;
grant select on table public.deleted_records to authenticated;

create policy deleted_records_admin_select on public.deleted_records
for select to authenticated using (
  exists (
    select 1 from public.users viewer
    where viewer.id = auth.uid()
      and viewer.organization_id = deleted_records.organization_id
      and viewer.is_active is distinct from false
      and (
        viewer.role in ('admin', 'super_admin')
        or coalesce(viewer.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
      )
  )
);

create or replace function public.recycle_inventory_drug(
  p_drug_id uuid,
  p_organization_id uuid,
  p_deleted_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_drug public.drugs%rowtype;
  v_deleted_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Inventory deletion must use the authorized inventory service.';
  end if;
  select * into v_drug
  from public.drugs
  where id = p_drug_id and organization_id = p_organization_id;
  if v_drug.id is null then raise exception 'Inventory item not found.'; end if;

  insert into public.deleted_records (
    organization_id, entity_type, entity_id, display_name, snapshot, deleted_by
  ) values (
    p_organization_id, 'inventory_drug', v_drug.id,
    coalesce(v_drug.name, v_drug.id::text),
    jsonb_build_object('record', to_jsonb(v_drug)),
    p_deleted_by
  )
  on conflict (organization_id, entity_type, entity_id)
  do update set snapshot = excluded.snapshot, deleted_by = excluded.deleted_by, deleted_at = now()
  returning id into v_deleted_id;

  update public.drugs set status = 'inactive', updated_at = now() where id = v_drug.id;
  return jsonb_build_object('id', v_deleted_id, 'entity_id', v_drug.id, 'name', v_drug.name);
end;
$$;

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
begin
  select * into v_user from public.users where id = auth.uid();
  select * into v_claim from public.nhis_claims where id = p_claim_id;
  if v_claim.id is null then raise exception 'NHIS claim not found.'; end if;
  if v_user.organization_id is distinct from v_claim.organization_id
    or not (
      v_user.role in ('admin', 'super_admin')
      or coalesce(v_user.can_delete_nhis_claims, false)
      or coalesce(v_user.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[]
    )
  then raise exception 'You do not have permission to delete this NHIS claim.'; end if;

  insert into public.deleted_records (
    organization_id, entity_type, entity_id, display_name, snapshot, deleted_by
  ) values (
    v_claim.organization_id,
    'nhis_claim',
    v_claim.id,
    coalesce(v_claim.claim_number, v_claim.id::text),
    jsonb_build_object(
      'record', to_jsonb(v_claim),
      'medicines', coalesce((select jsonb_agg(to_jsonb(m)) from public.nhis_claim_medicines m where m.claim_id = v_claim.id), '[]'::jsonb),
      'services', coalesce((select jsonb_agg(to_jsonb(s)) from public.nhis_claim_services s where s.claim_id = v_claim.id), '[]'::jsonb)
    ),
    auth.uid()
  )
  on conflict (organization_id, entity_type, entity_id)
  do update set snapshot = excluded.snapshot, deleted_by = excluded.deleted_by, deleted_at = now()
  returning id into v_deleted_id;

  delete from public.nhis_claims where id = v_claim.id;
  return jsonb_build_object('id', v_deleted_id, 'entity_id', v_claim.id, 'claim_number', v_claim.claim_number);
end;
$$;

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
  select * into v_bin from public.deleted_records where id = p_deleted_id;
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
  end if;

  delete from public.deleted_records where id = v_bin.id;
  return jsonb_build_object('entity_type', v_bin.entity_type, 'entity_id', v_bin.entity_id);
end;
$$;

create or replace function public.permanently_delete_record(p_deleted_id uuid)
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
  select * into v_bin from public.deleted_records where id = p_deleted_id;
  if v_bin.id is null then raise exception 'Deleted record not found.'; end if;
  if v_user.organization_id is distinct from v_bin.organization_id
    or not (v_user.role in ('admin', 'super_admin') or coalesce(v_user.assigned_roles, '{}'::text[]) && array['admin', 'super_admin']::text[])
  then raise exception 'Only an administrator can permanently delete records.'; end if;

  if v_bin.entity_type = 'inventory_drug' then
    delete from public.drugs where id = v_bin.entity_id and organization_id = v_bin.organization_id;
  end if;
  delete from public.deleted_records where id = v_bin.id;
  return jsonb_build_object('entity_type', v_bin.entity_type, 'entity_id', v_bin.entity_id);
end;
$$;

revoke all on function public.recycle_nhis_claim(uuid) from public;
revoke all on function public.recycle_inventory_drug(uuid, uuid, uuid) from public;
revoke all on function public.restore_deleted_record(uuid) from public;
revoke all on function public.permanently_delete_record(uuid) from public;
grant execute on function public.recycle_nhis_claim(uuid) to authenticated;
grant execute on function public.recycle_inventory_drug(uuid, uuid, uuid) to service_role;
grant execute on function public.restore_deleted_record(uuid) to authenticated;
grant execute on function public.permanently_delete_record(uuid) to authenticated;
