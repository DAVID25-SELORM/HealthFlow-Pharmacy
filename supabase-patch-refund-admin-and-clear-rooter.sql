-- ================================================
-- PATCH: Enable admin refunds + clear Rooter inventory rows
-- Date: 2026-04-24
-- ================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.refund_sale_transaction(
  p_sale_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_actor_role TEXT;
  v_actor_org UUID;
  v_sale RECORD;
  v_item RECORD;
  v_prev_qty NUMERIC(10, 2);
  v_new_qty NUMERIC(10, 2);
  v_reason TEXT := NULLIF(BTRIM(COALESCE(p_reason, '')), '');
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to process a refund.';
  END IF;

  SELECT LOWER(COALESCE(role, '')), organization_id
  INTO v_actor_role, v_actor_org
  FROM public.users
  WHERE id = v_actor_id;

  IF v_actor_role NOT IN ('admin', 'pharmacist') THEN
    RAISE EXCEPTION 'Only pharmacy admins and pharmacists can process refunds.';
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

  FOR v_item IN
    SELECT drug_id, drug_name, quantity
    FROM public.sale_items
    WHERE sale_id = v_sale.id
  LOOP
    SELECT quantity
    INTO v_prev_qty
    FROM public.drugs
    WHERE id = v_item.drug_id
    FOR UPDATE;

    IF v_prev_qty IS NULL THEN
      CONTINUE;
    END IF;

    v_new_qty := COALESCE(v_prev_qty, 0) + COALESCE(v_item.quantity, 0);

    UPDATE public.drugs
    SET quantity = v_new_qty,
        updated_at = NOW()
    WHERE id = v_item.drug_id;

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
      v_item.drug_id,
      'return',
      COALESCE(v_item.quantity, 0),
      v_prev_qty,
      v_new_qty,
      v_sale.id,
      CONCAT(
        'Sale refund ',
        COALESCE(v_sale.sale_number, ''),
        CASE WHEN v_reason IS NULL THEN '' ELSE CONCAT(' - ', v_reason) END
      ),
      v_actor_id,
      NOW()
    );
  END LOOP;

  UPDATE public.sales
  SET payment_status = 'refunded',
      notes = CASE
        WHEN v_reason IS NULL THEN notes
        ELSE CONCAT_WS(E'\n', NULLIF(notes, ''), CONCAT('Refund reason: ', v_reason))
      END
  WHERE id = v_sale.id;

  RETURN jsonb_build_object(
    'sale_id', v_sale.id,
    'sale_number', v_sale.sale_number,
    'payment_status', 'refunded'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.refund_sale_transaction(UUID, TEXT) TO authenticated;

UPDATE public.drugs
SET status = 'inactive',
    quantity = 0,
    updated_at = NOW()
WHERE LOWER(BTRIM(name)) IN (
  'rooter mixture',
  'rooter tytonic',
  'rooter tonic'
);

COMMIT;

