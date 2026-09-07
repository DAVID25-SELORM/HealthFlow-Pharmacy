-- Bootstrap only databases missing the original branch-sale RPC. Do not
-- replace the current production definition: 20260821100000 evolves this
-- baseline with NHIS split-settlement fields.

do $bootstrap$
begin
  if to_regprocedure('public.branch_sync_create_sale_transaction(text,uuid,jsonb)') is null then
    execute $function$
      create function public.branch_sync_create_sale_transaction(
        p_sync_token text, p_local_sale_id uuid, sale_payload jsonb
      ) returns jsonb language plpgsql security definer set search_path = public as $body$
      declare
        v_client public.branch_sync_clients%rowtype;
        v_existing public.branch_sync_events%rowtype;
        sale_record public.sales%rowtype;
        item jsonb;
        total_amount numeric(12,2) := 0;
        discount_amount numeric(12,2); net_amount numeric(12,2);
        amount_paid_value numeric(12,2); change_given_value numeric(12,2);
        insurance_covered_value NUMERIC(12, 2); insurance_top_up_value NUMERIC(12, 2);
        insurance_top_up_method_value TEXT;
        payment_method_value text; payment_status_value text;
        patient_id_value uuid; sold_by_value uuid; shift_id_value uuid;
        shift_record record; item_drug_id uuid; item_name text;
        item_quantity numeric(12,2); item_price numeric(12,2); item_cost numeric(12,2);
        response_payload jsonb;
      begin
        if p_local_sale_id is null then raise exception 'Local sale ID is required.'; end if;
        v_client := public.get_branch_sync_client(p_sync_token);

        select * into v_existing from public.branch_sync_events
        where sync_client_id = v_client.id and event_type = 'sale.completed' and local_id = p_local_sale_id;
        if found then return v_existing.response; end if;

        if sale_payload is null or jsonb_typeof(sale_payload) <> 'object' then
          raise exception 'Invalid sale payload.';
        end if;
        if sale_payload->'items' is null or jsonb_array_length(sale_payload->'items') = 0 then
          raise exception 'At least one sale item is required.';
        end if;

        payment_method_value := lower(coalesce(nullif(sale_payload->>'payment_method', ''), ''));
        if payment_method_value not in ('cash', 'momo', 'insurance', 'card') then
          raise exception 'Invalid payment method.';
        end if;
        payment_status_value := lower(coalesce(nullif(sale_payload->>'payment_status', ''), 'completed'));
        if payment_status_value not in ('pending', 'completed', 'cancelled', 'refunded') then
          raise exception 'Invalid payment status.';
        end if;

        patient_id_value := nullif(sale_payload->>'patient_id', '')::uuid;
        sold_by_value := nullif(sale_payload->>'sold_by', '')::uuid;
        shift_id_value := nullif(sale_payload->>'shift_id', '')::uuid;
        if patient_id_value is not null and not exists (
          select 1 from public.patients where id = patient_id_value and organization_id = v_client.organization_id
        ) then raise exception 'Selected patient could not be found.'; end if;
        if sold_by_value is null or not exists (
          select 1 from public.users where id = sold_by_value and organization_id = v_client.organization_id
        ) then raise exception 'Sold by user could not be found.'; end if;

        if shift_id_value is not null then
          select * into shift_record from public.shifts where id = shift_id_value and status = 'open'
            and organization_id = v_client.organization_id and branch_id = v_client.branch_id
            and opened_by = sold_by_value for update;
          if not found then raise exception 'Open shift not found for this cashier and branch.'; end if;
        else
          select * into shift_record from public.shifts where status = 'open'
            and organization_id = v_client.organization_id and branch_id = v_client.branch_id
            and opened_by = sold_by_value order by opened_at desc limit 1 for update;
          if found then shift_id_value := shift_record.id; end if;
        end if;

        for item in select * from jsonb_array_elements(sale_payload->'items') loop
          item_drug_id := nullif(item->>'drugId', '')::uuid;
          item_name := nullif(item->>'name', '');
          item_quantity := coalesce(nullif(item->>'quantity', '')::numeric, -1);
          item_price := coalesce(nullif(item->>'price', '')::numeric, -1);
          if item_drug_id is null then raise exception 'Each sale item must reference a drug.'; end if;
          select name, coalesce(cost_price, 0) into item_name, item_cost from public.drugs
          where id = item_drug_id and organization_id = v_client.organization_id
            and (branch_id is null or branch_id = v_client.branch_id);
          if not found then raise exception 'Selected drug could not be found for this branch sale.'; end if;
          if item_name is null then item_name := nullif(item->>'name', ''); end if;
          if item_name is null then raise exception 'Each sale item must include a drug name.'; end if;
          if item_quantity <= 0 then raise exception 'Sale item quantity must be greater than zero.'; end if;
          if item_price < 0 then raise exception 'Sale item price must be a non-negative number.'; end if;
          total_amount := total_amount + (item_quantity * item_price);
        end loop;

        discount_amount := coalesce((sale_payload->>'discount')::numeric, 0);
        net_amount := total_amount - discount_amount;
        if discount_amount < 0 or net_amount < 0 then raise exception 'Invalid discount amount.'; end if;
        insurance_covered_value := COALESCE((sale_payload->>'insurance_covered_amount')::NUMERIC, 0);
        insurance_top_up_value := COALESCE((sale_payload->>'insurance_top_up_amount')::NUMERIC, 0);
        insurance_top_up_method_value := lower(nullif(sale_payload->>'insurance_top_up_payment_method', ''));
        IF insurance_covered_value < 0 OR insurance_top_up_value < 0 THEN raise exception 'Insurance amounts must be non-negative.'; end if;
        IF payment_method_value = 'insurance' THEN
          if abs((insurance_covered_value + insurance_top_up_value) - net_amount) > 0.01 then
            raise exception 'Insurance cover and patient top-up must add up to the sale total.';
          end if;
          if insurance_top_up_value > 0 and insurance_top_up_method_value not in ('cash', 'momo', 'card') then
            raise exception 'Insurance top-up payment method is required.';
          end if;
        else
          insurance_covered_value := 0; insurance_top_up_value := 0; insurance_top_up_method_value := null;
        end if;
        amount_paid_value := coalesce((sale_payload->>'amount_paid')::numeric, net_amount);
        change_given_value := coalesce((sale_payload->>'change_given')::numeric, 0);
        if amount_paid_value < 0 or change_given_value < 0 then raise exception 'Amount paid and change must be non-negative.'; end if;
        if payment_method_value = 'cash' and amount_paid_value < net_amount then raise exception 'Amount paid cannot be less than the sale total for cash payments.'; end if;
        if payment_method_value <> 'cash' then amount_paid_value := net_amount; change_given_value := 0; end if;

        insert into public.sales (
          organization_id, branch_id, sale_number, patient_id, total_amount, discount, net_amount,
          payment_method, payment_status, amount_paid, change_given, notes, sold_by, sale_date, shift_id,
          insurance_covered_amount, insurance_top_up_amount, insurance_top_up_payment_method
        ) values (
          v_client.organization_id, v_client.branch_id, public.generate_sale_number(), patient_id_value,
          total_amount, discount_amount, net_amount, payment_method_value, payment_status_value,
          amount_paid_value, change_given_value, nullif(sale_payload->>'notes', ''), sold_by_value,
          coalesce((sale_payload->>'sale_date')::timestamptz, now()), shift_id_value,
          insurance_covered_value, insurance_top_up_value, insurance_top_up_method_value
        ) returning * into sale_record;

        for item in select * from jsonb_array_elements(sale_payload->'items') loop
          item_drug_id := nullif(item->>'drugId', '')::uuid;
          item_name := nullif(item->>'name', '');
          item_quantity := coalesce(nullif(item->>'quantity', '')::numeric, 0);
          item_price := coalesce(nullif(item->>'price', '')::numeric, 0);
          select coalesce(nullif(item_name, ''), name), coalesce(cost_price, 0) into item_name, item_cost
          from public.drugs where id = item_drug_id and organization_id = v_client.organization_id;
          insert into public.sale_items (
            organization_id, sale_id, drug_id, drug_name, quantity, unit_price,
            total_price, unit_cost_at_sale, line_cost
          ) values (
            v_client.organization_id, sale_record.id, item_drug_id, item_name, item_quantity, item_price,
            (item_quantity * item_price), item_cost, (item_quantity * item_cost)
          );
        end loop;

        if payment_method_value = 'cash' and payment_status_value = 'completed'
          and net_amount > 0 and shift_id_value is not null then
          insert into public.shift_cash_movements (
            shift_id, organization_id, branch_id, movement_type, source_type, source_id,
            amount, direction, description, created_by
          ) values (
            shift_id_value, v_client.organization_id, v_client.branch_id, 'sale_cash', 'sale', sale_record.id,
            net_amount, 'in', concat('Cash sale ', sale_record.sale_number), sold_by_value
          );
          perform public.increment_shift_expected(shift_id_value, net_amount);
        end if;

        response_payload := jsonb_build_object('sale_id', sale_record.id, 'sale_number', sale_record.sale_number, 'branch_id', sale_record.branch_id);
        insert into public.branch_sync_events (sync_client_id, event_type, local_id, remote_id, remote_number, response)
        values (v_client.id, 'sale.completed', p_local_sale_id, sale_record.id, sale_record.sale_number, response_payload);
        return response_payload;
      end;
      $body$;
    $function$;
  end if;
end;
$bootstrap$;

grant execute on function public.branch_sync_create_sale_transaction(text, uuid, jsonb) to anon, authenticated;
