-- ================================================
-- PATCH: Make sale_number generation atomic
-- Date: 2026-04-24
-- Purpose:
-- 1) Replace MAX()+1 sale number generation with a sequence.
-- 2) Add retry handling in create_sale_transaction for rare sale_number collisions.
-- ================================================

BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.sales_sale_number_seq
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  CACHE 1;

DO $$
DECLARE
  max_sale_number BIGINT;
BEGIN
  SELECT COALESCE(
    MAX(
      CASE
        WHEN sale_number ~ '^SAL-[0-9]+$' THEN substring(sale_number from '^SAL-([0-9]+)$')::BIGINT
        ELSE NULL
      END
    ),
    0
  )
  INTO max_sale_number
  FROM public.sales;

  IF max_sale_number > 0 THEN
    PERFORM setval('public.sales_sale_number_seq', max_sale_number, true);
  ELSE
    PERFORM setval('public.sales_sale_number_seq', 1, false);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.generate_sale_number()
RETURNS TEXT AS $$
DECLARE
  next_id BIGINT;
BEGIN
  next_id := nextval('public.sales_sale_number_seq');
  RETURN 'SAL-' || LPAD(next_id::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.create_sale_transaction(sale_payload JSONB)
RETURNS JSONB AS $$
DECLARE
  sale_record public.sales%ROWTYPE;
  item JSONB;
  total_amount NUMERIC(10, 2) := 0;
  discount_amount NUMERIC(10, 2);
  net_amount NUMERIC(10, 2);
  amount_paid_value NUMERIC(10, 2);
  change_given_value NUMERIC(10, 2);
  payment_method_value TEXT;
  payment_status_value TEXT;
  patient_id_value UUID;
  sold_by_value UUID;
  item_drug_id UUID;
  item_name TEXT;
  item_quantity NUMERIC(10, 2);
  item_price NUMERIC(10, 2);
  insert_attempt INTEGER := 0;
  max_insert_attempts CONSTANT INTEGER := 5;
  insert_constraint TEXT;
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

  payment_status_value := LOWER(
    COALESCE(NULLIF(sale_payload->>'payment_status', ''), 'completed')
  );
  IF payment_status_value NOT IN ('pending', 'completed', 'cancelled', 'refunded') THEN
    RAISE EXCEPTION 'Invalid payment status';
  END IF;

  patient_id_value := NULLIF(sale_payload->>'patient_id', '')::UUID;
  IF patient_id_value IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.patients
    WHERE id = patient_id_value
  ) THEN
    RAISE EXCEPTION 'Selected patient could not be found';
  END IF;

  sold_by_value := COALESCE(NULLIF(sale_payload->>'sold_by', '')::UUID, auth.uid());
  IF sold_by_value IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = sold_by_value
  ) THEN
    RAISE EXCEPTION 'Sold by user could not be found';
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(sale_payload->'items') LOOP
    item_drug_id := NULLIF(item->>'drugId', '')::UUID;
    item_name := NULLIF(item->>'name', '');
    item_quantity := COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, -1);
    item_price := COALESCE(NULLIF(item->>'price', '')::NUMERIC, -1);

    IF item_drug_id IS NULL THEN
      RAISE EXCEPTION 'Each sale item must reference a drug';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.drugs
      WHERE id = item_drug_id
    ) THEN
      RAISE EXCEPTION 'Selected drug could not be found for this sale';
    END IF;

    IF item_name IS NULL THEN
      SELECT name
      INTO item_name
      FROM public.drugs
      WHERE id = item_drug_id;
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

  LOOP
    insert_attempt := insert_attempt + 1;
    BEGIN
      INSERT INTO public.sales (
        sale_number,
        patient_id,
        total_amount,
        discount,
        net_amount,
        payment_method,
        payment_status,
        amount_paid,
        change_given,
        notes,
        sold_by,
        sale_date
      )
      VALUES (
        public.generate_sale_number(),
        patient_id_value,
        total_amount,
        discount_amount,
        net_amount,
        payment_method_value,
        payment_status_value,
        amount_paid_value,
        change_given_value,
        NULLIF(sale_payload->>'notes', ''),
        sold_by_value,
        COALESCE((sale_payload->>'sale_date')::TIMESTAMPTZ, NOW())
      )
      RETURNING * INTO sale_record;

      EXIT;
    EXCEPTION
      WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS insert_constraint = CONSTRAINT_NAME;
        IF insert_constraint = 'sales_sale_number_key' AND insert_attempt < max_insert_attempts THEN
          CONTINUE;
        END IF;
        RAISE;
    END;
  END LOOP;

  FOR item IN SELECT * FROM jsonb_array_elements(sale_payload->'items') LOOP
    item_drug_id := NULLIF(item->>'drugId', '')::UUID;
    item_name := NULLIF(item->>'name', '');
    item_quantity := COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, 0);
    item_price := COALESCE(NULLIF(item->>'price', '')::NUMERIC, 0);

    IF item_name IS NULL THEN
      SELECT name
      INTO item_name
      FROM public.drugs
      WHERE id = item_drug_id;
    END IF;

    INSERT INTO public.sale_items (
      sale_id,
      drug_id,
      drug_name,
      quantity,
      unit_price,
      total_price
    )
    VALUES (
      sale_record.id,
      item_drug_id,
      item_name,
      item_quantity,
      item_price,
      (item_quantity * item_price)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'sale_id', sale_record.id,
    'sale_number', sale_record.sale_number
  );
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION public.generate_sale_number() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_sale_transaction(JSONB) TO authenticated;

COMMIT;

