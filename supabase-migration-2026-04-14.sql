-- ================================================
-- HEALTHFLOW PHARMACY - MIGRATION (2026-04-14)
-- Adds security hardening + atomic transaction RPCs
-- Run this ONLY on existing projects that already have base tables.
-- ================================================

CREATE OR REPLACE FUNCTION app_role()
RETURNS TEXT AS $$
DECLARE
    role_value TEXT;
BEGIN
    role_value := COALESCE(
      (auth.jwt() -> 'app_metadata' ->> 'role'),
      (auth.jwt() -> 'user_metadata' ->> 'role'),
      'assistant'
    );

    IF role_value NOT IN ('admin', 'pharmacist', 'assistant') THEN
      RETURN 'assistant';
    END IF;

    RETURN role_value;
END;
$$ LANGUAGE plpgsql STABLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'audit_logs'
  ) THEN
    CREATE TABLE audit_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      actor_user_id UUID REFERENCES users(id),
      actor_email VARCHAR(255),
      event_type VARCHAR(50) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id UUID,
      action VARCHAR(50) NOT NULL,
      details JSONB DEFAULT '{}'::JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_audit_logs_created_at') THEN
    CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_audit_logs_entity') THEN
    CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drugs_quantity_non_negative') THEN
    ALTER TABLE drugs ADD CONSTRAINT drugs_quantity_non_negative CHECK (quantity >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drugs_price_non_negative') THEN
    ALTER TABLE drugs ADD CONSTRAINT drugs_price_non_negative CHECK (price >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drugs_cost_price_non_negative') THEN
    ALTER TABLE drugs ADD CONSTRAINT drugs_cost_price_non_negative CHECK (cost_price >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drugs_reorder_level_non_negative') THEN
    ALTER TABLE drugs ADD CONSTRAINT drugs_reorder_level_non_negative CHECK (reorder_level >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_amounts_non_negative') THEN
    ALTER TABLE sales
      ADD CONSTRAINT sales_amounts_non_negative CHECK (
        total_amount >= 0 AND discount >= 0 AND net_amount >= 0 AND COALESCE(amount_paid, 0) >= 0 AND COALESCE(change_given, 0) >= 0
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_items_quantity_positive') THEN
    ALTER TABLE sale_items ADD CONSTRAINT sale_items_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_items_price_non_negative') THEN
    ALTER TABLE sale_items ADD CONSTRAINT sale_items_price_non_negative CHECK (unit_price >= 0 AND total_price >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_total_amount_non_negative') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_total_amount_non_negative CHECK (total_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_approval_amount_non_negative') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_approval_amount_non_negative CHECK (COALESCE(approval_amount, 0) >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_items_quantity_positive') THEN
    ALTER TABLE claim_items ADD CONSTRAINT claim_items_quantity_positive CHECK (quantity > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_items_price_non_negative') THEN
    ALTER TABLE claim_items ADD CONSTRAINT claim_items_price_non_negative CHECK (unit_price >= 0 AND total_price >= 0);
  END IF;
END;
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE drugs ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_select_authenticated') THEN
    CREATE POLICY users_select_authenticated ON users FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_update_admin_or_self') THEN
    CREATE POLICY users_update_admin_or_self ON users FOR UPDATE TO authenticated
      USING (app_role() = 'admin' OR auth.email() = email)
      WITH CHECK (app_role() = 'admin' OR auth.email() = email);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_insert_self') THEN
    CREATE POLICY users_insert_self ON users FOR INSERT TO authenticated
      WITH CHECK (auth.email() = email);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drugs' AND policyname = 'drugs_select_authenticated') THEN
    CREATE POLICY drugs_select_authenticated ON drugs FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drugs' AND policyname = 'drugs_write_pharmacist_admin') THEN
    CREATE POLICY drugs_write_pharmacist_admin ON drugs FOR ALL TO authenticated
      USING (app_role() IN ('admin', 'pharmacist'))
      WITH CHECK (app_role() IN ('admin', 'pharmacist'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'patients' AND policyname = 'patients_select_authenticated') THEN
    CREATE POLICY patients_select_authenticated ON patients FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'patients' AND policyname = 'patients_write_staff') THEN
    CREATE POLICY patients_write_staff ON patients FOR ALL TO authenticated
      USING (app_role() IN ('admin', 'pharmacist', 'assistant'))
      WITH CHECK (app_role() IN ('admin', 'pharmacist', 'assistant'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sales' AND policyname = 'sales_select_authenticated') THEN
    CREATE POLICY sales_select_authenticated ON sales FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sales' AND policyname = 'sales_write_staff') THEN
    CREATE POLICY sales_write_staff ON sales FOR ALL TO authenticated
      USING (app_role() IN ('admin', 'pharmacist', 'assistant'))
      WITH CHECK (app_role() IN ('admin', 'pharmacist', 'assistant'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sale_items' AND policyname = 'sale_items_select_authenticated') THEN
    CREATE POLICY sale_items_select_authenticated ON sale_items FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sale_items' AND policyname = 'sale_items_write_staff') THEN
    CREATE POLICY sale_items_write_staff ON sale_items FOR ALL TO authenticated
      USING (app_role() IN ('admin', 'pharmacist', 'assistant'))
      WITH CHECK (app_role() IN ('admin', 'pharmacist', 'assistant'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'claims' AND policyname = 'claims_select_authenticated') THEN
    CREATE POLICY claims_select_authenticated ON claims FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'claims' AND policyname = 'claims_write_pharmacist_admin') THEN
    CREATE POLICY claims_write_pharmacist_admin ON claims FOR ALL TO authenticated
      USING (app_role() IN ('admin', 'pharmacist'))
      WITH CHECK (app_role() IN ('admin', 'pharmacist'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'claim_items' AND policyname = 'claim_items_select_authenticated') THEN
    CREATE POLICY claim_items_select_authenticated ON claim_items FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'claim_items' AND policyname = 'claim_items_write_pharmacist_admin') THEN
    CREATE POLICY claim_items_write_pharmacist_admin ON claim_items FOR ALL TO authenticated
      USING (app_role() IN ('admin', 'pharmacist'))
      WITH CHECK (app_role() IN ('admin', 'pharmacist'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stock_movements' AND policyname = 'stock_movements_select_pharmacist_admin') THEN
    CREATE POLICY stock_movements_select_pharmacist_admin ON stock_movements FOR SELECT TO authenticated
      USING (app_role() IN ('admin', 'pharmacist'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stock_movements' AND policyname = 'stock_movements_insert_staff') THEN
    CREATE POLICY stock_movements_insert_staff ON stock_movements FOR INSERT TO authenticated
      WITH CHECK (app_role() IN ('admin', 'pharmacist', 'assistant'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_select_pharmacist_admin') THEN
    CREATE POLICY audit_logs_select_pharmacist_admin ON audit_logs FOR SELECT TO authenticated
      USING (app_role() IN ('admin', 'pharmacist'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pharmacy_settings' AND policyname = 'settings_select_authenticated') THEN
    CREATE POLICY settings_select_authenticated ON pharmacy_settings FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pharmacy_settings' AND policyname = 'settings_write_admin') THEN
    CREATE POLICY settings_write_admin ON pharmacy_settings FOR ALL TO authenticated
      USING (app_role() = 'admin')
      WITH CHECK (app_role() = 'admin');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION create_sale_transaction(sale_payload JSONB)
RETURNS JSONB AS $$
DECLARE
    sale_record sales%ROWTYPE;
    item JSONB;
    total_amount NUMERIC(10, 2);
    discount_amount NUMERIC(10, 2);
    net_amount NUMERIC(10, 2);
BEGIN
    IF sale_payload IS NULL OR jsonb_typeof(sale_payload) <> 'object' THEN
        RAISE EXCEPTION 'Invalid sale payload';
    END IF;

    IF sale_payload->'items' IS NULL OR jsonb_array_length(sale_payload->'items') = 0 THEN
        RAISE EXCEPTION 'At least one sale item is required';
    END IF;

    SELECT COALESCE(SUM((item_row->>'price')::NUMERIC * (item_row->>'quantity')::NUMERIC), 0)
      INTO total_amount
      FROM jsonb_array_elements(sale_payload->'items') AS item_row;

    discount_amount := COALESCE((sale_payload->>'discount')::NUMERIC, 0);
    net_amount := total_amount - discount_amount;

    IF discount_amount < 0 OR net_amount < 0 THEN
      RAISE EXCEPTION 'Invalid discount amount';
    END IF;

    INSERT INTO sales (
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
        generate_sale_number(),
        NULLIF(sale_payload->>'patient_id', '')::UUID,
        total_amount,
        discount_amount,
        net_amount,
        sale_payload->>'payment_method',
        COALESCE(sale_payload->>'payment_status', 'completed'),
        COALESCE((sale_payload->>'amount_paid')::NUMERIC, net_amount),
        COALESCE((sale_payload->>'change_given')::NUMERIC, 0),
        NULLIF(sale_payload->>'notes', ''),
        NULLIF(sale_payload->>'sold_by', '')::UUID,
        COALESCE((sale_payload->>'sale_date')::TIMESTAMPTZ, NOW())
    )
    RETURNING * INTO sale_record;

    FOR item IN SELECT * FROM jsonb_array_elements(sale_payload->'items') LOOP
        INSERT INTO sale_items (
            sale_id,
            drug_id,
            drug_name,
            quantity,
            unit_price,
            total_price
        )
        VALUES (
            sale_record.id,
            (item->>'drugId')::UUID,
            item->>'name',
            (item->>'quantity')::NUMERIC,
            (item->>'price')::NUMERIC,
            ((item->>'quantity')::NUMERIC * (item->>'price')::NUMERIC)
        );
    END LOOP;

    RETURN jsonb_build_object(
        'sale_id', sale_record.id,
        'sale_number', sale_record.sale_number
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION create_claim_transaction(claim_payload JSONB)
RETURNS JSONB AS $$
DECLARE
    claim_record claims%ROWTYPE;
    item JSONB;
    total_amount NUMERIC(10, 2);
BEGIN
    IF claim_payload IS NULL OR jsonb_typeof(claim_payload) <> 'object' THEN
        RAISE EXCEPTION 'Invalid claim payload';
    END IF;

    IF claim_payload->'items' IS NULL OR jsonb_array_length(claim_payload->'items') = 0 THEN
        RAISE EXCEPTION 'At least one claim item is required';
    END IF;

    SELECT COALESCE(SUM((item_row->>'price')::NUMERIC * (item_row->>'quantity')::NUMERIC), 0)
      INTO total_amount
      FROM jsonb_array_elements(claim_payload->'items') AS item_row;

    INSERT INTO claims (
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
        generate_claim_number(),
        NULLIF(claim_payload->>'patient_id', '')::UUID,
        claim_payload->>'patient_name',
        claim_payload->>'insurance_provider',
        claim_payload->>'insurance_id',
        COALESCE((claim_payload->>'service_date')::DATE, CURRENT_DATE),
        total_amount,
        COALESCE(claim_payload->>'claim_status', 'pending'),
        NULLIF(claim_payload->>'prescription_url', ''),
        NULLIF(claim_payload->>'notes', ''),
        NULLIF(claim_payload->>'submitted_by', '')::UUID,
        COALESCE((claim_payload->>'submitted_at')::TIMESTAMPTZ, NOW())
    )
    RETURNING * INTO claim_record;

    FOR item IN SELECT * FROM jsonb_array_elements(claim_payload->'items') LOOP
        INSERT INTO claim_items (
            claim_id,
            drug_id,
            drug_name,
            quantity,
            unit_price,
            total_price
        )
        VALUES (
            claim_record.id,
            (item->>'drugId')::UUID,
            item->>'name',
            (item->>'quantity')::NUMERIC,
            (item->>'price')::NUMERIC,
            ((item->>'quantity')::NUMERIC * (item->>'price')::NUMERIC)
        );
    END LOOP;

    RETURN jsonb_build_object(
        'claim_id', claim_record.id,
        'claim_number', claim_record.claim_number
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION log_audit_event(
  p_event_type TEXT,
  p_entity_type TEXT,
  p_entity_id UUID,
  p_action TEXT,
  p_details JSONB DEFAULT '{}'::JSONB
)
RETURNS VOID AS $$
DECLARE
  actor_id UUID;
  actor_mail TEXT;
BEGIN
  actor_id := auth.uid();
  actor_mail := auth.email();

  INSERT INTO audit_logs (
    actor_user_id,
    actor_email,
    event_type,
    entity_type,
    entity_id,
    action,
    details,
    created_at
  )
  VALUES (
    actor_id,
    actor_mail,
    p_event_type,
    p_entity_type,
    p_entity_id,
    p_action,
    COALESCE(p_details, '{}'::JSONB),
    NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION create_sale_transaction(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION create_claim_transaction(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION log_audit_event(TEXT, TEXT, UUID, TEXT, JSONB) TO authenticated;
