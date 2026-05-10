-- Hardened branch-server sync RPCs for offline pharmacy uploads.
-- Run in Supabase SQL Editor after the accounting/branch patches.
--
-- Setup after running this patch:
--   SELECT public.create_branch_sync_client(
--     'Main branch laptop',
--     '<organization_id>'::UUID,
--     '<branch_id>'::UUID,
--     '<long random branch sync token>'
--   );
--
-- Put the same plain token in local-branch-server/.env as BRANCH_SYNC_TOKEN.
-- Only the SHA-256 hash is stored in Supabase.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.branch_sync_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_branch_sync_clients_org_branch
  ON public.branch_sync_clients(organization_id, branch_id)
  WHERE is_active = true;

REVOKE ALL ON TABLE public.branch_sync_clients FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.branch_sync_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_client_id UUID NOT NULL REFERENCES public.branch_sync_clients(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  local_id UUID NOT NULL,
  remote_id UUID,
  remote_number TEXT,
  response JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sync_client_id, event_type, local_id)
);

REVOKE ALL ON TABLE public.branch_sync_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.branch_sync_token_hash(p_token TEXT)
RETURNS TEXT AS $$
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_token, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Branch sync token is required.';
  END IF;

  RETURN encode(digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.create_branch_sync_client(
  p_name TEXT,
  p_organization_id UUID,
  p_branch_id UUID,
  p_plain_token TEXT
)
RETURNS UUID AS $$
DECLARE
  v_client_id UUID;
BEGIN
  IF NULLIF(BTRIM(COALESCE(p_name, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Client name is required.';
  END IF;

  IF p_organization_id IS NULL OR p_branch_id IS NULL THEN
    RAISE EXCEPTION 'Organization and branch are required.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.branches
    WHERE id = p_branch_id
      AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Branch does not belong to the organization.';
  END IF;

  INSERT INTO public.branch_sync_clients (
    name,
    organization_id,
    branch_id,
    token_hash
  )
  VALUES (
    BTRIM(p_name),
    p_organization_id,
    p_branch_id,
    public.branch_sync_token_hash(p_plain_token)
  )
  RETURNING id INTO v_client_id;

  RETURN v_client_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.create_branch_sync_client(TEXT, UUID, UUID, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.get_branch_sync_client(p_plain_token TEXT)
RETURNS public.branch_sync_clients AS $$
DECLARE
  v_client public.branch_sync_clients%ROWTYPE;
BEGIN
  SELECT *
  INTO v_client
  FROM public.branch_sync_clients
  WHERE token_hash = public.branch_sync_token_hash(p_plain_token)
    AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or inactive branch sync token.';
  END IF;

  UPDATE public.branch_sync_clients
  SET last_seen_at = NOW()
  WHERE id = v_client.id;

  RETURN v_client;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_branch_sync_client(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.branch_sync_create_sale_transaction(
  p_sync_token TEXT,
  p_local_sale_id UUID,
  sale_payload JSONB
)
RETURNS JSONB AS $$
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

  IF shift_id_value IS NULL THEN
    RAISE EXCEPTION 'Open a shift before completing sales.';
  END IF;

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

  IF insurance_covered_value < 0 OR insurance_top_up_value < 0 THEN
    RAISE EXCEPTION 'Insurance amounts must be non-negative.';
  END IF;

  IF payment_method_value = 'insurance' THEN
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
    insurance_covered_amount, insurance_top_up_amount, insurance_top_up_payment_method
  )
  VALUES (
    v_client.organization_id, v_client.branch_id, public.generate_sale_number(),
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
      AND organization_id = v_client.organization_id;

    INSERT INTO public.sale_items (
      organization_id, sale_id, drug_id, drug_name, quantity, unit_price,
      total_price, unit_cost_at_sale, line_cost
    )
    VALUES (
      v_client.organization_id, sale_record.id, item_drug_id, item_name,
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.branch_sync_create_claim_transaction(
  p_sync_token TEXT,
  p_local_claim_id UUID,
  claim_payload JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_client public.branch_sync_clients%ROWTYPE;
  v_existing public.branch_sync_events%ROWTYPE;
  claim_record public.claims%ROWTYPE;
  item JSONB;
  total_amount NUMERIC(12, 2);
  submitted_by_value UUID;
  patient_id_value UUID;
  response_payload JSONB;
BEGIN
  IF p_local_claim_id IS NULL THEN
    RAISE EXCEPTION 'Local claim ID is required.';
  END IF;

  v_client := public.get_branch_sync_client(p_sync_token);

  SELECT *
  INTO v_existing
  FROM public.branch_sync_events
  WHERE sync_client_id = v_client.id
    AND event_type = 'claim.submitted'
    AND local_id = p_local_claim_id;

  IF FOUND THEN
    RETURN v_existing.response;
  END IF;

  IF claim_payload IS NULL OR jsonb_typeof(claim_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid claim payload.';
  END IF;

  IF claim_payload->'items' IS NULL OR jsonb_array_length(claim_payload->'items') = 0 THEN
    RAISE EXCEPTION 'At least one claim item is required.';
  END IF;

  patient_id_value := NULLIF(claim_payload->>'patient_id', '')::UUID;
  submitted_by_value := NULLIF(claim_payload->>'submitted_by', '')::UUID;

  IF patient_id_value IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.patients
      WHERE id = patient_id_value
        AND organization_id = v_client.organization_id
    ) THEN
    RAISE EXCEPTION 'Selected patient could not be found.';
  END IF;

  IF submitted_by_value IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.users
      WHERE id = submitted_by_value
        AND organization_id = v_client.organization_id
    ) THEN
    RAISE EXCEPTION 'Submitted by user could not be found.';
  END IF;

  SELECT COALESCE(SUM((item_row->>'price')::NUMERIC * (item_row->>'quantity')::NUMERIC), 0)
  INTO total_amount
  FROM jsonb_array_elements(claim_payload->'items') AS item_row;

  INSERT INTO public.claims (
    organization_id,
    branch_id,
    claim_number,
    patient_id,
    patient_name,
    insurance_provider,
    insurance_id,
    service_date,
    total_amount,
    claim_status,
    prescription_url,
    notes,
    submitted_by,
    submitted_at
  )
  VALUES (
    v_client.organization_id,
    v_client.branch_id,
    public.generate_claim_number(),
    patient_id_value,
    claim_payload->>'patient_name',
    claim_payload->>'insurance_provider',
    claim_payload->>'insurance_id',
    COALESCE((claim_payload->>'service_date')::DATE, CURRENT_DATE),
    total_amount,
    COALESCE(NULLIF(claim_payload->>'claim_status', ''), 'pending'),
    NULLIF(claim_payload->>'prescription_url', ''),
    NULLIF(claim_payload->>'notes', ''),
    submitted_by_value,
    COALESCE((claim_payload->>'submitted_at')::TIMESTAMPTZ, NOW())
  )
  RETURNING * INTO claim_record;

  FOR item IN SELECT * FROM jsonb_array_elements(claim_payload->'items') LOOP
    INSERT INTO public.claim_items (
      organization_id,
      claim_id,
      drug_id,
      drug_name,
      quantity,
      unit_price,
      total_price
    )
    VALUES (
      v_client.organization_id,
      claim_record.id,
      (item->>'drugId')::UUID,
      item->>'name',
      (item->>'quantity')::NUMERIC,
      (item->>'price')::NUMERIC,
      ((item->>'quantity')::NUMERIC * (item->>'price')::NUMERIC)
    );
  END LOOP;

  response_payload := jsonb_build_object(
    'claim_id', claim_record.id,
    'claim_number', claim_record.claim_number,
    'branch_id', claim_record.branch_id
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
    'claim.submitted',
    p_local_claim_id,
    claim_record.id,
    claim_record.claim_number,
    response_payload
  );

  RETURN response_payload;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.branch_sync_create_sale_transaction(TEXT, UUID, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.branch_sync_create_claim_transaction(TEXT, UUID, JSONB) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.branch_sync_get_inventory_snapshot(
  p_sync_token TEXT,
  p_limit INTEGER DEFAULT 5000
)
RETURNS JSONB AS $$
DECLARE
  v_client public.branch_sync_clients%ROWTYPE;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 5000), 1), 20000);
  v_drugs JSONB;
BEGIN
  v_client := public.get_branch_sync_client(p_sync_token);

  SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.name, d.batch_number, d.id), '[]'::JSONB)
  INTO v_drugs
  FROM (
    SELECT
      id,
      name,
      batch_number,
      expiry_date,
      quantity,
      unit,
      price,
      cost_price,
      nhis_code,
      nhis_price,
      nhis_unit,
      is_nhis_listed,
      supplier,
      category,
      description,
      reorder_level,
      status,
      organization_id,
      branch_id,
      updated_at
    FROM public.drugs
    WHERE organization_id = v_client.organization_id
      AND (branch_id IS NULL OR branch_id = v_client.branch_id)
      AND COALESCE(status, 'active') <> 'inactive'
    ORDER BY name, batch_number, id
    LIMIT v_limit
  ) d;

  RETURN jsonb_build_object(
    'organization_id', v_client.organization_id,
    'branch_id', v_client.branch_id,
    'pulled_at', NOW(),
    'drugs', v_drugs
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.branch_sync_get_inventory_snapshot(TEXT, INTEGER) TO anon, authenticated;

COMMIT;
