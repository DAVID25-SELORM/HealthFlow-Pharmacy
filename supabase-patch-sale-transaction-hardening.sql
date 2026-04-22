-- ================================================
-- PATCH: Harden sale transactions and stock updates
-- ================================================
-- Date: April 22, 2026
-- Purpose:
-- 1. Return clearer validation errors for sale payloads.
-- 2. Prevent negative stock updates with row locking.
-- 3. Record richer stock movement details for completed sales.
-- ================================================

CREATE OR REPLACE FUNCTION public.update_drug_quantity_after_sale()
RETURNS TRIGGER AS $$
DECLARE
    previous_quantity_value NUMERIC(10, 2);
    new_quantity_value NUMERIC(10, 2);
    sale_sold_by UUID;
BEGIN
    SELECT quantity
    INTO previous_quantity_value
    FROM public.drugs
    WHERE id = NEW.drug_id
    FOR UPDATE;

    IF previous_quantity_value IS NULL THEN
        RAISE EXCEPTION 'Selected drug could not be found for this sale item';
    END IF;

    IF NEW.quantity <= 0 THEN
        RAISE EXCEPTION 'Sale item quantity must be greater than zero';
    END IF;

    IF previous_quantity_value < NEW.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for %: only % left in inventory', NEW.drug_name, previous_quantity_value;
    END IF;

    new_quantity_value := previous_quantity_value - NEW.quantity;

    UPDATE public.drugs
    SET quantity = new_quantity_value,
        updated_at = NOW()
    WHERE id = NEW.drug_id;

    SELECT sold_by
    INTO sale_sold_by
    FROM public.sales
    WHERE id = NEW.sale_id;

    INSERT INTO public.stock_movements (
        drug_id,
        movement_type,
        quantity,
        previous_quantity,
        new_quantity,
        reference_id,
        notes,
        created_by,
        created_at
    )
    VALUES (
        NEW.drug_id,
        'sale',
        -NEW.quantity,
        previous_quantity_value,
        new_quantity_value,
        NEW.sale_id,
        CONCAT('Sale item ', COALESCE(NEW.drug_name, '')),
        sale_sold_by,
        NOW()
    );

    RETURN NEW;
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

GRANT EXECUTE ON FUNCTION public.create_sale_transaction(JSONB) TO authenticated;

DO $$
BEGIN
    RAISE NOTICE 'Sale transaction hardening patch applied successfully.';
END $$;
