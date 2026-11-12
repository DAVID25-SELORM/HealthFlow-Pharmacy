-- Confirmed branch-to-branch stock transfers, and branch creation for branch managers.
--
-- Until now stock moved between branches in one instant step
-- (transfer_drug_to_branch, only in supabase/legacy): the sender could move any
-- quantity and nothing had to be confirmed at the receiving end. This adds a
-- two-step flow:
--   1. A sender dispatches one or more medicines (stock leaves the source
--      branch immediately, so it cannot be sold while in transit).
--   2. The receiving branch confirms what arrived. Anything short is returned
--      to the source branch automatically; or the receiver rejects the whole
--      transfer, or the sender cancels it while it is still pending.
-- Every step writes transfer_in / transfer_out rows to stock_movements and an
-- audit event. Normal sales and serving are untouched (INVENTORY-001).
--
-- It also adds create_pharmacy_branch() so an administrator OR a branch manager
-- can create a branch (the direct insert policy on public.branches only allows
-- administrators and is left as it is).
--
-- Needs these to exist already: public.organizations, public.users, public.branches,
-- public.drugs (with branch_id), public.stock_movements (with branch_id and
-- destination_branch_id; movement types transfer_in / transfer_out), and
-- public.log_audit_event / public.user_organization_id. 00-precheck.sql checks them.
begin;

create sequence if not exists public.branch_stock_transfer_number_seq;
revoke all on sequence public.branch_stock_transfer_number_seq from public, anon, authenticated;

create table if not exists public.branch_stock_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  transfer_number text not null,
  source_branch_id uuid not null references public.branches(id),
  destination_branch_id uuid not null references public.branches(id),
  status text not null default 'pending'
    check (status in ('pending', 'received', 'rejected', 'cancelled')),
  notes text check (notes is null or length(notes) <= 500),
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  resolved_by uuid references public.users(id),
  resolved_at timestamptz,
  resolution_notes text check (resolution_notes is null or length(resolution_notes) <= 500),
  unique (organization_id, transfer_number),
  check (source_branch_id <> destination_branch_id),
  check ((status = 'pending') = (resolved_at is null))
);

create table if not exists public.branch_stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.branch_stock_transfers(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_drug_id uuid not null references public.drugs(id),
  destination_drug_id uuid references public.drugs(id) on delete set null,
  medicine_name text not null,
  batch_number text,
  expiry_date date,
  unit text,
  quantity_sent numeric(10, 2) not null check (quantity_sent > 0),
  quantity_received numeric(10, 2) check (quantity_received >= 0 and quantity_received <= quantity_sent),
  unique (transfer_id, source_drug_id)
);

create index if not exists branch_stock_transfers_org_status
  on public.branch_stock_transfers (organization_id, status, created_at desc);
create index if not exists branch_stock_transfers_org_source
  on public.branch_stock_transfers (organization_id, source_branch_id);
create index if not exists branch_stock_transfers_org_destination
  on public.branch_stock_transfers (organization_id, destination_branch_id);
create index if not exists branch_stock_transfer_items_transfer
  on public.branch_stock_transfer_items (transfer_id);
create index if not exists branch_stock_transfer_items_source_drug
  on public.branch_stock_transfer_items (source_drug_id);

alter table public.branch_stock_transfers enable row level security;
alter table public.branch_stock_transfer_items enable row level security;
revoke all on public.branch_stock_transfers from public, anon, authenticated;
revoke all on public.branch_stock_transfer_items from public, anon, authenticated;
grant select on public.branch_stock_transfers to authenticated;
grant select on public.branch_stock_transfer_items to authenticated;
grant all on public.branch_stock_transfers to service_role;
grant all on public.branch_stock_transfer_items to service_role;

-- Members of the pharmacy can read its transfers. All writes go through the
-- functions below, which check the caller's role and branch.
drop policy if exists branch_stock_transfers_select_org on public.branch_stock_transfers;
create policy branch_stock_transfers_select_org on public.branch_stock_transfers
  for select to authenticated
  using (organization_id = public.user_organization_id());

drop policy if exists branch_stock_transfer_items_select_org on public.branch_stock_transfer_items;
create policy branch_stock_transfer_items_select_org on public.branch_stock_transfer_items
  for select to authenticated
  using (organization_id = public.user_organization_id());

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------

create or replace function public.branch_transfer_actor()
returns table (
  organization_id uuid, user_id uuid, user_branch_id uuid,
  is_admin boolean, is_manager boolean, can_send boolean
)
language sql stable security definer set search_path = public, pg_catalog
as $$
  select u.organization_id, u.id, u.branch_id,
         (u.role = 'admin' or coalesce(u.assigned_roles, '{}'::text[]) && array['admin']::text[]),
         (u.role = 'branch_manager' or coalesce(u.assigned_roles, '{}'::text[]) && array['branch_manager']::text[]),
         (u.role in ('admin', 'pharmacist', 'technician', 'procurement', 'inventory_officer', 'branch_manager')
           or coalesce(u.assigned_roles, '{}'::text[]) &&
              array['admin', 'pharmacist', 'technician', 'procurement', 'inventory_officer', 'branch_manager']::text[]
           or coalesce(u.can_adjust_stock, false)
           or coalesce(u.can_manage_inventory, false))
  from public.users u
  where u.id = auth.uid() and u.is_active is true;
$$;

-- Puts every unit of a still-pending transfer back on the source branch.
create or replace function public.branch_transfer_return_stock(
  p_transfer_id uuid, p_actor uuid, p_note text
) returns void
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  t public.branch_stock_transfers%rowtype;
  r record;
  v_prev numeric;
  v_new numeric;
begin
  select * into t from public.branch_stock_transfers where id = p_transfer_id;
  for r in
    select i.source_drug_id, i.quantity_sent, d.quantity as current_quantity
    from public.branch_stock_transfer_items i
    join public.drugs d on d.id = i.source_drug_id
    where i.transfer_id = p_transfer_id
    order by i.source_drug_id
    for update of d
  loop
    v_prev := coalesce(r.current_quantity, 0);
    v_new := v_prev + r.quantity_sent;
    update public.drugs set quantity = v_new, updated_at = now() where id = r.source_drug_id;
    insert into public.stock_movements (
      drug_id, movement_type, quantity, previous_quantity, new_quantity, reference_id,
      notes, created_by, organization_id, branch_id, destination_branch_id, created_at
    ) values (
      r.source_drug_id, 'transfer_in', r.quantity_sent, v_prev, v_new, t.id,
      p_note, p_actor, t.organization_id, t.source_branch_id, t.destination_branch_id, now()
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Dispatch
-- ---------------------------------------------------------------------------

create or replace function public.create_branch_stock_transfer(
  p_source_branch_id uuid, p_destination_branch_id uuid, p_items jsonb, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  a record;
  v_src public.branches%rowtype;
  v_dst public.branches%rowtype;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_count integer;
  v_wanted integer;
  v_transfer uuid;
  v_number text;
  v_prev numeric;
  v_new numeric;
  r record;
begin
  select * into a from public.branch_transfer_actor();
  if a.organization_id is null or not a.can_send then
    raise exception 'Only inventory staff can transfer stock.';
  end if;
  if v_notes is not null and length(v_notes) > 500 then
    raise exception 'Notes can be at most 500 characters.';
  end if;
  if p_source_branch_id is null or p_destination_branch_id is null or p_source_branch_id = p_destination_branch_id then
    raise exception 'Choose two different branches.';
  end if;

  select * into v_src from public.branches
   where id = p_source_branch_id and organization_id = a.organization_id and is_active is true;
  if not found then raise exception 'The sending branch could not be found.'; end if;
  select * into v_dst from public.branches
   where id = p_destination_branch_id and organization_id = a.organization_id and is_active is true;
  if not found then raise exception 'The receiving branch could not be found.'; end if;

  -- Staff tied to one branch can only dispatch from that branch; administrators
  -- and staff with no branch assigned can dispatch from any.
  if not a.is_admin and a.user_branch_id is not null and a.user_branch_id <> p_source_branch_id then
    raise exception 'You can only send stock from your own branch.';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 100 then
    raise exception 'Add between 1 and 100 medicines to the transfer.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) e
    where jsonb_typeof(e) <> 'object'
       or not (coalesce(e ->> 'drug_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       or not (coalesce(e ->> 'quantity', '') ~ '^[0-9]{1,8}(\.[0-9]{1,2})?$')
       or (case when coalesce(e ->> 'quantity', '') ~ '^[0-9]{1,8}(\.[0-9]{1,2})?$'
                then (e ->> 'quantity')::numeric <= 0 else true end)
  ) then
    raise exception 'Every line needs a medicine and a quantity above zero (up to 2 decimals).';
  end if;

  select count(distinct (e ->> 'drug_id')::uuid) into v_wanted from jsonb_array_elements(p_items) e;

  v_number := 'TRF-' || lpad(nextval('public.branch_stock_transfer_number_seq')::text, 6, '0');
  insert into public.branch_stock_transfers
    (organization_id, transfer_number, source_branch_id, destination_branch_id, notes, created_by)
  values (a.organization_id, v_number, p_source_branch_id, p_destination_branch_id, v_notes, a.user_id)
  returning id into v_transfer;

  v_count := 0;
  -- Lock the source rows in a fixed order so two dispatches cannot deadlock.
  for r in
    select d.id, d.name, d.batch_number, d.expiry_date, d.unit, d.quantity, d.status, d.branch_id,
           q.qty
    from (
      select (e ->> 'drug_id')::uuid as drug_id, sum((e ->> 'quantity')::numeric) as qty
      from jsonb_array_elements(p_items) e group by 1
    ) q
    join public.drugs d on d.id = q.drug_id
     and d.organization_id = a.organization_id
    order by d.id
    for update of d
  loop
    if r.branch_id is distinct from p_source_branch_id then
      raise exception '% is not stocked at the sending branch.', r.name;
    end if;
    if r.status is distinct from 'active' then
      raise exception '% is not an active product.', r.name;
    end if;
    if r.expiry_date is not null and r.expiry_date < current_date then
      raise exception '% (batch %) is expired and cannot be transferred.', r.name, coalesce(r.batch_number, '-');
    end if;
    v_prev := coalesce(r.quantity, 0);
    if v_prev < r.qty then
      raise exception 'Not enough % in stock: % available, % requested.', r.name, v_prev, r.qty;
    end if;
    v_new := v_prev - r.qty;

    insert into public.branch_stock_transfer_items
      (transfer_id, organization_id, source_drug_id, medicine_name, batch_number, expiry_date, unit, quantity_sent)
    values (v_transfer, a.organization_id, r.id, r.name, r.batch_number, r.expiry_date, r.unit, r.qty);

    update public.drugs set quantity = v_new, updated_at = now() where id = r.id;
    insert into public.stock_movements (
      drug_id, movement_type, quantity, previous_quantity, new_quantity, reference_id,
      notes, created_by, organization_id, branch_id, destination_branch_id, created_at
    ) values (
      r.id, 'transfer_out', -r.qty, v_prev, v_new, v_transfer,
      'Transfer ' || v_number || ' to ' || v_dst.name, a.user_id, a.organization_id,
      p_source_branch_id, p_destination_branch_id, now()
    );
    v_count := v_count + 1;
  end loop;

  if v_count <> v_wanted then
    raise exception 'One or more medicines could not be found.';
  end if;

  begin
    perform public.log_audit_event('stock_transfer', 'branch_stock_transfers', v_transfer, 'dispatched',
      jsonb_build_object('transfer_number', v_number, 'source_branch', v_src.name,
                         'destination_branch', v_dst.name, 'lines', v_count), a.organization_id);
  exception when others then
    null; -- the transfer rows and stock movements are the record
  end;

  return jsonb_build_object('transfer_id', v_transfer, 'transfer_number', v_number, 'status', 'pending', 'lines', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2a. Receive (full or partial)
-- ---------------------------------------------------------------------------

create or replace function public.receive_branch_stock_transfer(
  p_transfer_id uuid, p_items jsonb default null, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  a record;
  t public.branch_stock_transfers%rowtype;
  src public.drugs%rowtype;
  dst public.drugs%rowtype;
  r record;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_items integer;
  v_listed integer;
  v_recv numeric;
  v_short numeric;
  v_total_recv numeric := 0;
  v_prev numeric;
  v_new numeric;
  v_dest_id uuid;
  v_discrepancy boolean := false;
begin
  select * into a from public.branch_transfer_actor();
  if a.organization_id is null then raise exception 'You must be signed in to receive stock.'; end if;
  if v_notes is not null and length(v_notes) > 500 then
    raise exception 'Notes can be at most 500 characters.';
  end if;

  select * into t from public.branch_stock_transfers
   where id = p_transfer_id and organization_id = a.organization_id for update;
  if not found then raise exception 'Transfer not found.'; end if;
  if t.status <> 'pending' then raise exception 'This transfer is already %.', t.status; end if;
  if not (a.is_admin or (a.is_manager and (a.user_branch_id is null or a.user_branch_id = t.destination_branch_id))) then
    raise exception 'Only an administrator or the receiving branch manager can confirm this transfer.';
  end if;

  select count(*) into v_items from public.branch_stock_transfer_items where transfer_id = t.id;

  if p_items is not null then
    if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) <> v_items then
      raise exception 'Confirm the received quantity of every line.';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_items) e
      where jsonb_typeof(e) <> 'object'
         or not (coalesce(e ->> 'item_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
         or not (coalesce(e ->> 'quantity_received', '') ~ '^[0-9]{1,8}(\.[0-9]{1,2})?$')
    ) then
      raise exception 'Every line needs a received quantity of zero or more (up to 2 decimals).';
    end if;
    select count(*) into v_listed
    from public.branch_stock_transfer_items i
    where i.transfer_id = t.id
      and 1 = (select count(*) from jsonb_array_elements(p_items) e where (e ->> 'item_id')::uuid = i.id);
    if v_listed <> v_items then
      raise exception 'The received lines do not match this transfer.';
    end if;
  end if;

  for r in
    select * from public.branch_stock_transfer_items where transfer_id = t.id order by source_drug_id
  loop
    if p_items is null then
      v_recv := r.quantity_sent;
    else
      select (e ->> 'quantity_received')::numeric into v_recv
      from jsonb_array_elements(p_items) e where (e ->> 'item_id')::uuid = r.id;
    end if;
    if v_recv > r.quantity_sent then
      raise exception 'Received quantity for % cannot be more than the % sent.', r.medicine_name, r.quantity_sent;
    end if;
    v_short := r.quantity_sent - v_recv;
    v_total_recv := v_total_recv + v_recv;
    v_dest_id := null;

    select * into src from public.drugs where id = r.source_drug_id for update;

    if v_recv > 0 then
      select * into dst from public.drugs
       where organization_id = t.organization_id and branch_id = t.destination_branch_id
         and name = src.name and batch_number is not distinct from src.batch_number
       order by updated_at desc limit 1 for update;
      if found then
        v_prev := coalesce(dst.quantity, 0);
        v_new := v_prev + v_recv;
        update public.drugs
           set quantity = v_new,
               expiry_date = coalesce(src.expiry_date, expiry_date),
               price = src.price, cost_price = src.cost_price,
               supplier = coalesce(src.supplier, supplier),
               category = coalesce(src.category, category),
               description = coalesce(src.description, description),
               reorder_level = src.reorder_level, unit = src.unit,
               status = 'active', updated_at = now()
         where id = dst.id
        returning * into dst;
      else
        v_prev := 0;
        v_new := v_recv;
        insert into public.drugs (
          organization_id, branch_id, name, batch_number, expiry_date, quantity, unit, price,
          cost_price, supplier, category, description, reorder_level, status, created_by
        ) values (
          t.organization_id, t.destination_branch_id, src.name, src.batch_number, src.expiry_date,
          v_recv, src.unit, src.price, src.cost_price, src.supplier, src.category, src.description,
          src.reorder_level, 'active', a.user_id
        ) returning * into dst;
      end if;
      v_dest_id := dst.id;
      insert into public.stock_movements (
        drug_id, movement_type, quantity, previous_quantity, new_quantity, reference_id,
        notes, created_by, organization_id, branch_id, destination_branch_id, created_at
      ) values (
        dst.id, 'transfer_in', v_recv, v_prev, v_new, t.id,
        'Received transfer ' || t.transfer_number, a.user_id, t.organization_id,
        t.destination_branch_id, t.source_branch_id, now()
      );
    end if;

    if v_short > 0 then
      v_discrepancy := true;
      v_prev := coalesce(src.quantity, 0);
      v_new := v_prev + v_short;
      update public.drugs set quantity = v_new, updated_at = now() where id = src.id;
      insert into public.stock_movements (
        drug_id, movement_type, quantity, previous_quantity, new_quantity, reference_id,
        notes, created_by, organization_id, branch_id, destination_branch_id, created_at
      ) values (
        src.id, 'transfer_in', v_short, v_prev, v_new, t.id,
        'Returned short quantity from transfer ' || t.transfer_number, a.user_id, t.organization_id,
        t.source_branch_id, t.destination_branch_id, now()
      );
    end if;

    update public.branch_stock_transfer_items
       set quantity_received = v_recv, destination_drug_id = v_dest_id
     where id = r.id;
  end loop;

  if v_total_recv <= 0 then
    raise exception 'Nothing was received. Use Reject to send the whole transfer back.';
  end if;

  update public.branch_stock_transfers
     set status = 'received', resolved_by = a.user_id, resolved_at = now(), resolution_notes = v_notes
   where id = t.id;

  begin
    perform public.log_audit_event('stock_transfer', 'branch_stock_transfers', t.id, 'received',
      jsonb_build_object('transfer_number', t.transfer_number, 'discrepancy', v_discrepancy), t.organization_id);
  exception when others then
    null;
  end;

  return jsonb_build_object('transfer_id', t.id, 'transfer_number', t.transfer_number,
                            'status', 'received', 'discrepancy', v_discrepancy);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2b. Reject (receiver) / 2c. Cancel (sender): stock goes back to the source
-- ---------------------------------------------------------------------------

create or replace function public.reject_branch_stock_transfer(p_transfer_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  a record;
  t public.branch_stock_transfers%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into a from public.branch_transfer_actor();
  if a.organization_id is null then raise exception 'You must be signed in to reject a transfer.'; end if;
  if length(v_reason) < 5 or length(v_reason) > 500 then
    raise exception 'Enter a reason of 5 to 500 characters.';
  end if;
  select * into t from public.branch_stock_transfers
   where id = p_transfer_id and organization_id = a.organization_id for update;
  if not found then raise exception 'Transfer not found.'; end if;
  if t.status <> 'pending' then raise exception 'This transfer is already %.', t.status; end if;
  if not (a.is_admin or (a.is_manager and (a.user_branch_id is null or a.user_branch_id = t.destination_branch_id))) then
    raise exception 'Only an administrator or the receiving branch manager can reject this transfer.';
  end if;

  perform public.branch_transfer_return_stock(t.id, a.user_id, 'Rejected transfer ' || t.transfer_number || ': ' || v_reason);
  update public.branch_stock_transfers
     set status = 'rejected', resolved_by = a.user_id, resolved_at = now(), resolution_notes = v_reason
   where id = t.id;
  begin
    perform public.log_audit_event('stock_transfer', 'branch_stock_transfers', t.id, 'rejected',
      jsonb_build_object('transfer_number', t.transfer_number, 'reason', v_reason), t.organization_id);
  exception when others then
    null;
  end;
  return jsonb_build_object('transfer_id', t.id, 'transfer_number', t.transfer_number, 'status', 'rejected');
end;
$$;

create or replace function public.cancel_branch_stock_transfer(p_transfer_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  a record;
  t public.branch_stock_transfers%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into a from public.branch_transfer_actor();
  if a.organization_id is null then raise exception 'You must be signed in to cancel a transfer.'; end if;
  if length(v_reason) < 5 or length(v_reason) > 500 then
    raise exception 'Enter a reason of 5 to 500 characters.';
  end if;
  select * into t from public.branch_stock_transfers
   where id = p_transfer_id and organization_id = a.organization_id for update;
  if not found then raise exception 'Transfer not found.'; end if;
  if t.status <> 'pending' then raise exception 'This transfer is already %.', t.status; end if;
  if not (t.created_by = a.user_id or a.is_admin
          or (a.is_manager and (a.user_branch_id is null or a.user_branch_id = t.source_branch_id))) then
    raise exception 'Only the sender, an administrator or the sending branch manager can cancel this transfer.';
  end if;

  perform public.branch_transfer_return_stock(t.id, a.user_id, 'Cancelled transfer ' || t.transfer_number || ': ' || v_reason);
  update public.branch_stock_transfers
     set status = 'cancelled', resolved_by = a.user_id, resolved_at = now(), resolution_notes = v_reason
   where id = t.id;
  begin
    perform public.log_audit_event('stock_transfer', 'branch_stock_transfers', t.id, 'cancelled',
      jsonb_build_object('transfer_number', t.transfer_number, 'reason', v_reason), t.organization_id);
  exception when others then
    null;
  end;
  return jsonb_build_object('transfer_id', t.id, 'transfer_number', t.transfer_number, 'status', 'cancelled');
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Branch creation for administrators and branch managers
-- ---------------------------------------------------------------------------

create or replace function public.create_pharmacy_branch(
  p_name text, p_code text default null, p_phone text default null, p_email text default null,
  p_address text default null, p_city text default null, p_region text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  a record;
  v_name text := btrim(coalesce(p_name, ''));
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
  v_city text := nullif(btrim(coalesce(p_city, '')), '');
  v_region text := nullif(btrim(coalesce(p_region, '')), '');
  v_branch public.branches%rowtype;
begin
  select * into a from public.branch_transfer_actor();
  if a.organization_id is null or not (a.is_admin or a.is_manager) then
    raise exception 'Only an administrator or branch manager can create a branch.';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Enter a branch name of 2 to 120 characters.';
  end if;
  if length(coalesce(v_code, '')) > 50 or length(coalesce(v_phone, '')) > 20
     or length(coalesce(v_email, '')) > 255 or length(coalesce(v_city, '')) > 100
     or length(coalesce(v_region, '')) > 100 or length(coalesce(v_address, '')) > 500 then
    raise exception 'One of the branch details is too long.';
  end if;
  -- Same rule the Settings screen shows: a pharmacy gets a second branch only when the
  -- platform administrator has switched multi-branch on for it (Tenant Admin).
  if not coalesce((select o.can_use_multi_branch from public.organizations o where o.id = a.organization_id), false)
     and (select count(*) from public.branches b
           where b.organization_id = a.organization_id and b.is_active is true) >= 1 then
    raise exception 'Multi-branch is not enabled for this pharmacy. Ask the platform administrator to enable it before adding another branch.';
  end if;
  if exists (
    select 1 from public.branches b
    where b.organization_id = a.organization_id and b.is_active is true
      and (lower(btrim(b.name)) = lower(v_name)
           or (v_code is not null and lower(btrim(coalesce(b.code, ''))) = lower(v_code)))
  ) then
    raise exception 'A branch with this name or code already exists.';
  end if;

  insert into public.branches (organization_id, name, code, phone, email, address, city, region, is_main)
  values (a.organization_id, v_name, v_code, v_phone, v_email, v_address, v_city, v_region, false)
  returning * into v_branch;

  begin
    perform public.log_audit_event('branch', 'branches', v_branch.id, 'created',
      jsonb_build_object('name', v_name), a.organization_id);
  exception when others then
    null;
  end;
  return to_jsonb(v_branch);
end;
$$;

revoke all on function public.branch_transfer_actor() from public, anon, authenticated;
revoke all on function public.branch_transfer_return_stock(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.create_branch_stock_transfer(uuid, uuid, jsonb, text) from public, anon;
revoke all on function public.receive_branch_stock_transfer(uuid, jsonb, text) from public, anon;
revoke all on function public.reject_branch_stock_transfer(uuid, text) from public, anon;
revoke all on function public.cancel_branch_stock_transfer(uuid, text) from public, anon;
revoke all on function public.create_pharmacy_branch(text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_branch_stock_transfer(uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.receive_branch_stock_transfer(uuid, jsonb, text) to authenticated;
grant execute on function public.reject_branch_stock_transfer(uuid, text) to authenticated;
grant execute on function public.cancel_branch_stock_transfer(uuid, text) to authenticated;
grant execute on function public.create_pharmacy_branch(text, text, text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
commit;
