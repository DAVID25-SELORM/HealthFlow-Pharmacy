-- Chemical Shop restricted inventory controls.
-- All enforcement is conditional on organization_type = 'chemical_shop';
-- pharmacy and hospital behavior is unchanged.

alter table public.organizations
  drop constraint if exists organizations_organization_type_check;

alter table public.organizations
  add constraint organizations_organization_type_check
  check (organization_type in ('pharmacy', 'hospital', 'chemical_shop'));

alter table public.drugs
  add column if not exists chemical_shop_sale_permitted boolean not null default false;

alter table public.users
  add column if not exists can_manage_restricted_inventory boolean not null default false;

create table if not exists public.restricted_inventory (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  drug_id uuid references public.drugs(id) on delete restrict,
  medicine_name text not null,
  quantity numeric not null check (quantity >= 0),
  source text,
  received_at timestamptz,
  quarantine_reason text not null,
  status text not null default 'quarantined'
    check (status in ('quarantined', 'under_review', 'returned_to_supplier', 'transferred_to_authorized_facility', 'destroyed')),
  action_notes text,
  created_at timestamptz not null default now(),
  created_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);

create table if not exists public.restricted_inventory_audit (
  id uuid primary key default gen_random_uuid(),
  restricted_inventory_id uuid references public.restricted_inventory(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action text not null check (action in ('viewed', 'quarantined', 'status_changed')),
  previous_status text,
  new_status text,
  reason text,
  actor_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_restricted_inventory_org_status_created
  on public.restricted_inventory (organization_id, status, created_at desc);
create index if not exists idx_restricted_inventory_audit_org_item_created
  on public.restricted_inventory_audit (organization_id, restricted_inventory_id, created_at desc);

create or replace function public.is_chemical_shop_organization(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_organization_id
      and lower(coalesce(o.organization_type, '')) = 'chemical_shop'
  );
$$;

create or replace function public.is_drug_allowed_for_chemical_shop(p_drug public.drugs)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select
    (
      upper(coalesce(p_drug.medicine_access_level, '')) = 'OTC'
      or coalesce(p_drug.chemical_shop_sale_permitted, false)
    )
    and lower(coalesce(p_drug.epharmacy_sale_class, '')) not in
      ('prescription', 'restricted', 'controlled', 'narcotic');
$$;

create or replace function public.can_review_restricted_inventory(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and coalesce(u.is_active, true)
      and (
        lower(coalesce(u.role, '')) in ('super_admin', 'compliance_admin', 'compliance_officer')
        or coalesce(u.assigned_roles, '{}'::text[]) && array['super_admin', 'compliance_admin', 'compliance_officer']::text[]
        or (
          u.organization_id = p_organization_id
          and coalesce(u.can_manage_restricted_inventory, false)
          and (
            lower(coalesce(u.role, '')) in ('admin', 'supervisor')
            or coalesce(u.assigned_roles, '{}'::text[]) && array['admin', 'supervisor']::text[]
          )
        )
      )
  );
$$;

revoke all on function public.is_chemical_shop_organization(uuid) from public, anon;
revoke all on function public.is_drug_allowed_for_chemical_shop(public.drugs) from public, anon;
revoke all on function public.can_review_restricted_inventory(uuid) from public, anon;
grant execute on function public.is_chemical_shop_organization(uuid) to authenticated;
grant execute on function public.is_drug_allowed_for_chemical_shop(public.drugs) to authenticated;
grant execute on function public.can_review_restricted_inventory(uuid) to authenticated;

alter table public.restricted_inventory enable row level security;
alter table public.restricted_inventory_audit enable row level security;

-- Direct table access is intentionally unavailable. Read and mutation RPCs below
-- both authorize and write the required audit event.
revoke all on public.restricted_inventory from public, anon, authenticated;
revoke all on public.restricted_inventory_audit from public, anon, authenticated;

create or replace function public.get_restricted_inventory(p_organization_id uuid)
returns table (
  id uuid, organization_id uuid, branch_id uuid, drug_id uuid, medicine_name text,
  quantity numeric, source text, received_at timestamptz, quarantine_reason text,
  status text, action_notes text, created_at timestamptz, updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.can_review_restricted_inventory(p_organization_id) then
    raise exception using errcode = '42501', message = 'You do not have permission to review restricted inventory.';
  end if;

  insert into public.restricted_inventory_audit (restricted_inventory_id, organization_id, action, reason, actor_id)
  values (null, p_organization_id, 'viewed', 'Restricted inventory list viewed', auth.uid());

  return query
  select r.id, r.organization_id, r.branch_id, r.drug_id, r.medicine_name,
         r.quantity, r.source, r.received_at, r.quarantine_reason,
         r.status, r.action_notes, r.created_at, r.updated_at
  from public.restricted_inventory r
  where r.organization_id = p_organization_id
  order by r.created_at desc;
end;
$$;

create or replace function public.get_restricted_inventory_audit(p_organization_id uuid, p_restricted_inventory_id uuid default null)
returns table (
  id uuid, restricted_inventory_id uuid, action text, previous_status text,
  new_status text, reason text, actor_id uuid, actor_name text, actor_email text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.can_review_restricted_inventory(p_organization_id) then
    raise exception using errcode = '42501', message = 'You do not have permission to review restricted inventory audit history.';
  end if;

  insert into public.restricted_inventory_audit (restricted_inventory_id, organization_id, action, reason, actor_id)
  values (p_restricted_inventory_id, p_organization_id, 'viewed', 'Restricted inventory audit viewed', auth.uid());

  return query
  select a.id, a.restricted_inventory_id, a.action, a.previous_status,
         a.new_status, a.reason, a.actor_id, u.full_name, u.email, a.created_at
  from public.restricted_inventory_audit a
  left join public.users u on u.id = a.actor_id
  where a.organization_id = p_organization_id
    and (p_restricted_inventory_id is null or a.restricted_inventory_id = p_restricted_inventory_id)
  order by a.created_at desc;
end;
$$;

create or replace function public.quarantine_chemical_shop_stock(
  p_drug_id uuid,
  p_quantity numeric,
  p_reason text,
  p_source text default null,
  p_received_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_drug public.drugs%rowtype;
  v_id uuid;
begin
  select * into v_drug from public.drugs where id = p_drug_id for update;
  if not found or not public.is_chemical_shop_organization(v_drug.organization_id) then
    raise exception using errcode = '22023', message = 'Chemical Shop stock record not found.';
  end if;
  if not public.can_review_restricted_inventory(v_drug.organization_id) then
    raise exception using errcode = '42501', message = 'You do not have permission to quarantine restricted stock.';
  end if;
  if p_quantity <= 0 or p_quantity > coalesce(v_drug.quantity, 0) then
    raise exception using errcode = '22023', message = 'Quarantine quantity must be positive and cannot exceed available stock.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception using errcode = '22023', message = 'A quarantine reason is required.';
  end if;

  update public.drugs set quantity = quantity - p_quantity, updated_at = now() where id = p_drug_id;
  insert into public.restricted_inventory (
    organization_id, branch_id, drug_id, medicine_name, quantity, source,
    received_at, quarantine_reason, created_by, updated_by
  ) values (
    v_drug.organization_id, v_drug.branch_id, v_drug.id, v_drug.name, p_quantity,
    nullif(btrim(p_source), ''), p_received_at, btrim(p_reason), auth.uid(), auth.uid()
  ) returning id into v_id;
  insert into public.restricted_inventory_audit (
    restricted_inventory_id, organization_id, action, new_status, reason, actor_id
  ) values (v_id, v_drug.organization_id, 'quarantined', 'quarantined', btrim(p_reason), auth.uid());
  return v_id;
end;
$$;

create or replace function public.update_restricted_inventory_status(
  p_restricted_inventory_id uuid,
  p_status text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item public.restricted_inventory%rowtype;
begin
  select * into v_item from public.restricted_inventory where id = p_restricted_inventory_id for update;
  if not found or not public.can_review_restricted_inventory(v_item.organization_id) then
    raise exception using errcode = '42501', message = 'You do not have permission to update restricted inventory.';
  end if;
  if p_status not in ('quarantined', 'under_review', 'returned_to_supplier', 'transferred_to_authorized_facility', 'destroyed') then
    raise exception using errcode = '22023', message = 'Invalid restricted inventory status.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception using errcode = '22023', message = 'A reason is required.';
  end if;

  update public.restricted_inventory
  set status = p_status, action_notes = btrim(p_reason), updated_at = now(), updated_by = auth.uid()
  where id = p_restricted_inventory_id;
  insert into public.restricted_inventory_audit (
    restricted_inventory_id, organization_id, action, previous_status, new_status, reason, actor_id
  ) values (v_item.id, v_item.organization_id, 'status_changed', v_item.status, p_status, btrim(p_reason), auth.uid());
end;
$$;

revoke all on function public.get_restricted_inventory(uuid) from public, anon;
revoke all on function public.get_restricted_inventory_audit(uuid, uuid) from public, anon;
revoke all on function public.quarantine_chemical_shop_stock(uuid, numeric, text, text, timestamptz) from public, anon;
revoke all on function public.update_restricted_inventory_status(uuid, text, text) from public, anon;
grant execute on function public.get_restricted_inventory(uuid) to authenticated;
grant execute on function public.get_restricted_inventory_audit(uuid, uuid) to authenticated;
grant execute on function public.quarantine_chemical_shop_stock(uuid, numeric, text, text, timestamptz) to authenticated;
grant execute on function public.update_restricted_inventory_status(uuid, text, text) to authenticated;

create or replace function public.prevent_chemical_shop_restricted_transaction()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org_id uuid;
  v_drug public.drugs%rowtype;
begin
  select * into v_drug from public.drugs where id = new.drug_id;
  if tg_table_name = 'sale_items' then
    select organization_id into v_org_id from public.sales where id = new.sale_id;
  elsif tg_table_name = 'purchase_items' then
    select organization_id into v_org_id from public.purchases where id = new.purchase_id;
  end if;

  if public.is_chemical_shop_organization(v_org_id)
     and (v_drug.id is null or not public.is_drug_allowed_for_chemical_shop(v_drug)) then
    raise exception using errcode = '42501', message = 'This medicine is restricted and cannot be transacted by a Chemical Shop.';
  end if;
  return new;
end;
$$;

do $$
begin
  if to_regclass('public.sale_items') is not null then
    execute 'drop trigger if exists prevent_chemical_shop_restricted_sale on public.sale_items';
    execute 'create trigger prevent_chemical_shop_restricted_sale before insert or update on public.sale_items for each row execute function public.prevent_chemical_shop_restricted_transaction()';
  end if;
  if to_regclass('public.purchase_items') is not null then
    execute 'drop trigger if exists prevent_chemical_shop_restricted_purchase on public.purchase_items';
    execute 'create trigger prevent_chemical_shop_restricted_purchase before insert or update on public.purchase_items for each row execute function public.prevent_chemical_shop_restricted_transaction()';
  end if;
end;
$$;

create or replace function public.prevent_chemical_shop_restricted_stock_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.is_chemical_shop_organization(new.organization_id)
     and not public.is_drug_allowed_for_chemical_shop(new)
     and coalesce(new.quantity, 0) is distinct from coalesce(old.quantity, 0)
     and auth.uid() is not null
     and not public.can_review_restricted_inventory(new.organization_id) then
    raise exception using
      errcode = '42501',
      message = 'Restricted Chemical Shop stock can only be changed through the audited quarantine workflow.';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_chemical_shop_restricted_stock_insert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.is_chemical_shop_organization(new.organization_id)
     and not public.is_drug_allowed_for_chemical_shop(new)
     and coalesce(new.quantity, 0) > 0
     and auth.uid() is not null then
    raise exception using
      errcode = '42501',
      message = 'Restricted medicine stock cannot be added to normal Chemical Shop inventory. Use the audited quarantine workflow.';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_chemical_shop_restricted_stock_insert on public.drugs;
create trigger prevent_chemical_shop_restricted_stock_insert
before insert on public.drugs
for each row execute function public.prevent_chemical_shop_restricted_stock_insert();

drop trigger if exists prevent_chemical_shop_restricted_stock_change on public.drugs;
create trigger prevent_chemical_shop_restricted_stock_change
before update of quantity on public.drugs
for each row execute function public.prevent_chemical_shop_restricted_stock_change();

-- Restrictive policies are combined with existing tenant policies. They hide
-- restricted catalogue and stock rows only when the current tenant is a
-- Chemical Shop; pharmacy and hospital reads remain unchanged.
drop policy if exists chemical_shop_restricted_drugs_hidden on public.drugs;
create policy chemical_shop_restricted_drugs_hidden on public.drugs
as restrictive
for select
to authenticated
using (
  not public.is_chemical_shop_organization(organization_id)
  or public.is_drug_allowed_for_chemical_shop(drugs)
);

-- Existing restricted stock is preserved in quarantine and removed from normal
-- Chemical Shop stock visibility. Shared catalogue records are never deleted.
with moved as (
  insert into public.restricted_inventory (
    organization_id, branch_id, drug_id, medicine_name, quantity, source,
    quarantine_reason, created_at
  )
  select d.organization_id, d.branch_id, d.id, d.name, d.quantity,
         'Historical inventory migration',
         'Medicine classification is not permitted for Chemical Shop operations.', now()
  from public.drugs d
  join public.organizations o on o.id = d.organization_id
  where lower(coalesce(o.organization_type, '')) = 'chemical_shop'
    and coalesce(d.quantity, 0) > 0
    and not public.is_drug_allowed_for_chemical_shop(d)
    and not exists (
      select 1 from public.restricted_inventory r
      where r.drug_id = d.id and r.status in ('quarantined', 'under_review')
    )
  returning id, organization_id, quarantine_reason
), audited as (
  insert into public.restricted_inventory_audit (
    restricted_inventory_id, organization_id, action, new_status, reason
  )
  select id, organization_id, 'quarantined', 'quarantined', quarantine_reason from moved
)
update public.drugs d
set quantity = 0, updated_at = now()
from public.organizations o
where o.id = d.organization_id
  and lower(coalesce(o.organization_type, '')) = 'chemical_shop'
  and coalesce(d.quantity, 0) > 0
  and not public.is_drug_allowed_for_chemical_shop(d);

-- Branch sync uses a security-definer snapshot and therefore does not inherit
-- the caller's restrictive drugs policy. Apply the same Chemical Shop rule in
-- the snapshot itself while leaving pharmacy and hospital snapshots unchanged.
create or replace function public.branch_sync_get_inventory_snapshot(
  p_sync_token text,
  p_limit integer default 5000,
  p_updated_since timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_client public.branch_sync_clients%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 5000), 1), 20000);
  v_drugs jsonb;
begin
  v_client := public.get_branch_sync_client(p_sync_token);

  select coalesce(jsonb_agg(to_jsonb(d) order by d.name, d.batch_number, d.id), '[]'::jsonb)
  into v_drugs
  from (
    select
      id, name, brand_name, generic_name, batch_number, barcode, expiry_date,
      quantity, unit, price, cost_price, nhis_code, nhis_price, nhis_unit,
      is_nhis_listed, supplier, category, description, sale_on_return,
      reorder_level, status, organization_id, branch_id, updated_at
    from public.drugs
    where organization_id = v_client.organization_id
      and (branch_id is null or branch_id = v_client.branch_id)
      and coalesce(status, 'active') <> 'inactive'
      and (p_updated_since is null or updated_at > p_updated_since)
      and (
        not public.is_chemical_shop_organization(v_client.organization_id)
        or public.is_drug_allowed_for_chemical_shop(drugs)
      )
    order by name, batch_number, id
    limit v_limit
  ) d;

  return jsonb_build_object(
    'organization_id', v_client.organization_id,
    'branch_id', v_client.branch_id,
    'pulled_at', now(),
    'drugs', v_drugs
  );
end;
$$;

revoke all on function public.branch_sync_get_inventory_snapshot(text, integer, timestamptz) from public;
grant execute on function public.branch_sync_get_inventory_snapshot(text, integer, timestamptz) to anon, authenticated;
