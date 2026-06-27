BEGIN;

ALTER TABLE public.drugs
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_drugs_branch ON public.drugs(branch_id);
CREATE INDEX IF NOT EXISTS idx_drugs_org_branch ON public.drugs(organization_id, branch_id);

WITH main_branches AS (
  SELECT DISTINCT ON (organization_id) id, organization_id
  FROM public.branches
  WHERE is_active = true
  ORDER BY organization_id, is_main DESC, created_at ASC
)
UPDATE public.drugs d
SET branch_id = mb.id
FROM main_branches mb
WHERE d.organization_id = mb.organization_id
  AND d.branch_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'drugs_name_batch_number_key'
  ) THEN
    ALTER TABLE public.drugs DROP CONSTRAINT drugs_name_batch_number_key;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'drugs_organization_name_batch_number_key'
  ) THEN
    ALTER TABLE public.drugs DROP CONSTRAINT drugs_organization_name_batch_number_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'drugs_org_branch_name_batch_number_key'
  ) THEN
    ALTER TABLE public.drugs
      ADD CONSTRAINT drugs_org_branch_name_batch_number_key
      UNIQUE (organization_id, branch_id, name, batch_number);
  END IF;
END $$;

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS destination_branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_branch ON public.stock_movements(branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_destination_branch ON public.stock_movements(destination_branch_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'stock_movements_movement_type_check'
  ) THEN
    ALTER TABLE public.stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
  END IF;

  ALTER TABLE public.stock_movements
    ADD CONSTRAINT stock_movements_movement_type_check
    CHECK (movement_type IN ('purchase', 'sale', 'adjustment', 'expired', 'return', 'transfer_in', 'transfer_out'));
END $$;

CREATE OR REPLACE FUNCTION public.transfer_drug_to_branch(
  p_drug_id UUID,
  p_destination_branch_id UUID,
  p_quantity NUMERIC,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_actor_role TEXT;
  v_can_manage_inventory BOOLEAN;
  v_org_id UUID := public.user_organization_id();
  v_source public.drugs%ROWTYPE;
  v_destination public.drugs%ROWTYPE;
  v_source_previous NUMERIC(10, 2);
  v_source_new NUMERIC(10, 2);
  v_destination_previous NUMERIC(10, 2) := 0;
  v_destination_new NUMERIC(10, 2);
  v_note TEXT;
BEGIN
  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('error', 'You must be signed in to transfer stock.');
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN jsonb_build_object('error', 'Transfer quantity must be greater than zero.');
  END IF;

  SELECT LOWER(COALESCE(role, '')), COALESCE(can_manage_inventory, false)
  INTO v_actor_role, v_can_manage_inventory
  FROM public.users
  WHERE id = v_actor_id
    AND organization_id = v_org_id;

  IF v_actor_role NOT IN ('admin', 'pharmacist', 'technician', 'procurement', 'branch_manager')
     AND NOT COALESCE(v_can_manage_inventory, false) THEN
    RETURN jsonb_build_object('error', 'Only inventory staff can transfer stock.');
  END IF;

  SELECT * INTO v_source
  FROM public.drugs
  WHERE id = p_drug_id
    AND organization_id = v_org_id
    AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Source medicine could not be found.');
  END IF;

  IF v_source.branch_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Source medicine is not assigned to a branch yet.');
  END IF;

  IF v_source.branch_id = p_destination_branch_id THEN
    RETURN jsonb_build_object('error', 'Select a different destination branch.');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.branches
    WHERE id = p_destination_branch_id
      AND organization_id = v_org_id
      AND is_active = true
  ) THEN
    RETURN jsonb_build_object('error', 'Destination branch could not be found.');
  END IF;

  v_source_previous := COALESCE(v_source.quantity, 0);
  IF v_source_previous < p_quantity THEN
    RETURN jsonb_build_object('error', 'Insufficient stock for this transfer.');
  END IF;

  v_source_new := v_source_previous - p_quantity;
  v_note := COALESCE(NULLIF(BTRIM(p_notes), ''), 'Branch stock transfer');

  UPDATE public.drugs
  SET quantity = v_source_new,
      updated_at = NOW()
  WHERE id = v_source.id;

  SELECT * INTO v_destination
  FROM public.drugs
  WHERE organization_id = v_org_id
    AND branch_id = p_destination_branch_id
    AND name = v_source.name
    AND batch_number = v_source.batch_number
  ORDER BY updated_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    v_destination_previous := COALESCE(v_destination.quantity, 0);
    v_destination_new := v_destination_previous + p_quantity;

    UPDATE public.drugs
    SET quantity = v_destination_new,
        expiry_date = COALESCE(v_source.expiry_date, expiry_date),
        price = v_source.price,
        cost_price = v_source.cost_price,
        supplier = COALESCE(v_source.supplier, supplier),
        category = COALESCE(v_source.category, category),
        description = COALESCE(v_source.description, description),
        reorder_level = v_source.reorder_level,
        unit = v_source.unit,
        status = 'active',
        updated_at = NOW()
    WHERE id = v_destination.id
    RETURNING * INTO v_destination;
  ELSE
    v_destination_previous := 0;
    v_destination_new := p_quantity;

    INSERT INTO public.drugs (
      organization_id, branch_id, name, batch_number, expiry_date, quantity,
      unit, price, cost_price, supplier, category, description, reorder_level,
      status, created_by
    )
    VALUES (
      v_org_id, p_destination_branch_id, v_source.name, v_source.batch_number,
      v_source.expiry_date, p_quantity, v_source.unit, v_source.price,
      v_source.cost_price, v_source.supplier, v_source.category,
      v_source.description, v_source.reorder_level, 'active', v_actor_id
    )
    RETURNING * INTO v_destination;
  END IF;

  INSERT INTO public.stock_movements (
    drug_id, movement_type, quantity, previous_quantity, new_quantity,
    reference_id, notes, created_by, organization_id, branch_id,
    destination_branch_id, created_at
  )
  VALUES
    (
      v_source.id, 'transfer_out', -p_quantity, v_source_previous, v_source_new,
      v_destination.id, v_note, v_actor_id, v_org_id, v_source.branch_id,
      p_destination_branch_id, NOW()
    ),
    (
      v_destination.id, 'transfer_in', p_quantity, v_destination_previous, v_destination_new,
      v_source.id, v_note, v_actor_id, v_org_id, p_destination_branch_id,
      v_source.branch_id, NOW()
    );

  RETURN jsonb_build_object(
    'success', true,
    'source_drug_id', v_source.id,
    'destination_drug_id', v_destination.id,
    'quantity', p_quantity,
    'source_quantity', v_source_new,
    'destination_quantity', v_destination_new
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.transfer_drug_to_branch(UUID, UUID, NUMERIC, TEXT) TO authenticated;

COMMIT;
