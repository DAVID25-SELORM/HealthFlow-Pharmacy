-- Hardens accounting calculations for branch-stable P&L, historical COGS,
-- NHIS receivables, and cash refund cashbook syncing.
-- Run in Supabase SQL Editor before deploying the updated app/functions.

BEGIN;

-- ---------------------------------------------------------------------------
-- Sales accounting facts
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS insurance_covered_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insurance_top_up_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insurance_top_up_payment_method TEXT;

CREATE INDEX IF NOT EXISTS idx_sales_branch ON public.sales(branch_id);

UPDATE public.sales s
SET branch_id = COALESCE(
  (SELECT sh.branch_id FROM public.shifts sh WHERE sh.id = s.shift_id),
  (SELECT u.branch_id FROM public.users u WHERE u.id = s.sold_by)
)
WHERE s.branch_id IS NULL;

ALTER TABLE public.sales
  DROP CONSTRAINT IF EXISTS sales_insurance_amounts_non_negative,
  DROP CONSTRAINT IF EXISTS sales_insurance_top_up_payment_method_check;

ALTER TABLE public.sales
  ADD CONSTRAINT sales_insurance_amounts_non_negative
    CHECK (insurance_covered_amount >= 0 AND insurance_top_up_amount >= 0),
  ADD CONSTRAINT sales_insurance_top_up_payment_method_check
    CHECK (
      insurance_top_up_payment_method IS NULL
      OR insurance_top_up_payment_method IN ('cash', 'momo', 'card')
    );

ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS unit_cost_at_sale NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS line_cost NUMERIC(12,2) NOT NULL DEFAULT 0;

UPDATE public.sale_items si
SET
  unit_cost_at_sale = COALESCE(d.cost_price, 0),
  line_cost = COALESCE(si.quantity, 0) * COALESCE(d.cost_price, 0)
FROM public.drugs d
WHERE si.drug_id = d.id
  AND (si.unit_cost_at_sale = 0 OR si.line_cost = 0);

ALTER TABLE public.sale_items
  DROP CONSTRAINT IF EXISTS sale_items_cost_non_negative;

ALTER TABLE public.sale_items
  ADD CONSTRAINT sale_items_cost_non_negative
    CHECK (unit_cost_at_sale >= 0 AND line_cost >= 0);

-- ---------------------------------------------------------------------------
-- Claims branch history and NHIS payment ledger
-- ---------------------------------------------------------------------------

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_claims_branch ON public.claims(branch_id);

UPDATE public.claims c
SET branch_id = u.branch_id
FROM public.users u
WHERE c.branch_id IS NULL
  AND c.submitted_by = u.id;

UPDATE public.nhis_claims c
SET branch_id = u.branch_id
FROM public.users u
WHERE c.branch_id IS NULL
  AND c.created_by = u.id;

CREATE TABLE IF NOT EXISTS public.nhis_claim_payments (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id    UUID         NOT NULL DEFAULT public.user_organization_id()
                              REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id          UUID         REFERENCES public.branches(id) ON DELETE SET NULL,
  nhis_claim_id      UUID         NOT NULL REFERENCES public.nhis_claims(id) ON DELETE CASCADE,
  insurer_name       TEXT         NOT NULL DEFAULT 'NHIS',
  approved_amount    NUMERIC(12,2) NOT NULL CHECK (approved_amount >= 0),
  paid_amount        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  payment_date       DATE,
  payment_method     TEXT         DEFAULT 'bank_transfer'
                              CHECK (payment_method IN ('cash','momo','bank_transfer','cheque','other')),
  payment_reference  TEXT,
  notes              TEXT,
  created_by         UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nhis_claim_payments_org
  ON public.nhis_claim_payments(organization_id);
CREATE INDEX IF NOT EXISTS idx_nhis_claim_payments_claim
  ON public.nhis_claim_payments(nhis_claim_id);
CREATE INDEX IF NOT EXISTS idx_nhis_claim_payments_branch
  ON public.nhis_claim_payments(branch_id);
CREATE INDEX IF NOT EXISTS idx_nhis_claim_payments_date
  ON public.nhis_claim_payments(payment_date);

ALTER TABLE public.nhis_claim_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nhis_claim_payments_select_org ON public.nhis_claim_payments;
DROP POLICY IF EXISTS nhis_claim_payments_insert_staff ON public.nhis_claim_payments;
DROP POLICY IF EXISTS nhis_claim_payments_update_staff ON public.nhis_claim_payments;

CREATE POLICY nhis_claim_payments_select_org ON public.nhis_claim_payments
FOR SELECT TO authenticated
USING (organization_id = public.user_organization_id());

CREATE POLICY nhis_claim_payments_insert_staff ON public.nhis_claim_payments
FOR INSERT TO authenticated
WITH CHECK (
  organization_id = public.user_organization_id()
  AND EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('admin','pharmacist','billing')
  )
);

CREATE POLICY nhis_claim_payments_update_staff ON public.nhis_claim_payments
FOR UPDATE TO authenticated
USING (
  organization_id = public.user_organization_id()
  AND EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('admin','pharmacist','billing')
  )
)
WITH CHECK (organization_id = public.user_organization_id());

-- ---------------------------------------------------------------------------
-- Cashbook refund movements
-- ---------------------------------------------------------------------------

ALTER TABLE public.cashbook_entries
  DROP CONSTRAINT IF EXISTS cashbook_entries_entry_type_check,
  DROP CONSTRAINT IF EXISTS cashbook_entries_source_type_check;

ALTER TABLE public.cashbook_entries
  ADD CONSTRAINT cashbook_entries_entry_type_check
    CHECK (entry_type IN ('sale_cash','refund_cash','expense_cash','deposit','withdrawal','adjustment')),
  ADD CONSTRAINT cashbook_entries_source_type_check
    CHECK (source_type IN ('sale','refund','expense','claim_payment','nhis_claim_payment','manual'));

-- ---------------------------------------------------------------------------
-- Transaction functions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_sale_transaction(sale_payload JSONB)
RETURNS JSONB AS $$
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

    IF insurance_covered_value < 0 OR insurance_top_up_value < 0 THEN
        RAISE EXCEPTION 'Insurance amounts must be non-negative';
    END IF;

    IF payment_method_value = 'insurance' THEN
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
        insurance_covered_amount, insurance_top_up_amount, insurance_top_up_payment_method
    )
    VALUES (
        shift_record.organization_id, shift_record.branch_id, public.generate_sale_number(),
        patient_id_value, total_amount, discount_amount, net_amount,
        payment_method_value, payment_status_value, amount_paid_value, change_given_value,
        NULLIF(sale_payload->>'notes', ''), sold_by_value,
        COALESCE((sale_payload->>'sale_date')::TIMESTAMPTZ, NOW()), shift_id_value,
        insurance_covered_value, insurance_top_up_value, insurance_top_up_method_value
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
            total_price, unit_cost_at_sale, line_cost
        )
        VALUES (
            shift_record.organization_id, sale_record.id, item_drug_id, item_name,
            item_quantity, item_price, (item_quantity * item_price),
            item_cost, (item_quantity * item_cost)
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
  v_prev_qty NUMERIC(12, 2);
  v_new_qty NUMERIC(12, 2);
  v_cash_refund_amount NUMERIC(12, 2) := 0;
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
    v_cash_refund_amount := COALESCE(v_sale.net_amount, 0);
  ELSIF LOWER(COALESCE(v_sale.payment_method, '')) = 'insurance'
    AND LOWER(COALESCE(v_sale.insurance_top_up_payment_method, '')) = 'cash' THEN
    v_cash_refund_amount := COALESCE(v_sale.insurance_top_up_amount, 0);
  END IF;

  IF v_cash_refund_amount > 0 THEN
    SELECT *
    INTO v_shift
    FROM public.shifts
    WHERE opened_by = v_actor_id
      AND organization_id = v_actor_org
      AND status = 'open'
      AND (v_sale.branch_id IS NULL OR branch_id = v_sale.branch_id)
    ORDER BY opened_at DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Open a shift for this branch before processing a cash refund.';
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

  IF v_cash_refund_amount > 0 THEN
    INSERT INTO public.shift_cash_movements (
      shift_id, organization_id, branch_id, movement_type, source_type, source_id,
      amount, direction, description, created_by
    )
    VALUES (
      v_shift.id, v_shift.organization_id, v_shift.branch_id,
      'refund_cash', 'refund', v_sale.id, v_cash_refund_amount, 'out',
      CONCAT('Cash refund ', COALESCE(v_sale.sale_number, '')), v_actor_id
    );

    PERFORM public.increment_shift_expected(v_shift.id, -v_cash_refund_amount);
  END IF;

  RETURN jsonb_build_object(
    'sale_id', v_sale.id,
    'sale_number', v_sale.sale_number,
    'payment_status', 'refunded',
    'payment_method', v_sale.payment_method,
    'branch_id', v_sale.branch_id,
    'refund_cash_amount', v_cash_refund_amount,
    'refunded_by', v_actor_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.refund_sale_transaction(UUID, TEXT) TO authenticated;

COMMIT;
