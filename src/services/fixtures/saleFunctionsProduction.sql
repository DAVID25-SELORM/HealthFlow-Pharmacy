-- Production sale functions captured read-only from project bcvmiwmhtvtqrvzdovin on 2026-09-26 (pg_proc.prosrc).
-- Used to prove the cash top-up drawer migration patches the real definitions, not a lookalike.
create or replace function public.branch_sync_create_sale_transaction(p_sync_token text, p_local_sale_id uuid, sale_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $prod$
DECLARE
  v_client public.branch_sync_clients%ROWTYPE;
  v_existing public.branch_sync_events%ROWTYPE;
  sale_record public.sales%ROWTYPE;
  item JSONB;
  total_amount NUMERIC(12, 2) := 0;
  discount_amount NUMERIC(12, 2);
  net_amount NUMERIC(12, 2);
  amount_paid_value NUMERIC(12, 2);
  change_given_value NUMERIC(12, 2);
  insurance_covered_value NUMERIC(12, 2);
  insurance_top_up_value NUMERIC(12, 2);
  insurance_top_up_method_value TEXT;
    nhis_covered_value NUMERIC(12, 2);
    nhis_top_up_value NUMERIC(12, 2);
    private_non_nhis_value NUMERIC(12, 2);
    nhis_policy_adjustment_value NUMERIC(12, 2);
    nhis_top_up_policy_value TEXT;
    patient_payment_method_value TEXT;
  payment_method_value TEXT;
  payment_status_value TEXT;
  patient_id_value UUID;
  sold_by_value UUID;
  shift_id_value UUID;
  shift_record RECORD;
  item_drug_id UUID;
  item_name TEXT;
  item_quantity NUMERIC(12, 2);
  item_price NUMERIC(12, 2);
  item_cost NUMERIC(12, 2);
  response_payload JSONB;
BEGIN
  IF p_local_sale_id IS NULL THEN
    RAISE EXCEPTION 'Local sale ID is required.';
  END IF;

  v_client := public.get_branch_sync_client(p_sync_token);

  SELECT *
  INTO v_existing
  FROM public.branch_sync_events
  WHERE sync_client_id = v_client.id
    AND event_type = 'sale.completed'
    AND local_id = p_local_sale_id;

  IF FOUND THEN
    RETURN v_existing.response;
  END IF;

  IF sale_payload IS NULL OR jsonb_typeof(sale_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid sale payload.';
  END IF;

  IF sale_payload->'items' IS NULL OR jsonb_array_length(sale_payload->'items') = 0 THEN
    RAISE EXCEPTION 'At least one sale item is required.';
  END IF;

  payment_method_value := LOWER(COALESCE(NULLIF(sale_payload->>'payment_method', ''), ''));
  IF payment_method_value NOT IN ('cash', 'momo', 'insurance', 'card') THEN
    RAISE EXCEPTION 'Invalid payment method.';
  END IF;

  payment_status_value := LOWER(COALESCE(NULLIF(sale_payload->>'payment_status', ''), 'completed'));
  IF payment_status_value NOT IN ('pending', 'completed', 'cancelled', 'refunded') THEN
    RAISE EXCEPTION 'Invalid payment status.';
  END IF;

  patient_id_value := NULLIF(sale_payload->>'patient_id', '')::UUID;
  sold_by_value := NULLIF(sale_payload->>'sold_by', '')::UUID;
  shift_id_value := NULLIF(sale_payload->>'shift_id', '')::UUID;

  IF patient_id_value IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.patients
      WHERE id = patient_id_value
        AND organization_id = v_client.organization_id
    ) THEN
    RAISE EXCEPTION 'Selected patient could not be found.';
  END IF;

  IF sold_by_value IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.users
      WHERE id = sold_by_value
        AND organization_id = v_client.organization_id
    ) THEN
    RAISE EXCEPTION 'Sold by user could not be found.';
  END IF;

  IF shift_id_value IS NOT NULL THEN
    SELECT *
    INTO shift_record
    FROM public.shifts
    WHERE id = shift_id_value
      AND status = 'open'
      AND organization_id = v_client.organization_id
      AND branch_id = v_client.branch_id
      AND opened_by = sold_by_value
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Open shift not found for this cashier and branch.';
    END IF;
  ELSE
    SELECT *
    INTO shift_record
    FROM public.shifts
    WHERE status = 'open'
      AND organization_id = v_client.organization_id
      AND branch_id = v_client.branch_id
      AND opened_by = sold_by_value
    ORDER BY opened_at DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      shift_id_value := shift_record.id;
    END IF;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(sale_payload->'items') LOOP
    item_drug_id := NULLIF(item->>'drugId', '')::UUID;
    item_name := NULLIF(item->>'name', '');
    item_quantity := COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, -1);
    item_price := COALESCE(NULLIF(item->>'price', '')::NUMERIC, -1);

    IF item_drug_id IS NULL THEN
      RAISE EXCEPTION 'Each sale item must reference a drug.';
    END IF;

    SELECT name, COALESCE(cost_price, 0)
    INTO item_name, item_cost
    FROM public.drugs
    WHERE id = item_drug_id
      AND organization_id = v_client.organization_id
      AND (branch_id IS NULL OR branch_id = v_client.branch_id);

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected drug could not be found for this branch sale.';
    END IF;

    IF item_name IS NULL THEN
      item_name := NULLIF(item->>'name', '');
    END IF;

    IF item_name IS NULL THEN
      RAISE EXCEPTION 'Each sale item must include a drug name.';
    END IF;

    IF item_quantity <= 0 THEN
      RAISE EXCEPTION 'Sale item quantity must be greater than zero.';
    END IF;

    IF item_price < 0 THEN
      RAISE EXCEPTION 'Sale item price must be a non-negative number.';
    END IF;

    total_amount := total_amount + (item_quantity * item_price);
  END LOOP;

  discount_amount := COALESCE((sale_payload->>'discount')::NUMERIC, 0);
  net_amount := total_amount - discount_amount;

  IF discount_amount < 0 OR net_amount < 0 THEN
    RAISE EXCEPTION 'Invalid discount amount.';
  END IF;

  insurance_covered_value := COALESCE((sale_payload->>'insurance_covered_amount')::NUMERIC, 0);
  insurance_top_up_value := COALESCE((sale_payload->>'insurance_top_up_amount')::NUMERIC, 0);
  insurance_top_up_method_value := LOWER(NULLIF(sale_payload->>'insurance_top_up_payment_method', ''));

  nhis_covered_value := COALESCE((sale_payload->>'nhis_covered_amount')::NUMERIC, 0);
    nhis_top_up_value := COALESCE((sale_payload->>'nhis_top_up_amount')::NUMERIC, 0);
    private_non_nhis_value := COALESCE((sale_payload->>'private_non_nhis_amount')::NUMERIC, 0);
    nhis_policy_adjustment_value := COALESCE((sale_payload->>'nhis_policy_adjustment_amount')::NUMERIC, 0);
    nhis_top_up_policy_value := LOWER(NULLIF(sale_payload->>'nhis_top_up_policy', ''));
    patient_payment_method_value := LOWER(NULLIF(sale_payload->>'patient_payment_method', ''));

    IF insurance_covered_value < 0 OR insurance_top_up_value < 0
       OR nhis_covered_value < 0 OR nhis_top_up_value < 0
       OR private_non_nhis_value < 0 OR nhis_policy_adjustment_value < 0 THEN
    RAISE EXCEPTION 'Insurance amounts must be non-negative.';
  END IF;

  IF nhis_covered_value > 0 OR nhis_top_up_value > 0 OR private_non_nhis_value > 0 OR nhis_policy_adjustment_value > 0 THEN
      IF payment_method_value <> 'insurance'
         OR ABS((nhis_covered_value + nhis_top_up_value + private_non_nhis_value + nhis_policy_adjustment_value) - net_amount) > 0.01 THEN
        RAISE EXCEPTION 'NHIS settlement buckets must add up to the sale total';
      END IF;
      IF (nhis_top_up_value + private_non_nhis_value) > 0
         AND patient_payment_method_value NOT IN ('cash', 'momo', 'card') THEN
        RAISE EXCEPTION 'A patient payment method is required for NHIS top-up or private medicines';
      END IF;
    ELSIF payment_method_value = 'insurance' THEN
    IF ABS((insurance_covered_value + insurance_top_up_value) - net_amount) > 0.01 THEN
      RAISE EXCEPTION 'Insurance cover and patient top-up must add up to the sale total.';
    END IF;

    IF insurance_top_up_value > 0
      AND insurance_top_up_method_value NOT IN ('cash', 'momo', 'card') THEN
      RAISE EXCEPTION 'Insurance top-up payment method is required.';
    END IF;
  ELSE
    insurance_covered_value := 0;
    insurance_top_up_value := 0;
    insurance_top_up_method_value := NULL;
  END IF;

  amount_paid_value := COALESCE((sale_payload->>'amount_paid')::NUMERIC, net_amount);
  change_given_value := COALESCE((sale_payload->>'change_given')::NUMERIC, 0);

  IF amount_paid_value < 0 OR change_given_value < 0 THEN
    RAISE EXCEPTION 'Amount paid and change must be non-negative.';
  END IF;

  IF payment_method_value = 'cash' AND amount_paid_value < net_amount THEN
    RAISE EXCEPTION 'Amount paid cannot be less than the sale total for cash payments.';
  END IF;

  IF payment_method_value <> 'cash' THEN
    amount_paid_value := net_amount;
    change_given_value := 0;
  END IF;

  INSERT INTO public.sales (
    organization_id, branch_id, sale_number, patient_id, total_amount, discount, net_amount,
    payment_method, payment_status, amount_paid, change_given, notes,
    sold_by, sale_date, shift_id,
    insurance_covered_amount, insurance_top_up_amount, insurance_top_up_payment_method,
        nhis_covered_amount, nhis_top_up_amount, private_non_nhis_amount,
        nhis_policy_adjustment_amount, nhis_top_up_policy, patient_payment_method
  )
  VALUES (
    v_client.organization_id, v_client.branch_id, public.generate_sale_number(),
    patient_id_value, total_amount, discount_amount, net_amount,
    payment_method_value, payment_status_value, amount_paid_value, change_given_value,
    NULLIF(sale_payload->>'notes', ''), sold_by_value,
    COALESCE((sale_payload->>'sale_date')::TIMESTAMPTZ, NOW()), shift_id_value,
    insurance_covered_value, insurance_top_up_value, insurance_top_up_method_value,
        nhis_covered_value, nhis_top_up_value, private_non_nhis_value,
        nhis_policy_adjustment_value, nhis_top_up_policy_value, patient_payment_method_value
  )
  RETURNING * INTO sale_record;

  FOR item IN SELECT * FROM jsonb_array_elements(sale_payload->'items') LOOP
    item_drug_id := NULLIF(item->>'drugId', '')::UUID;
    item_name := NULLIF(item->>'name', '');
    item_quantity := COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, 0);
    item_price := COALESCE(NULLIF(item->>'price', '')::NUMERIC, 0);

    SELECT COALESCE(NULLIF(item_name, ''), name), COALESCE(cost_price, 0)
    INTO item_name, item_cost
    FROM public.drugs
    WHERE id = item_drug_id
      AND organization_id = v_client.organization_id;

    INSERT INTO public.sale_items (
      organization_id, sale_id, drug_id, drug_name, quantity, unit_price,
      total_price, unit_cost_at_sale, line_cost,
            nhis_settlement, nhis_covered_amount, patient_top_up_amount, private_amount, policy_adjustment_amount
    )
    VALUES (
      v_client.organization_id, sale_record.id, item_drug_id, item_name,
      item_quantity, item_price, (item_quantity * item_price),
      item_cost, (item_quantity * item_cost),
            NULLIF(item->>'nhis_settlement', ''),
            COALESCE((item->>'nhis_covered_amount')::numeric, 0),
            COALESCE((item->>'patient_top_up_amount')::numeric, 0),
            COALESCE((item->>'private_amount')::numeric, 0),
            COALESCE((item->>'policy_adjustment_amount')::numeric, 0)
    );
  END LOOP;

  IF payment_method_value = 'cash'
    AND payment_status_value = 'completed'
    AND net_amount > 0
    AND shift_id_value IS NOT NULL THEN
    INSERT INTO public.shift_cash_movements (
      shift_id, organization_id, branch_id, movement_type, source_type, source_id,
      amount, direction, description, created_by
    )
    VALUES (
      shift_id_value, v_client.organization_id, v_client.branch_id,
      'sale_cash', 'sale', sale_record.id, net_amount, 'in',
      CONCAT('Cash sale ', sale_record.sale_number), sold_by_value
    );

    PERFORM public.increment_shift_expected(shift_id_value, net_amount);
  END IF;

  response_payload := jsonb_build_object(
    'sale_id', sale_record.id,
    'sale_number', sale_record.sale_number,
    'branch_id', sale_record.branch_id
  );

  INSERT INTO public.branch_sync_events (
    sync_client_id,
    event_type,
    local_id,
    remote_id,
    remote_number,
    response
  )
  VALUES (
    v_client.id,
    'sale.completed',
    p_local_sale_id,
    sale_record.id,
    sale_record.sale_number,
    response_payload
  );

  RETURN response_payload;
END;
$prod$;

create or replace function public.create_sale_transaction(sale_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $prod$
DECLARE
    sale_record public.sales%ROWTYPE;
    item JSONB;
    total_amount NUMERIC(12, 2) := 0;
    discount_amount NUMERIC(12, 2);
    net_amount NUMERIC(12, 2);
    amount_paid_value NUMERIC(12, 2);
    change_given_value NUMERIC(12, 2);
    insurance_covered_value NUMERIC(12, 2);
    insurance_top_up_value NUMERIC(12, 2);
    insurance_top_up_method_value TEXT;
    nhis_covered_value NUMERIC(12, 2);
    nhis_top_up_value NUMERIC(12, 2);
    private_non_nhis_value NUMERIC(12, 2);
    nhis_policy_adjustment_value NUMERIC(12, 2);
    nhis_top_up_policy_value TEXT;
    patient_payment_method_value TEXT;
    payment_method_value TEXT;
    payment_status_value TEXT;
    patient_id_value UUID;
    sold_by_value UUID;
    shift_id_value UUID;
    shift_record RECORD;
    item_drug_id UUID;
    item_name TEXT;
    item_quantity NUMERIC(12, 2);
    item_price NUMERIC(12, 2);
    item_cost NUMERIC(12, 2);
BEGIN
    IF sale_payload IS NULL OR jsonb_typeof(sale_payload) <> 'object' THEN
        RAISE EXCEPTION 'Invalid sale payload';
    END IF;

    IF sale_payload->'items' IS NULL OR jsonb_array_length(sale_payload->'items') = 0 THEN
        RAISE EXCEPTION 'At least one sale item is required';
    END IF;

    payment_method_value := LOWER(COALESCE(NULLIF(sale_payload->>'payment_method', ''), ''));
    IF payment_method_value NOT IN ('cash', 'momo', 'insurance', 'card') THEN
        RAISE EXCEPTION 'Invalid payment method';
    END IF;

    payment_status_value := LOWER(COALESCE(NULLIF(sale_payload->>'payment_status', ''), 'completed'));
    IF payment_status_value NOT IN ('pending', 'completed', 'cancelled', 'refunded') THEN
        RAISE EXCEPTION 'Invalid payment status';
    END IF;

    patient_id_value := NULLIF(sale_payload->>'patient_id', '')::UUID;
    sold_by_value := COALESCE(NULLIF(sale_payload->>'sold_by', '')::UUID, auth.uid());
    shift_id_value := NULLIF(sale_payload->>'shift_id', '')::UUID;

    IF patient_id_value IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.patients
        WHERE id = patient_id_value
          AND organization_id = public.user_organization_id()
      ) THEN
        RAISE EXCEPTION 'Selected patient could not be found';
    END IF;

    IF sold_by_value IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = sold_by_value
          AND organization_id = public.user_organization_id()
      ) THEN
        RAISE EXCEPTION 'Sold by user could not be found';
    END IF;

    IF sold_by_value <> auth.uid() THEN
        RAISE EXCEPTION 'Sales must be processed by the signed-in cashier.';
    END IF;

    IF shift_id_value IS NULL THEN
        RAISE EXCEPTION 'Open a shift before completing sales.';
    END IF;

    SELECT *
    INTO shift_record
    FROM public.shifts
    WHERE id = shift_id_value
      AND status = 'open'
      AND organization_id = public.user_organization_id()
      AND opened_by = sold_by_value
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Open shift not found for this cashier.';
    END IF;

    FOR item IN SELECT * FROM jsonb_array_elements(sale_payload->'items') LOOP
        item_drug_id := NULLIF(item->>'drugId', '')::UUID;
        item_name := NULLIF(item->>'name', '');
        item_quantity := COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, -1);
        item_price := COALESCE(NULLIF(item->>'price', '')::NUMERIC, -1);

        IF item_drug_id IS NULL THEN
            RAISE EXCEPTION 'Each sale item must reference a drug';
        END IF;

        SELECT name, COALESCE(cost_price, 0)
        INTO item_name, item_cost
        FROM public.drugs
        WHERE id = item_drug_id
          AND organization_id = public.user_organization_id();

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Selected drug could not be found for this sale';
        END IF;

        IF item_name IS NULL THEN
            item_name := NULLIF(item->>'name', '');
        END IF;

        IF item_name IS NULL THEN
            RAISE EXCEPTION 'Each sale item must include a drug name';
        END IF;

        IF item_quantity <= 0 THEN
            RAISE EXCEPTION 'Sale item quantity must be greater than zero';
        END IF;

        IF item_price < 0 THEN
            RAISE EXCEPTION 'Sale item price must be a non-negative number';
        END IF;

        total_amount := total_amount + (item_quantity * item_price);
    END LOOP;

    discount_amount := COALESCE((sale_payload->>'discount')::NUMERIC, 0);
    net_amount := total_amount - discount_amount;

    IF discount_amount < 0 OR net_amount < 0 THEN
        RAISE EXCEPTION 'Invalid discount amount';
    END IF;

    insurance_covered_value := COALESCE((sale_payload->>'insurance_covered_amount')::NUMERIC, 0);
    insurance_top_up_value := COALESCE((sale_payload->>'insurance_top_up_amount')::NUMERIC, 0);
    insurance_top_up_method_value := LOWER(NULLIF(sale_payload->>'insurance_top_up_payment_method', ''));

    nhis_covered_value := COALESCE((sale_payload->>'nhis_covered_amount')::NUMERIC, 0);
    nhis_top_up_value := COALESCE((sale_payload->>'nhis_top_up_amount')::NUMERIC, 0);
    private_non_nhis_value := COALESCE((sale_payload->>'private_non_nhis_amount')::NUMERIC, 0);
    nhis_policy_adjustment_value := COALESCE((sale_payload->>'nhis_policy_adjustment_amount')::NUMERIC, 0);
    nhis_top_up_policy_value := LOWER(NULLIF(sale_payload->>'nhis_top_up_policy', ''));
    patient_payment_method_value := LOWER(NULLIF(sale_payload->>'patient_payment_method', ''));

    IF insurance_covered_value < 0 OR insurance_top_up_value < 0
       OR nhis_covered_value < 0 OR nhis_top_up_value < 0
       OR private_non_nhis_value < 0 OR nhis_policy_adjustment_value < 0 THEN
        RAISE EXCEPTION 'Insurance amounts must be non-negative';
    END IF;

    IF nhis_covered_value > 0 OR nhis_top_up_value > 0 OR private_non_nhis_value > 0 OR nhis_policy_adjustment_value > 0 THEN
      IF payment_method_value <> 'insurance'
         OR ABS((nhis_covered_value + nhis_top_up_value + private_non_nhis_value + nhis_policy_adjustment_value) - net_amount) > 0.01 THEN
        RAISE EXCEPTION 'NHIS settlement buckets must add up to the sale total';
      END IF;
      IF (nhis_top_up_value + private_non_nhis_value) > 0
         AND patient_payment_method_value NOT IN ('cash', 'momo', 'card') THEN
        RAISE EXCEPTION 'A patient payment method is required for NHIS top-up or private medicines';
      END IF;
    ELSIF payment_method_value = 'insurance' THEN
        IF ABS((insurance_covered_value + insurance_top_up_value) - net_amount) > 0.01 THEN
            RAISE EXCEPTION 'Insurance cover and patient top-up must add up to the sale total';
        END IF;

        IF insurance_top_up_value > 0
          AND insurance_top_up_method_value NOT IN ('cash', 'momo', 'card') THEN
            RAISE EXCEPTION 'Insurance top-up payment method is required';
        END IF;
    ELSE
        insurance_covered_value := 0;
        insurance_top_up_value := 0;
        insurance_top_up_method_value := NULL;
    END IF;

    amount_paid_value := COALESCE((sale_payload->>'amount_paid')::NUMERIC, net_amount);
    change_given_value := COALESCE((sale_payload->>'change_given')::NUMERIC, 0);

    IF amount_paid_value < 0 OR change_given_value < 0 THEN
        RAISE EXCEPTION 'Amount paid and change must be non-negative';
    END IF;

    IF payment_method_value = 'cash' AND amount_paid_value < net_amount THEN
        RAISE EXCEPTION 'Amount paid cannot be less than the sale total for cash payments';
    END IF;

    IF payment_method_value <> 'cash' THEN
        amount_paid_value := net_amount;
        change_given_value := 0;
    END IF;

    INSERT INTO public.sales (
        organization_id, branch_id, sale_number, patient_id, total_amount, discount, net_amount,
        payment_method, payment_status, amount_paid, change_given, notes,
        sold_by, sale_date, shift_id,
        insurance_covered_amount, insurance_top_up_amount, insurance_top_up_payment_method,
        nhis_covered_amount, nhis_top_up_amount, private_non_nhis_amount,
        nhis_policy_adjustment_amount, nhis_top_up_policy, patient_payment_method
    )
    VALUES (
        shift_record.organization_id, shift_record.branch_id, public.generate_sale_number(),
        patient_id_value, total_amount, discount_amount, net_amount,
        payment_method_value, payment_status_value, amount_paid_value, change_given_value,
        NULLIF(sale_payload->>'notes', ''), sold_by_value,
        COALESCE((sale_payload->>'sale_date')::TIMESTAMPTZ, NOW()), shift_id_value,
        insurance_covered_value, insurance_top_up_value, insurance_top_up_method_value,
        nhis_covered_value, nhis_top_up_value, private_non_nhis_value,
        nhis_policy_adjustment_value, nhis_top_up_policy_value, patient_payment_method_value
    )
    RETURNING * INTO sale_record;

    FOR item IN SELECT * FROM jsonb_array_elements(sale_payload->'items') LOOP
        item_drug_id := NULLIF(item->>'drugId', '')::UUID;
        item_name := NULLIF(item->>'name', '');
        item_quantity := COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, 0);
        item_price := COALESCE(NULLIF(item->>'price', '')::NUMERIC, 0);

        SELECT COALESCE(NULLIF(item_name, ''), name), COALESCE(cost_price, 0)
        INTO item_name, item_cost
        FROM public.drugs
        WHERE id = item_drug_id
          AND organization_id = shift_record.organization_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Selected drug could not be found for this sale';
        END IF;

        INSERT INTO public.sale_items (
            organization_id, sale_id, drug_id, drug_name, quantity, unit_price,
            total_price, unit_cost_at_sale, line_cost,
            nhis_settlement, nhis_covered_amount, patient_top_up_amount, private_amount, policy_adjustment_amount
        )
        VALUES (
            shift_record.organization_id, sale_record.id, item_drug_id, item_name,
            item_quantity, item_price, (item_quantity * item_price),
            item_cost, (item_quantity * item_cost),
            NULLIF(item->>'nhis_settlement', ''),
            COALESCE((item->>'nhis_covered_amount')::numeric, 0),
            COALESCE((item->>'patient_top_up_amount')::numeric, 0),
            COALESCE((item->>'private_amount')::numeric, 0),
            COALESCE((item->>'policy_adjustment_amount')::numeric, 0)
        );
    END LOOP;

    IF payment_method_value = 'cash' AND payment_status_value = 'completed' AND net_amount > 0 THEN
      INSERT INTO public.shift_cash_movements (
        shift_id, organization_id, branch_id, movement_type, source_type, source_id,
        amount, direction, description, created_by
      )
      VALUES (
        shift_id_value, shift_record.organization_id, shift_record.branch_id,
        'sale_cash', 'sale', sale_record.id, net_amount, 'in',
        CONCAT('Cash sale ', sale_record.sale_number), sold_by_value
      );

      PERFORM public.increment_shift_expected(shift_id_value, net_amount);
    END IF;

    RETURN jsonb_build_object(
        'sale_id', sale_record.id,
        'sale_number', sale_record.sale_number,
        'branch_id', sale_record.branch_id
    );
END;
$prod$;

