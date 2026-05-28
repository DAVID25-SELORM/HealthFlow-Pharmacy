BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION public.user_organization_id()
RETURNS UUID
LANGUAGE sql
STABLE SECURITY DEFINER
AS $$
  SELECT organization_id FROM public.users WHERE id = auth.uid()
$$;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS epharmacy_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS epharmacy_certificate_number TEXT,
  ADD COLUMN IF NOT EXISTS epharmacy_license_status TEXT NOT NULL DEFAULT 'not_registered',
  ADD COLUMN IF NOT EXISTS pharmacist_in_charge_name TEXT,
  ADD COLUMN IF NOT EXISTS pharmacist_in_charge_reg_no TEXT,
  ADD COLUMN IF NOT EXISTS epharmacy_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS epharmacy_contact_email TEXT,
  ADD COLUMN IF NOT EXISTS epharmacy_pickup_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS epharmacy_delivery_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS epharmacy_delivery_zones JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS epharmacy_minimum_order_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS epharmacy_terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS epharmacy_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_epharmacy_license_status_check'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_epharmacy_license_status_check
      CHECK (epharmacy_license_status IN ('not_registered', 'pending_review', 'registered', 'suspended'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_epharmacy_minimum_order_non_negative'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_epharmacy_minimum_order_non_negative
      CHECK (epharmacy_minimum_order_amount >= 0);
  END IF;
END $$;

ALTER TABLE public.drugs
  ADD COLUMN IF NOT EXISTS epharmacy_visible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS epharmacy_interfacility_visible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS epharmacy_customer_visible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS epharmacy_requires_prescription BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS epharmacy_sale_class TEXT NOT NULL DEFAULT 'otc',
  ADD COLUMN IF NOT EXISTS epharmacy_pickup_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS epharmacy_delivery_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS epharmacy_warning TEXT,
  ADD COLUMN IF NOT EXISTS epharmacy_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'drugs_epharmacy_sale_class_check'
  ) THEN
    ALTER TABLE public.drugs
      ADD CONSTRAINT drugs_epharmacy_sale_class_check
      CHECK (epharmacy_sale_class IN ('otc', 'prescription', 'restricted', 'controlled', 'narcotic'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_organizations_epharmacy_enabled
  ON public.organizations(epharmacy_enabled, status);

CREATE INDEX IF NOT EXISTS idx_drugs_epharmacy_marketplace
  ON public.drugs(organization_id, epharmacy_interfacility_visible, status, expiry_date, quantity);

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

CREATE TABLE IF NOT EXISTS public.epharmacy_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number TEXT UNIQUE NOT NULL,
  channel TEXT NOT NULL DEFAULT 'interfacility',
  buyer_organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  buyer_branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  seller_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  delivery_address TEXT,
  prescription_file_path TEXT,
  prescription_file_name TEXT,
  prescription_file_url TEXT,
  prescription_required BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending_review',
  fulfillment_method TEXT NOT NULL DEFAULT 'pickup',
  payment_method TEXT NOT NULL DEFAULT 'none',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  total_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  pharmacist_note TEXT,
  rejection_reason TEXT,
  requested_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  packed_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT epharmacy_orders_channel_check CHECK (channel IN ('interfacility', 'customer')),
  CONSTRAINT epharmacy_orders_status_check CHECK (
    status IN ('pending_review', 'approved', 'rejected', 'paid', 'packed', 'out_for_delivery', 'delivered', 'cancelled')
  ),
  CONSTRAINT epharmacy_orders_fulfillment_method_check CHECK (fulfillment_method IN ('pickup', 'delivery')),
  CONSTRAINT epharmacy_orders_payment_method_check CHECK (
    payment_method IN ('none', 'paystack', 'momo', 'card', 'cash_on_delivery', 'account_transfer', 'credit')
  ),
  CONSTRAINT epharmacy_orders_payment_status_check CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
  CONSTRAINT epharmacy_orders_total_non_negative CHECK (total_amount >= 0)
);

CREATE TABLE IF NOT EXISTS public.epharmacy_order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.epharmacy_orders(id) ON DELETE CASCADE,
  drug_id UUID REFERENCES public.drugs(id) ON DELETE SET NULL,
  seller_organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  buyer_organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  drug_name TEXT NOT NULL,
  brand_name TEXT,
  generic_name TEXT,
  batch_number TEXT,
  expiry_date DATE,
  quantity NUMERIC(10, 2) NOT NULL,
  unit TEXT NOT NULL DEFAULT 'unit',
  unit_price NUMERIC(10, 2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  sale_class TEXT NOT NULL DEFAULT 'otc',
  prescription_required BOOLEAN NOT NULL DEFAULT false,
  substitution_drug_id UUID REFERENCES public.drugs(id) ON DELETE SET NULL,
  substitution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT epharmacy_order_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT epharmacy_order_items_amount_non_negative CHECK (unit_price >= 0 AND total_amount >= 0),
  CONSTRAINT epharmacy_order_items_sale_class_check CHECK (sale_class IN ('otc', 'prescription', 'restricted', 'controlled', 'narcotic'))
);

CREATE INDEX IF NOT EXISTS idx_epharmacy_orders_buyer
  ON public.epharmacy_orders(buyer_organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_epharmacy_orders_seller
  ON public.epharmacy_orders(seller_organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_epharmacy_orders_status
  ON public.epharmacy_orders(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_epharmacy_order_items_order
  ON public.epharmacy_order_items(order_id);

CREATE OR REPLACE FUNCTION public.complete_epharmacy_order(
  p_order_id UUID,
  p_actor_user_id UUID,
  p_actor_organization_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.epharmacy_orders%ROWTYPE;
  v_item public.epharmacy_order_items%ROWTYPE;
  v_seller_drug public.drugs%ROWTYPE;
  v_buyer_drug public.drugs%ROWTYPE;
  v_seller_previous NUMERIC(10, 2);
  v_seller_new NUMERIC(10, 2);
  v_buyer_previous NUMERIC(10, 2);
  v_buyer_new NUMERIC(10, 2);
  v_completed_count INTEGER := 0;
BEGIN
  IF p_actor_user_id IS NULL OR p_actor_organization_id IS NULL THEN
    RETURN jsonb_build_object('error', 'A signed-in facility user is required.');
  END IF;

  SELECT *
  INTO v_order
  FROM public.epharmacy_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'E-pharmacy order not found.');
  END IF;

  IF v_order.seller_organization_id <> p_actor_organization_id THEN
    RETURN jsonb_build_object('error', 'Only the seller facility can complete this order.');
  END IF;

  IF v_order.status NOT IN ('packed', 'out_for_delivery') THEN
    RETURN jsonb_build_object('error', 'Only packed or dispatched orders can be marked delivered.');
  END IF;

  IF v_order.channel <> 'interfacility' OR v_order.buyer_organization_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Only inter-facility orders can update facility stock automatically.');
  END IF;

  FOR v_item IN
    SELECT *
    FROM public.epharmacy_order_items
    WHERE order_id = v_order.id
    ORDER BY created_at ASC
  LOOP
    SELECT *
    INTO v_seller_drug
    FROM public.drugs
    WHERE id = v_item.drug_id
      AND organization_id = v_order.seller_organization_id
      AND status = 'active'
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', format('Seller stock no longer exists for %s.', v_item.drug_name));
    END IF;

    v_seller_previous := COALESCE(v_seller_drug.quantity, 0);
    IF v_seller_previous < v_item.quantity THEN
      RETURN jsonb_build_object('error', format('Insufficient seller stock for %s.', v_item.drug_name));
    END IF;

    v_seller_new := v_seller_previous - v_item.quantity;

    UPDATE public.drugs
    SET quantity = v_seller_new,
        updated_at = NOW()
    WHERE id = v_seller_drug.id;

    SELECT *
    INTO v_buyer_drug
    FROM public.drugs
    WHERE organization_id = v_order.buyer_organization_id
      AND (
        (branch_id = v_order.buyer_branch_id)
        OR (branch_id IS NULL AND v_order.buyer_branch_id IS NULL)
      )
      AND name = v_seller_drug.name
      AND (
        (batch_number = v_seller_drug.batch_number)
        OR (batch_number IS NULL AND v_seller_drug.batch_number IS NULL)
      )
    ORDER BY updated_at DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      v_buyer_previous := COALESCE(v_buyer_drug.quantity, 0);
      v_buyer_new := v_buyer_previous + v_item.quantity;

      UPDATE public.drugs
      SET quantity = v_buyer_new,
          expiry_date = COALESCE(v_seller_drug.expiry_date, expiry_date),
          unit = COALESCE(v_seller_drug.unit, unit),
          price = COALESCE(v_seller_drug.price, price),
          cost_price = COALESCE(v_seller_drug.cost_price, cost_price),
          supplier = COALESCE(v_seller_drug.supplier, supplier),
          category = COALESCE(v_seller_drug.category, category),
          description = COALESCE(v_seller_drug.description, description),
          reorder_level = COALESCE(v_seller_drug.reorder_level, reorder_level),
          status = 'active',
          updated_at = NOW()
      WHERE id = v_buyer_drug.id
      RETURNING * INTO v_buyer_drug;
    ELSE
      v_buyer_previous := 0;
      v_buyer_new := v_item.quantity;

      INSERT INTO public.drugs (
        organization_id,
        branch_id,
        name,
        brand_name,
        generic_name,
        batch_number,
        expiry_date,
        quantity,
        unit,
        price,
        cost_price,
        supplier,
        category,
        description,
        reorder_level,
        status,
        created_by
      )
      VALUES (
        v_order.buyer_organization_id,
        v_order.buyer_branch_id,
        v_seller_drug.name,
        v_seller_drug.brand_name,
        v_seller_drug.generic_name,
        v_seller_drug.batch_number,
        v_seller_drug.expiry_date,
        v_item.quantity,
        COALESCE(v_seller_drug.unit, v_item.unit, 'unit'),
        COALESCE(v_seller_drug.price, v_item.unit_price, 0),
        COALESCE(v_seller_drug.cost_price, v_item.unit_price, 0),
        v_seller_drug.supplier,
        v_seller_drug.category,
        v_seller_drug.description,
        COALESCE(v_seller_drug.reorder_level, 10),
        'active',
        p_actor_user_id
      )
      RETURNING * INTO v_buyer_drug;
    END IF;

    INSERT INTO public.stock_movements (
      drug_id,
      movement_type,
      quantity,
      previous_quantity,
      new_quantity,
      reference_id,
      notes,
      created_by,
      organization_id,
      branch_id,
      destination_branch_id,
      created_at
    )
    VALUES
      (
        v_seller_drug.id,
        'transfer_out',
        -v_item.quantity,
        v_seller_previous,
        v_seller_new,
        v_order.id,
        CONCAT('E-pharmacy order ', v_order.order_number, ' delivered to buyer facility'),
        p_actor_user_id,
        v_order.seller_organization_id,
        v_order.seller_branch_id,
        v_order.buyer_branch_id,
        NOW()
      ),
      (
        v_buyer_drug.id,
        'transfer_in',
        v_item.quantity,
        v_buyer_previous,
        v_buyer_new,
        v_order.id,
        CONCAT('E-pharmacy order ', v_order.order_number, ' received from seller facility'),
        p_actor_user_id,
        v_order.buyer_organization_id,
        v_order.buyer_branch_id,
        v_order.seller_branch_id,
        NOW()
      );

    v_completed_count := v_completed_count + 1;
  END LOOP;

  UPDATE public.epharmacy_orders
  SET status = 'delivered',
      delivered_at = NOW(),
      updated_at = NOW()
  WHERE id = v_order.id;

  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'items_completed', v_completed_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_epharmacy_order(UUID, UUID, UUID) TO authenticated, service_role;

ALTER TABLE public.epharmacy_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.epharmacy_order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS epharmacy_orders_select_parties ON public.epharmacy_orders;
CREATE POLICY epharmacy_orders_select_parties ON public.epharmacy_orders
FOR SELECT TO authenticated
USING (
  buyer_organization_id = public.user_organization_id()
  OR seller_organization_id = public.user_organization_id()
);

DROP POLICY IF EXISTS epharmacy_orders_insert_buyer ON public.epharmacy_orders;
CREATE POLICY epharmacy_orders_insert_buyer ON public.epharmacy_orders
FOR INSERT TO authenticated
WITH CHECK (buyer_organization_id = public.user_organization_id());

DROP POLICY IF EXISTS epharmacy_orders_update_parties ON public.epharmacy_orders;
CREATE POLICY epharmacy_orders_update_parties ON public.epharmacy_orders
FOR UPDATE TO authenticated
USING (
  buyer_organization_id = public.user_organization_id()
  OR seller_organization_id = public.user_organization_id()
)
WITH CHECK (
  buyer_organization_id = public.user_organization_id()
  OR seller_organization_id = public.user_organization_id()
);

DROP POLICY IF EXISTS epharmacy_order_items_select_parties ON public.epharmacy_order_items;
CREATE POLICY epharmacy_order_items_select_parties ON public.epharmacy_order_items
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.epharmacy_orders o
    WHERE o.id = order_id
      AND (
        o.buyer_organization_id = public.user_organization_id()
        OR o.seller_organization_id = public.user_organization_id()
      )
  )
);

DROP POLICY IF EXISTS epharmacy_order_items_insert_buyer ON public.epharmacy_order_items;
CREATE POLICY epharmacy_order_items_insert_buyer ON public.epharmacy_order_items
FOR INSERT TO authenticated
WITH CHECK (buyer_organization_id = public.user_organization_id());

COMMIT;
