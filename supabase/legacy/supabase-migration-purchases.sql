-- ================================================================
-- MIGRATION: Purchases & Suppliers
-- ================================================================
-- Date: 2026-05-06
-- Purpose:
--   Creates suppliers, purchases, and purchase_items tables with
--   full multi-tenant RLS. Adds a complete_purchase() Postgres
--   function that atomically updates drug stock and logs stock
--   movements when a purchase is finalized.
-- ================================================================

BEGIN;

-- ----------------------------------------------------------------
-- SUPPLIERS
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.suppliers (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID          NOT NULL DEFAULT public.user_organization_id()
                                REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            TEXT          NOT NULL,
  contact_person  TEXT,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  notes           TEXT,
  is_active       BOOLEAN       NOT NULL DEFAULT true,
  created_by      UUID          REFERENCES public.users(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE public.suppliers
  ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

CREATE INDEX IF NOT EXISTS idx_suppliers_org  ON public.suppliers(organization_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON public.suppliers(organization_id, name);

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS suppliers_select ON public.suppliers;
CREATE POLICY suppliers_select ON public.suppliers
  FOR SELECT TO authenticated
  USING (organization_id = public.user_organization_id());

DROP POLICY IF EXISTS suppliers_insert ON public.suppliers;
CREATE POLICY suppliers_insert ON public.suppliers
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'procurement', 'branch_manager')
    )
  );

DROP POLICY IF EXISTS suppliers_update ON public.suppliers;
CREATE POLICY suppliers_update ON public.suppliers
  FOR UPDATE TO authenticated
  USING  (organization_id = public.user_organization_id())
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'procurement', 'branch_manager')
    )
  );

-- ----------------------------------------------------------------
-- PURCHASES
-- ----------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.purchase_number_seq START 1;

CREATE TABLE IF NOT EXISTS public.purchases (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID          NOT NULL DEFAULT public.user_organization_id()
                                REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id       UUID          REFERENCES public.branches(id),
  purchase_number TEXT          NOT NULL DEFAULT ('PO-' || LPAD(NEXTVAL('public.purchase_number_seq')::TEXT, 6, '0')),
  supplier_id     UUID          REFERENCES public.suppliers(id),
  supplier_name   TEXT,
  invoice_number  TEXT,
  purchase_date   DATE          NOT NULL DEFAULT CURRENT_DATE,
  total_amount    DECIMAL(12,2) NOT NULL DEFAULT 0,
  status          TEXT          NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'completed', 'cancelled')),
  notes           TEXT,
  created_by      UUID          REFERENCES public.users(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE public.purchases
  ALTER COLUMN organization_id SET DEFAULT public.user_organization_id();

CREATE INDEX IF NOT EXISTS idx_purchases_org      ON public.purchases(organization_id);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON public.purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchases_date     ON public.purchases(purchase_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_status   ON public.purchases(organization_id, status);

ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS purchases_select ON public.purchases;
CREATE POLICY purchases_select ON public.purchases
  FOR SELECT TO authenticated
  USING (organization_id = public.user_organization_id());

DROP POLICY IF EXISTS purchases_insert ON public.purchases;
CREATE POLICY purchases_insert ON public.purchases
  FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'procurement', 'branch_manager')
    )
  );

DROP POLICY IF EXISTS purchases_update ON public.purchases;
CREATE POLICY purchases_update ON public.purchases
  FOR UPDATE TO authenticated
  USING  (organization_id = public.user_organization_id())
  WITH CHECK (
    organization_id = public.user_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid()
        AND role IN ('admin', 'pharmacist', 'procurement', 'branch_manager')
    )
  );

-- ----------------------------------------------------------------
-- PURCHASE ITEMS
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.purchase_items (
  id               UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  purchase_id      UUID          NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
  drug_id          UUID          REFERENCES public.drugs(id),
  drug_name        TEXT          NOT NULL,
  brand_name       TEXT,
  generic_name     TEXT,
  sale_on_return   BOOLEAN       NOT NULL DEFAULT false,
  quantity         DECIMAL(10,2) NOT NULL,
  unit             TEXT          DEFAULT 'unit',
  unit_cost        DECIMAL(10,2) NOT NULL DEFAULT 0,
  discount_percent DECIMAL(5,2)  DEFAULT 0,
  net_total        DECIMAL(12,2) NOT NULL DEFAULT 0,
  batch_number     TEXT,
  expiry_date      DATE,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE public.purchase_items
  ADD COLUMN IF NOT EXISTS brand_name TEXT,
  ADD COLUMN IF NOT EXISTS generic_name TEXT,
  ADD COLUMN IF NOT EXISTS sale_on_return BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.drugs
  ADD COLUMN IF NOT EXISTS brand_name TEXT,
  ADD COLUMN IF NOT EXISTS generic_name TEXT,
  ADD COLUMN IF NOT EXISTS sale_on_return BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON public.purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_drug     ON public.purchase_items(drug_id);

ALTER TABLE public.purchase_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS purchase_items_select ON public.purchase_items;
CREATE POLICY purchase_items_select ON public.purchase_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.purchases p
      WHERE p.id = purchase_id
        AND p.organization_id = public.user_organization_id()
    )
  );

DROP POLICY IF EXISTS purchase_items_insert ON public.purchase_items;
CREATE POLICY purchase_items_insert ON public.purchase_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.purchases p
      WHERE p.id = purchase_id
        AND p.organization_id = public.user_organization_id()
    )
  );

DROP POLICY IF EXISTS purchase_items_delete ON public.purchase_items;
CREATE POLICY purchase_items_delete ON public.purchase_items
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.purchases p
      WHERE p.id = purchase_id
        AND p.organization_id = public.user_organization_id()
        AND p.status = 'draft'
    )
  );

-- ----------------------------------------------------------------
-- COMPLETE_PURCHASE FUNCTION
-- Atomically: updates drug quantities, logs stock movements,
-- and sets purchase status = 'completed'.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_purchase(p_purchase_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_purchase      public.purchases%ROWTYPE;
  v_item          public.purchase_items%ROWTYPE;
  v_old_qty       DECIMAL(10,2);
  v_new_qty       DECIMAL(10,2);
  v_items_updated INTEGER := 0;
  v_note          TEXT;
BEGIN
  -- Lock and fetch the purchase
  SELECT * INTO v_purchase
  FROM public.purchases
  WHERE id = p_purchase_id
    AND organization_id = public.user_organization_id()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Purchase not found.');
  END IF;

  IF v_purchase.status != 'draft' THEN
    RETURN jsonb_build_object('error', 'Only draft purchases can be completed.');
  END IF;

  -- Build the note string once
  v_note := 'Purchase: ' || COALESCE(v_purchase.purchase_number, '')
    || CASE WHEN v_purchase.invoice_number IS NOT NULL
            THEN ' / Invoice: ' || v_purchase.invoice_number
            ELSE '' END;

  -- Process each purchase item
  FOR v_item IN
    SELECT * FROM public.purchase_items WHERE purchase_id = p_purchase_id
  LOOP
    IF v_item.drug_id IS NOT NULL THEN
      -- Current quantity
      SELECT COALESCE(quantity, 0) INTO v_old_qty
      FROM public.drugs
      WHERE id = v_item.drug_id;

      v_new_qty := v_old_qty + v_item.quantity;

      -- Update the drug
      UPDATE public.drugs
      SET
        quantity     = v_new_qty,
        brand_name   = COALESCE(NULLIF(TRIM(v_item.brand_name), ''), brand_name),
        generic_name = COALESCE(NULLIF(TRIM(v_item.generic_name), ''), generic_name),
        sale_on_return = COALESCE(v_item.sale_on_return, sale_on_return),
        batch_number = COALESCE(NULLIF(TRIM(v_item.batch_number), ''), batch_number),
        expiry_date  = COALESCE(v_item.expiry_date, expiry_date),
        cost_price   = CASE WHEN v_item.unit_cost > 0 THEN v_item.unit_cost ELSE cost_price END,
        updated_at   = NOW()
      WHERE id = v_item.drug_id;

      -- Log stock movement (organization_id column added via multi-tenant migration)
      INSERT INTO public.stock_movements (
        drug_id, movement_type, quantity,
        previous_quantity, new_quantity,
        reference_id, notes, created_by,
        organization_id, created_at
      ) VALUES (
        v_item.drug_id, 'purchase', v_item.quantity,
        v_old_qty, v_new_qty,
        p_purchase_id, v_note, auth.uid(),
        v_purchase.organization_id, NOW()
      );

      v_items_updated := v_items_updated + 1;
    END IF;
  END LOOP;

  -- Finalise the purchase
  UPDATE public.purchases
  SET status = 'completed', updated_at = NOW()
  WHERE id = p_purchase_id;

  RETURN jsonb_build_object(
    'success', true,
    'items_updated', v_items_updated
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_purchase(UUID) TO authenticated;

COMMIT;
