create or replace function public.user_can_approve_purchases()
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
        or can_approve_purchases = true
      )
  );
$$;

revoke all on function public.user_can_approve_purchases() from public;
grant execute on function public.user_can_approve_purchases() to authenticated;

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

  update public.purchases
  set status = 'completed', updated_at = now()
  where id = p_purchase_id;

  return jsonb_build_object(
    'success', true,
    'items_updated', v_items_updated
  );
end;
$$;

grant execute on function public.complete_purchase(uuid) to authenticated;
