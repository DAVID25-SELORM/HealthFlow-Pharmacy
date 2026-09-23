-- Reorder Centre phase 2: a real purchase-order lifecycle with partial receiving.
--
--   draft -> ordered -> partially_received -> completed (received)
--   draft/ordered/partially_received -> cancelled
--
-- 'completed' is kept as the "fully received" state so every existing purchase and the
-- existing complete_purchase() flow (draft -> completed in one step) keep working
-- unchanged. Stock only ever increases when goods are actually received, using the same
-- statements complete_purchase() already uses (drugs update + stock_movements row).
--
-- Additive only: no historical purchase, item, supplier or stock row is rewritten.
begin;

-- ---------------------------------------------------------------- statuses
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.purchases'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
      and pg_get_constraintdef(oid) ilike '%draft%'
  loop
    execute format('alter table public.purchases drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.purchases
  add constraint purchases_status_check
  check (status in ('draft', 'ordered', 'partially_received', 'completed', 'cancelled'));

alter table public.purchases
  add column if not exists ordered_at timestamptz,
  add column if not exists ordered_by uuid references public.users(id),
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references public.users(id),
  add column if not exists cancellation_reason text;

-- ------------------------------------------------- ordered / received quantities
-- quantity is what was ordered; received_quantity is what has physically arrived.
-- Outstanding = quantity - received_quantity (computed, never stored, so it cannot drift).
alter table public.purchase_items
  add column if not exists received_quantity numeric(10,2) not null default 0;

alter table public.purchase_items
  drop constraint if exists purchase_items_received_within_ordered;
alter table public.purchase_items
  add constraint purchase_items_received_within_ordered
  check (received_quantity >= 0 and received_quantity <= quantity);

-- ------------------------------------------------------------------ receipts
create table if not exists public.purchase_receipts (
  id               uuid          primary key default gen_random_uuid(),
  organization_id  uuid          not null references public.organizations(id) on delete restrict,
  purchase_id      uuid          not null references public.purchases(id) on delete restrict,
  purchase_item_id uuid          not null references public.purchase_items(id) on delete restrict,
  drug_id          uuid          references public.drugs(id),
  receipt_key      text          not null,
  received_quantity numeric(10,2) not null check (received_quantity > 0),
  batch_number     text,
  expiry_date      date,
  unit_cost        numeric(10,2) not null default 0 check (unit_cost >= 0),
  received_by      uuid          references public.users(id),
  received_at      timestamptz   not null default now(),
  notes            text
);

create index if not exists idx_purchase_receipts_purchase on public.purchase_receipts(purchase_id);
create index if not exists idx_purchase_receipts_org_drug on public.purchase_receipts(organization_id, drug_id);

alter table public.purchase_receipts enable row level security;

drop policy if exists purchase_receipts_select on public.purchase_receipts;
create policy purchase_receipts_select on public.purchase_receipts
  for select to authenticated
  using (organization_id = public.user_organization_id());

-- Receipts are written only by receive_purchase_goods() below.
revoke insert, update, delete on public.purchase_receipts from anon, authenticated;

-- --------------------------------------------------------------- permissions
create or replace function public.user_can_manage_purchases()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users
    where id = auth.uid()
      and is_active = true
      and (
        role in ('admin', 'super_admin')
        or can_manage_purchases = true
      )
  );
$$;

revoke all on function public.user_can_manage_purchases() from public;
grant execute on function public.user_can_manage_purchases() to authenticated;

-- Audit must never block a purchasing action, so a logging failure is swallowed.
create or replace function public.log_purchase_event(
  p_event_type text,
  p_purchase_id uuid,
  p_action text,
  p_details jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.log_audit_event(p_event_type, 'purchases', p_purchase_id, p_action, p_details);
exception when others then
  null;
end;
$$;

revoke all on function public.log_purchase_event(text, uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- place order
create or replace function public.place_purchase_order(p_purchase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase public.purchases%rowtype;
  v_item_count integer;
begin
  if not public.user_can_manage_purchases() then
    return jsonb_build_object('error', 'You do not have permission to place purchase orders.');
  end if;

  select * into v_purchase
  from public.purchases
  where id = p_purchase_id
    and organization_id = public.user_organization_id()
  for update;

  if not found then
    return jsonb_build_object('error', 'Purchase not found.');
  end if;
  if v_purchase.status <> 'draft' then
    return jsonb_build_object('error', 'Only a draft can be placed as an order.');
  end if;
  if nullif(btrim(coalesce(v_purchase.supplier_name, '')), '') is null and v_purchase.supplier_id is null then
    return jsonb_build_object('error', 'Choose a supplier before placing the order.');
  end if;

  select count(*) into v_item_count from public.purchase_items where purchase_id = p_purchase_id;
  if v_item_count = 0 then
    return jsonb_build_object('error', 'Add at least one item before placing the order.');
  end if;
  if exists (select 1 from public.purchase_items where purchase_id = p_purchase_id and quantity <= 0) then
    return jsonb_build_object('error', 'Every item needs a quantity above zero before the order is placed.');
  end if;

  update public.purchases
  set status = 'ordered', ordered_at = now(), ordered_by = auth.uid(), updated_at = now()
  where id = p_purchase_id;

  perform public.log_purchase_event('PURCHASE_ORDER_PLACED', p_purchase_id, 'place_order', jsonb_build_object(
    'purchase_number', v_purchase.purchase_number,
    'supplier_name', v_purchase.supplier_name,
    'item_count', v_item_count,
    'total_amount', v_purchase.total_amount
  ));

  return jsonb_build_object('success', true, 'status', 'ordered');
end;
$$;

revoke all on function public.place_purchase_order(uuid) from public, anon;
grant execute on function public.place_purchase_order(uuid) to authenticated;

-- -------------------------------------------------------------- receive goods
-- p_lines: [{ "purchase_item_id": uuid, "quantity": n, "batch_number": text,
--             "expiry_date": date, "unit_cost": n }, ...]
-- One line per delivered batch; the same item may appear more than once. p_receipt_key
-- makes a retried call harmless: the same key on the same purchase never posts stock twice.
create or replace function public.receive_purchase_goods(
  p_purchase_id uuid,
  p_lines jsonb,
  p_receipt_key text,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase public.purchases%rowtype;
  v_line jsonb;
  v_item public.purchase_items%rowtype;
  v_qty numeric(10,2);
  v_unit_cost numeric(10,2);
  v_expiry date;
  v_batch text;
  v_old_qty numeric;
  v_new_qty numeric;
  v_note text;
  v_received_total numeric := 0;
  v_line_count integer := 0;
  v_outstanding numeric;
  v_new_status text;
  v_over record;
begin
  if not public.user_can_approve_purchases() then
    return jsonb_build_object('error', 'You do not have permission to receive stock.');
  end if;
  if nullif(btrim(coalesce(p_receipt_key, '')), '') is null then
    return jsonb_build_object('error', 'A receipt key is required.');
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('error', 'Enter at least one received item.');
  end if;

  select * into v_purchase
  from public.purchases
  where id = p_purchase_id
    and organization_id = public.user_organization_id()
  for update;

  if not found then
    return jsonb_build_object('error', 'Purchase not found.');
  end if;

  -- A retry of a call that already posted: report the current state, change nothing.
  if exists (
    select 1 from public.purchase_receipts
    where purchase_id = p_purchase_id and receipt_key = p_receipt_key
  ) then
    return jsonb_build_object('success', true, 'already_processed', true, 'status', v_purchase.status);
  end if;

  if v_purchase.status not in ('ordered', 'partially_received') then
    return jsonb_build_object('error', 'Goods can only be received against an order that has been placed and is not yet fully received.');
  end if;

  -- Validation pass (no writes): every line must be positive and, per item, the total
  -- across lines must not exceed what is still outstanding.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    begin
      v_qty := (v_line ->> 'quantity')::numeric;
    exception when others then
      return jsonb_build_object('error', 'Each received quantity must be a number.');
    end;
    if v_qty is null or v_qty <= 0 then
      return jsonb_build_object('error', 'Each received quantity must be above zero.');
    end if;
    if not exists (
      select 1 from public.purchase_items
      where id = (v_line ->> 'purchase_item_id')::uuid and purchase_id = p_purchase_id
    ) then
      return jsonb_build_object('error', 'A received line does not belong to this order.');
    end if;
  end loop;

  select l.item_id, i.quantity, i.received_quantity, l.total
  into v_over
  from (
    select (x ->> 'purchase_item_id')::uuid as item_id, sum((x ->> 'quantity')::numeric) as total
    from jsonb_array_elements(p_lines) x
    group by 1
  ) l
  join public.purchase_items i on i.id = l.item_id
  where l.total > i.quantity - i.received_quantity
  limit 1;

  if found then
    return jsonb_build_object('error', format(
      'Cannot receive %s: only %s outstanding on that item.',
      trim_scale(v_over.total), trim_scale(v_over.quantity - v_over.received_quantity)
    ));
  end if;

  v_note := 'Purchase: ' || coalesce(v_purchase.purchase_number, '')
    || case when v_purchase.invoice_number is not null
            then ' / Invoice: ' || v_purchase.invoice_number else '' end
    || ' (goods received)';

  -- Apply pass.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line ->> 'quantity')::numeric;
    v_batch := nullif(btrim(coalesce(v_line ->> 'batch_number', '')), '');
    v_expiry := nullif(v_line ->> 'expiry_date', '')::date;

    select * into v_item
    from public.purchase_items
    where id = (v_line ->> 'purchase_item_id')::uuid
    for update;

    v_unit_cost := coalesce(nullif(v_line ->> 'unit_cost', '')::numeric, v_item.unit_cost);

    update public.purchase_items
    set received_quantity = received_quantity + v_qty
    where id = v_item.id;

    insert into public.purchase_receipts (
      organization_id, purchase_id, purchase_item_id, drug_id, receipt_key,
      received_quantity, batch_number, expiry_date, unit_cost, received_by, received_at, notes
    ) values (
      v_purchase.organization_id, p_purchase_id, v_item.id, v_item.drug_id, p_receipt_key,
      v_qty, v_batch, v_expiry, v_unit_cost, auth.uid(), now(), nullif(btrim(coalesce(p_notes, '')), '')
    );

    if v_item.drug_id is not null then
      select coalesce(quantity, 0) into v_old_qty from public.drugs where id = v_item.drug_id;
      v_new_qty := v_old_qty + v_qty;

      update public.drugs
      set
        quantity = v_new_qty,
        brand_name = coalesce(nullif(trim(v_item.brand_name), ''), brand_name),
        generic_name = coalesce(nullif(trim(v_item.generic_name), ''), generic_name),
        sale_on_return = coalesce(v_item.sale_on_return, sale_on_return),
        batch_number = coalesce(v_batch, batch_number),
        expiry_date = coalesce(v_expiry, expiry_date),
        cost_price = case when v_unit_cost > 0 then v_unit_cost else cost_price end,
        updated_at = now()
      where id = v_item.drug_id;

      insert into public.stock_movements (
        drug_id, movement_type, quantity,
        previous_quantity, new_quantity,
        reference_id, notes, created_by,
        organization_id, created_at
      ) values (
        v_item.drug_id, 'purchase', v_qty,
        v_old_qty, v_new_qty,
        p_purchase_id, v_note, auth.uid(),
        v_purchase.organization_id, now()
      );
    end if;

    v_received_total := v_received_total + v_qty;
    v_line_count := v_line_count + 1;
  end loop;

  select coalesce(sum(quantity - received_quantity), 0) into v_outstanding
  from public.purchase_items where purchase_id = p_purchase_id;

  v_new_status := case when v_outstanding <= 0 then 'completed' else 'partially_received' end;

  update public.purchases
  set status = v_new_status, updated_at = now()
  where id = p_purchase_id;

  perform public.log_purchase_event(
    case when v_new_status = 'completed' then 'GOODS_RECEIVED' else 'GOODS_PARTIALLY_RECEIVED' end,
    p_purchase_id,
    'receive_goods',
    jsonb_build_object(
      'purchase_number', v_purchase.purchase_number,
      'receipt_key', p_receipt_key,
      'lines', v_line_count,
      'received_total', v_received_total,
      'outstanding_after', v_outstanding
    )
  );

  return jsonb_build_object(
    'success', true,
    'status', v_new_status,
    'lines', v_line_count,
    'received_total', v_received_total,
    'outstanding', v_outstanding
  );
end;
$$;

revoke all on function public.receive_purchase_goods(uuid, jsonb, text, text) from public, anon;
grant execute on function public.receive_purchase_goods(uuid, jsonb, text, text) to authenticated;

-- ------------------------------------------------------------------- cancel
-- Cancelling never changes stock: anything already received stays received, and the
-- remaining outstanding quantity simply stops counting as incoming.
create or replace function public.cancel_purchase_order(p_purchase_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase public.purchases%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_outstanding numeric;
begin
  if not public.user_can_manage_purchases() then
    return jsonb_build_object('error', 'You do not have permission to cancel purchase orders.');
  end if;

  select * into v_purchase
  from public.purchases
  where id = p_purchase_id
    and organization_id = public.user_organization_id()
  for update;

  if not found then
    return jsonb_build_object('error', 'Purchase not found.');
  end if;
  if v_purchase.status not in ('draft', 'ordered', 'partially_received') then
    return jsonb_build_object('error', 'Only a draft or an order that is not fully received can be cancelled.');
  end if;
  if v_purchase.status <> 'draft' and v_reason is null then
    return jsonb_build_object('error', 'Enter a reason for cancelling an order that has been placed.');
  end if;

  select coalesce(sum(quantity - received_quantity), 0) into v_outstanding
  from public.purchase_items where purchase_id = p_purchase_id;

  update public.purchases
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
      cancellation_reason = v_reason, updated_at = now()
  where id = p_purchase_id;

  perform public.log_purchase_event('PURCHASE_ORDER_CANCELLED', p_purchase_id, 'cancel', jsonb_build_object(
    'purchase_number', v_purchase.purchase_number,
    'previous_status', v_purchase.status,
    'outstanding_cancelled', v_outstanding,
    'reason', v_reason
  ));

  return jsonb_build_object('success', true, 'status', 'cancelled', 'outstanding_cancelled', v_outstanding);
end;
$$;

revoke all on function public.cancel_purchase_order(uuid, text) from public, anon;
grant execute on function public.cancel_purchase_order(uuid, text) to authenticated;

-- complete_purchase(): unchanged behaviour (draft -> completed, receive everything), plus
-- it now records the received quantity so completed orders read consistently.
create or replace function public.complete_purchase(p_purchase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase public.purchases%rowtype;
  v_item public.purchase_items%rowtype;
  v_old_qty decimal(10,2);
  v_new_qty decimal(10,2);
  v_items_updated integer := 0;
  v_note text;
begin
  if not public.user_can_approve_purchases() then
    return jsonb_build_object('error', 'You do not have permission to approve purchases.');
  end if;

  select * into v_purchase
  from public.purchases
  where id = p_purchase_id
    and organization_id = public.user_organization_id()
  for update;

  if not found then
    return jsonb_build_object('error', 'Purchase not found.');
  end if;

  if v_purchase.status != 'draft' then
    return jsonb_build_object('error', 'Only draft purchases can be completed.');
  end if;

  v_note := 'Purchase: ' || coalesce(v_purchase.purchase_number, '')
    || case when v_purchase.invoice_number is not null
            then ' / Invoice: ' || v_purchase.invoice_number
            else '' end;

  for v_item in
    select * from public.purchase_items where purchase_id = p_purchase_id
  loop
    if v_item.drug_id is not null then
      select coalesce(quantity, 0) into v_old_qty
      from public.drugs
      where id = v_item.drug_id;

      v_new_qty := v_old_qty + v_item.quantity;

      update public.drugs
      set
        quantity = v_new_qty,
        brand_name = coalesce(nullif(trim(v_item.brand_name), ''), brand_name),
        generic_name = coalesce(nullif(trim(v_item.generic_name), ''), generic_name),
        sale_on_return = coalesce(v_item.sale_on_return, sale_on_return),
        batch_number = coalesce(nullif(trim(v_item.batch_number), ''), batch_number),
        expiry_date = coalesce(v_item.expiry_date, expiry_date),
        cost_price = case when v_item.unit_cost > 0 then v_item.unit_cost else cost_price end,
        updated_at = now()
      where id = v_item.drug_id;

      insert into public.stock_movements (
        drug_id, movement_type, quantity,
        previous_quantity, new_quantity,
        reference_id, notes, created_by,
        organization_id, created_at
      ) values (
        v_item.drug_id, 'purchase', v_item.quantity,
        v_old_qty, v_new_qty,
        p_purchase_id, v_note, auth.uid(),
        v_purchase.organization_id, now()
      );

      v_items_updated := v_items_updated + 1;
    end if;
  end loop;

  update public.purchase_items
  set received_quantity = quantity
  where purchase_id = p_purchase_id;

  update public.purchases
  set status = 'completed', updated_at = now()
  where id = p_purchase_id;

  return jsonb_build_object(
    'success', true,
    'items_updated', v_items_updated
  );
end;
$$;

notify pgrst, 'reload schema';

commit;
