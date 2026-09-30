-- Reject incomplete stock links atomically; serialize inventory increments.
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
  v_match_ids uuid[];
  v_match_text text;
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
    select * from public.purchase_items where purchase_id = p_purchase_id order by drug_id, id for update
  loop
    if v_item.drug_id is null then
      -- A supplied brand must never silently fall back to a generic medicine.
      v_match_text := coalesce(nullif(btrim(v_item.brand_name), ''), nullif(btrim(v_item.drug_name), ''));
      select array_agg(d.id order by d.id) into v_match_ids
      from public.drugs d
      where d.organization_id = v_purchase.organization_id
        and d.branch_id is not distinct from v_purchase.branch_id
        and d.status = 'active'
        and (
          lower(btrim(d.name)) = lower(v_match_text)
          or (nullif(btrim(v_item.brand_name), '') is not null
              and lower(btrim(d.brand_name)) = lower(v_match_text))
        );
      if coalesce(cardinality(v_match_ids), 0) <> 1 then
        raise exception 'Purchase item "%": found % exact inventory matches for "%" in this branch. Select the intended inventory medicine before completing.',
          v_item.drug_name, coalesce(cardinality(v_match_ids), 0), v_match_text;
      end if;
      v_item.drug_id := v_match_ids[1];
      update public.purchase_items set drug_id = v_item.drug_id where id = v_item.id;
    end if;
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'Purchase item "%" must have a positive quantity.', v_item.drug_name;
    end if;
    if v_item.drug_id is not null then
      select coalesce(quantity, 0) into v_old_qty
      from public.drugs
      where id = v_item.drug_id
        and organization_id = v_purchase.organization_id
        and (v_purchase.branch_id is null or branch_id = v_purchase.branch_id)
      for update;
      if not found then
        raise exception 'Purchase item % is not available in this facility and branch.', v_item.drug_name;
      end if;

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
      where id = v_item.drug_id
        and organization_id = v_purchase.organization_id
        and (v_purchase.branch_id is null or branch_id = v_purchase.branch_id);

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

  if v_items_updated = 0 then
    raise exception 'Add at least one linked inventory item before completing this purchase.';
  end if;
  update public.purchase_items set received_quantity = quantity where purchase_id = p_purchase_id;

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

revoke all on function public.complete_purchase(uuid) from public, anon;
