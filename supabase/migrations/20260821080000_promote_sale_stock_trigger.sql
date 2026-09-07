-- Preserve the verified sale-stock contract for environments that do not yet
-- have the original baseline. Existing production definitions are left intact.

do $bootstrap$
begin
  if to_regprocedure('public.update_drug_quantity_after_sale()') is null then
    execute $function$
      create function public.update_drug_quantity_after_sale()
      returns trigger
      language plpgsql
      set search_path = public, pg_temp
      as $body$
      declare
        previous_quantity_value numeric(10, 2);
        new_quantity_value numeric(10, 2);
        sale_sold_by uuid;
      begin
        select quantity
        into previous_quantity_value
        from public.drugs
        where id = new.drug_id
        for update;

        if previous_quantity_value is null then
          raise exception 'Selected drug could not be found for this sale item';
        end if;

        if new.quantity <= 0 then
          raise exception 'Sale item quantity must be greater than zero';
        end if;

        if previous_quantity_value < new.quantity then
          raise exception 'Insufficient stock for %: only % left in inventory', new.drug_name, previous_quantity_value;
        end if;

        new_quantity_value := previous_quantity_value - new.quantity;

        update public.drugs
        set quantity = new_quantity_value,
            updated_at = now()
        where id = new.drug_id;

        select sold_by
        into sale_sold_by
        from public.sales
        where id = new.sale_id;

        insert into public.stock_movements (
          drug_id, movement_type, quantity, previous_quantity, new_quantity,
          reference_id, notes, created_by, created_at
        ) values (
          new.drug_id, 'sale', -new.quantity, previous_quantity_value,
          new_quantity_value, new.sale_id,
          concat('Sale item ', coalesce(new.drug_name, '')), sale_sold_by, now()
        );

        return new;
      end;
      $body$;
    $function$;
  end if;

  if not exists (
    select 1
    from pg_trigger trigger_definition
    where trigger_definition.tgrelid = 'public.sale_items'::regclass
      and trigger_definition.tgname = 'trigger_update_drug_quantity'
      and not trigger_definition.tgisinternal
  ) then
    execute 'create trigger trigger_update_drug_quantity after insert on public.sale_items for each row execute function public.update_drug_quantity_after_sale()';
  end if;
end;
$bootstrap$;
