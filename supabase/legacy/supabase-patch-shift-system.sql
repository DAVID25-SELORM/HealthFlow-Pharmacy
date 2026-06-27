-- ================================================
-- PATCH: Staff shift/register system
-- Date: 2026-04-27
-- ================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.shifts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  opened_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  closed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  opening_cash NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  expected_cash NUMERIC(12, 2) NOT NULL DEFAULT 0,
  counted_cash NUMERIC(12, 2),
  cash_variance NUMERIC(12, 2) GENERATED ALWAYS AS (counted_cash - expected_cash) STORED,
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open_per_user
  ON public.shifts(opened_by)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_shifts_org ON public.shifts(organization_id);
CREATE INDEX IF NOT EXISTS idx_shifts_branch ON public.shifts(branch_id);
CREATE INDEX IF NOT EXISTS idx_shifts_opened_at ON public.shifts(opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON public.shifts(status);

CREATE TABLE IF NOT EXISTS public.shift_cash_movements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_id UUID NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  movement_type VARCHAR(30) NOT NULL
    CHECK (movement_type IN ('opening_cash','sale_cash','refund_cash','cash_in','cash_out','adjustment')),
  source_type VARCHAR(20) CHECK (source_type IN ('shift','sale','refund','manual')),
  source_id UUID,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  direction VARCHAR(5) NOT NULL CHECK (direction IN ('in', 'out')),
  description TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shift_movements_shift ON public.shift_cash_movements(shift_id);
CREATE INDEX IF NOT EXISTS idx_shift_movements_org ON public.shift_cash_movements(organization_id);
CREATE INDEX IF NOT EXISTS idx_shift_movements_branch ON public.shift_cash_movements(branch_id);

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES public.shifts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_shift ON public.sales(shift_id);

ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_cash_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shifts_select_org ON public.shifts;
DROP POLICY IF EXISTS shifts_insert_staff ON public.shifts;
DROP POLICY IF EXISTS shifts_update_staff ON public.shifts;
DROP POLICY IF EXISTS shift_movements_select_org ON public.shift_cash_movements;
DROP POLICY IF EXISTS shift_movements_insert_staff ON public.shift_cash_movements;

CREATE POLICY shifts_select_org ON public.shifts
FOR SELECT TO authenticated
USING (organization_id = public.user_organization_id());

CREATE POLICY shifts_insert_staff ON public.shifts
FOR INSERT TO authenticated
WITH CHECK (
  organization_id = public.user_organization_id()
  AND opened_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('admin', 'pharmacist', 'assistant')
      AND is_active = true
  )
);

CREATE POLICY shifts_update_staff ON public.shifts
FOR UPDATE TO authenticated
USING (
  organization_id = public.user_organization_id()
  AND (
    opened_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  )
)
WITH CHECK (organization_id = public.user_organization_id());

CREATE POLICY shift_movements_select_org ON public.shift_cash_movements
FOR SELECT TO authenticated
USING (organization_id = public.user_organization_id());

CREATE POLICY shift_movements_insert_staff ON public.shift_cash_movements
FOR INSERT TO authenticated
WITH CHECK (
  organization_id = public.user_organization_id()
  AND EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.id = shift_id
      AND s.status = 'open'
      AND (s.opened_by = auth.uid() OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'))
  )
);

CREATE OR REPLACE FUNCTION public.increment_shift_expected(
  p_shift_id UUID,
  p_delta NUMERIC
)
RETURNS VOID AS $$
BEGIN
  UPDATE public.shifts
  SET expected_cash = COALESCE(expected_cash, 0) + COALESCE(p_delta, 0),
      updated_at = NOW()
  WHERE id = p_shift_id
    AND organization_id = public.user_organization_id()
    AND status = 'open'
    AND (
      opened_by = auth.uid()
      OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Open shift not found for this user.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.increment_shift_expected(UUID, NUMERIC) TO authenticated;

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
    shift_id_value UUID;
    shift_record RECORD;
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

    payment_status_value := LOWER(COALESCE(NULLIF(sale_payload->>'payment_status', ''), 'completed'));
    IF payment_status_value NOT IN ('pending', 'completed', 'cancelled', 'refunded') THEN
        RAISE EXCEPTION 'Invalid payment status';
    END IF;

    patient_id_value := NULLIF(sale_payload->>'patient_id', '')::UUID;
    sold_by_value := COALESCE(NULLIF(sale_payload->>'sold_by', '')::UUID, auth.uid());
    shift_id_value := NULLIF(sale_payload->>'shift_id', '')::UUID;

    IF patient_id_value IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.patients WHERE id = patient_id_value) THEN
        RAISE EXCEPTION 'Selected patient could not be found';
    END IF;

    IF sold_by_value IS NULL OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = sold_by_value) THEN
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

        IF NOT EXISTS (SELECT 1 FROM public.drugs WHERE id = item_drug_id) THEN
            RAISE EXCEPTION 'Selected drug could not be found for this sale';
        END IF;

        IF item_name IS NULL THEN
            SELECT name INTO item_name FROM public.drugs WHERE id = item_drug_id;
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
        sale_number, patient_id, total_amount, discount, net_amount,
        payment_method, payment_status, amount_paid, change_given, notes,
        sold_by, sale_date, shift_id
    )
    VALUES (
        public.generate_sale_number(), patient_id_value, total_amount, discount_amount, net_amount,
        payment_method_value, payment_status_value, amount_paid_value, change_given_value,
        NULLIF(sale_payload->>'notes', ''), sold_by_value,
        COALESCE((sale_payload->>'sale_date')::TIMESTAMPTZ, NOW()), shift_id_value
    )
    RETURNING * INTO sale_record;

    FOR item IN SELECT * FROM jsonb_array_elements(sale_payload->'items') LOOP
        item_drug_id := NULLIF(item->>'drugId', '')::UUID;
        item_name := NULLIF(item->>'name', '');
        item_quantity := COALESCE(NULLIF(item->>'quantity', '')::NUMERIC, 0);
        item_price := COALESCE(NULLIF(item->>'price', '')::NUMERIC, 0);

        IF item_name IS NULL THEN
            SELECT name INTO item_name FROM public.drugs WHERE id = item_drug_id;
        END IF;

        INSERT INTO public.sale_items (sale_id, drug_id, drug_name, quantity, unit_price, total_price)
        VALUES (sale_record.id, item_drug_id, item_name, item_quantity, item_price, (item_quantity * item_price));
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
        'sale_number', sale_record.sale_number
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.create_sale_transaction(JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.refund_sale_transaction(
  p_sale_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_actor_role TEXT;
  v_actor_can_refund BOOLEAN;
  v_actor_org UUID;
  v_sale RECORD;
  v_shift RECORD;
  v_item RECORD;
  v_prev_qty NUMERIC(10, 2);
  v_new_qty NUMERIC(10, 2);
  v_reason TEXT := NULLIF(BTRIM(COALESCE(p_reason, '')), '');
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to process a refund.';
  END IF;

  SELECT LOWER(COALESCE(role, '')), COALESCE(can_refund, false), organization_id
  INTO v_actor_role, v_actor_can_refund, v_actor_org
  FROM public.users
  WHERE id = v_actor_id;

  IF v_actor_role <> 'admin' AND NOT v_actor_can_refund THEN
    RAISE EXCEPTION 'Only admins or staff granted refund permission can process refunds.';
  END IF;

  IF p_sale_id IS NULL THEN
    RAISE EXCEPTION 'Sale ID is required.';
  END IF;

  SELECT *
  INTO v_sale
  FROM public.sales
  WHERE id = p_sale_id
    AND organization_id = v_actor_org
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found for your organization.';
  END IF;

  IF LOWER(COALESCE(v_sale.payment_status, '')) = 'refunded' THEN
    RAISE EXCEPTION 'Sale has already been refunded.';
  END IF;

  IF LOWER(COALESCE(v_sale.payment_method, '')) = 'cash' THEN
    SELECT *
    INTO v_shift
    FROM public.shifts
    WHERE opened_by = v_actor_id
      AND organization_id = v_actor_org
      AND status = 'open'
    ORDER BY opened_at DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Open a shift before processing a cash refund.';
    END IF;
  END IF;

  FOR v_item IN
    SELECT drug_id, drug_name, quantity
    FROM public.sale_items
    WHERE sale_id = v_sale.id
  LOOP
    SELECT quantity INTO v_prev_qty FROM public.drugs WHERE id = v_item.drug_id FOR UPDATE;
    IF v_prev_qty IS NULL THEN
      CONTINUE;
    END IF;

    v_new_qty := COALESCE(v_prev_qty, 0) + COALESCE(v_item.quantity, 0);
    UPDATE public.drugs SET quantity = v_new_qty, updated_at = NOW() WHERE id = v_item.drug_id;

    INSERT INTO public.stock_movements (
      drug_id, movement_type, quantity, previous_quantity, new_quantity,
      reference_id, notes, created_by, created_at
    )
    VALUES (
      v_item.drug_id, 'return', COALESCE(v_item.quantity, 0), v_prev_qty, v_new_qty,
      v_sale.id,
      CONCAT('Sale refund ', COALESCE(v_sale.sale_number, ''), CASE WHEN v_reason IS NULL THEN '' ELSE CONCAT(' - ', v_reason) END),
      v_actor_id, NOW()
    );
  END LOOP;

  UPDATE public.sales
  SET payment_status = 'refunded',
      notes = CASE
        WHEN v_reason IS NULL THEN notes
        ELSE CONCAT_WS(E'\n', NULLIF(notes, ''), CONCAT('Refund reason: ', v_reason))
      END
  WHERE id = v_sale.id;

  IF LOWER(COALESCE(v_sale.payment_method, '')) = 'cash' AND COALESCE(v_sale.net_amount, 0) > 0 THEN
    INSERT INTO public.shift_cash_movements (
      shift_id, organization_id, branch_id, movement_type, source_type, source_id,
      amount, direction, description, created_by
    )
    VALUES (
      v_shift.id, v_shift.organization_id, v_shift.branch_id,
      'refund_cash', 'refund', v_sale.id, v_sale.net_amount, 'out',
      CONCAT('Cash refund ', COALESCE(v_sale.sale_number, '')), v_actor_id
    );

    PERFORM public.increment_shift_expected(v_shift.id, -v_sale.net_amount);
  END IF;

  RETURN jsonb_build_object(
    'sale_id', v_sale.id,
    'sale_number', v_sale.sale_number,
    'payment_status', 'refunded'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.refund_sale_transaction(UUID, TEXT) TO authenticated;

COMMIT;
