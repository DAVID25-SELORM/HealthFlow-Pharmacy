-- The shift cash drawer ignores the cash a patient hands over for their portion of an insurance / NHIA claim sale.
--
-- create_sale_transaction() and branch_sync_create_sale_transaction() post a 'sale_cash' shift movement (and raise the
-- shift's expected cash) only when the sale's payment_method is 'cash'. An insurance or NHIA claim sale is stored as
-- payment_method 'insurance' with the patient's cash portion in insurance_top_up_amount / insurance_top_up_payment_method,
-- so that cash never reached shift_cash_movements or expected_cash. refund_sale_transaction() already assumes it did: it
-- pays such refunds out of the drawer (refund_cash, insurance_top_up_amount). A refund therefore drives expected cash
-- below what was ever counted in.
--
-- This patches both sale functions in place, right before their existing cash block, to post the patient's cash portion
-- (insurance_top_up_amount when insurance_top_up_payment_method = 'cash') exactly like a cash sale does. Momo/card
-- portions are unchanged (not drawer cash). Historical sales are not backfilled: production has no insurance sale
-- with a cash portion yet. The patch fails closed (aborts the whole migration) if either definition is not the expected
-- one, and does nothing if it was already applied.
begin;

do $$
declare
  v_name text;
  v_definition text;
  v_cash_block_pattern constant text :=
    'IF\s+payment_method_value\s*=\s*''cash''\s+AND\s+payment_status_value\s*=\s*''completed''\s+AND\s+net_amount\s*>\s*0';
  v_match text[];
  v_position integer;
  v_block constant text := $block$
  IF payment_method_value = 'insurance'
    AND payment_status_value = 'completed'
    AND COALESCE(insurance_top_up_value, 0) > 0
    AND insurance_top_up_method_value = 'cash'
    AND shift_id_value IS NOT NULL THEN
    DECLARE
      v_topup_shift RECORD;
    BEGIN
      SELECT organization_id, branch_id INTO v_topup_shift FROM public.shifts WHERE id = shift_id_value;

      INSERT INTO public.shift_cash_movements (
        shift_id, organization_id, branch_id, movement_type, source_type, source_id,
        amount, direction, description, created_by
      )
      VALUES (
        shift_id_value, v_topup_shift.organization_id, v_topup_shift.branch_id,
        'sale_cash', 'sale', sale_record.id, insurance_top_up_value, 'in',
        CONCAT('Cash top-up, sale ', sale_record.sale_number), sold_by_value
      );

      PERFORM public.increment_shift_expected(shift_id_value, insurance_top_up_value);
    END;
  END IF;

  $block$;
begin
  foreach v_name in array array['public.create_sale_transaction(jsonb)', 'public.branch_sync_create_sale_transaction(text,uuid,jsonb)'] loop
    select replace(pg_get_functiondef(v_name::regprocedure), E'\r', '') into v_definition;

    if position('Cash top-up, sale ' in v_definition) > 0 then
      continue; -- already patched
    end if;

    v_match := regexp_match(v_definition, '(' || v_cash_block_pattern || ')');
    if v_match is null
       or array_length(regexp_split_to_array(v_definition, v_cash_block_pattern), 1) <> 2
       or position('insurance_top_up_value' in v_definition) = 0
       or position('insurance_top_up_method_value' in v_definition) = 0
       or position('shift_id_value' in v_definition) = 0
       or position('sale_record' in v_definition) = 0
       or position('sold_by_value' in v_definition) = 0 then
      raise exception 'Unexpected % definition; refusing to patch the cash top-up drawer posting', v_name;
    end if;

    v_position := position(v_match[1] in v_definition);
    v_definition := left(v_definition, v_position - 1) || v_block || substr(v_definition, v_position);
    execute v_definition;
  end loop;
end $$;

commit;
