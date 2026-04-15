-- ================================================
-- HEALTHFLOW PHARMACY - DATABASE SCHEMA
-- ================================================
-- Created by: David Gabion Selorm
-- Date: April 4, 2026
-- Description: Complete database schema for pharmacy management
-- ================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ================================================
-- USERS TABLE
-- ================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'pharmacist', 'assistant')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================================
-- DRUGS/INVENTORY TABLE
-- ================================================
CREATE TABLE drugs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    batch_number VARCHAR(100) NOT NULL,
    expiry_date DATE NOT NULL,
    quantity DECIMAL(10, 2) NOT NULL DEFAULT 0,
    unit VARCHAR(50) DEFAULT 'tablets',
    price DECIMAL(10, 2) NOT NULL,
    cost_price DECIMAL(10, 2),
    supplier VARCHAR(255),
    category VARCHAR(100),
    description TEXT,
    reorder_level DECIMAL(10, 2) DEFAULT 10,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'expired')),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(name, batch_number)
);

-- Index for faster searches
CREATE INDEX idx_drugs_name ON drugs(name);
CREATE INDEX idx_drugs_expiry ON drugs(expiry_date);
CREATE INDEX idx_drugs_status ON drugs(status);

-- ================================================
-- PATIENTS TABLE
-- ================================================
CREATE TABLE patients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(255),
    date_of_birth DATE,
    gender VARCHAR(10) CHECK (gender IN ('male', 'female', 'other')),
    address TEXT,
    insurance_provider VARCHAR(255),
    insurance_id VARCHAR(100),
    allergies TEXT,
    medical_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_patients_phone ON patients(phone);
CREATE INDEX idx_patients_name ON patients(full_name);

-- ================================================
-- SALES TABLE
-- ================================================
CREATE TABLE sales (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sale_number VARCHAR(50) UNIQUE NOT NULL,
    patient_id UUID REFERENCES patients(id),
    total_amount DECIMAL(10, 2) NOT NULL,
    discount DECIMAL(10, 2) DEFAULT 0,
    net_amount DECIMAL(10, 2) NOT NULL,
    payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('cash', 'momo', 'insurance', 'card')),
    payment_status VARCHAR(20) DEFAULT 'completed' CHECK (payment_status IN ('pending', 'completed', 'cancelled', 'refunded')),
    amount_paid DECIMAL(10, 2),
    change_given DECIMAL(10, 2),
    notes TEXT,
    sold_by UUID REFERENCES users(id),
    sale_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_sales_date ON sales(sale_date);
CREATE INDEX idx_sales_number ON sales(sale_number);
CREATE INDEX idx_sales_patient ON sales(patient_id);

-- ================================================
-- SALE ITEMS TABLE
-- ================================================
CREATE TABLE sale_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sale_id UUID REFERENCES sales(id) ON DELETE CASCADE,
    drug_id UUID REFERENCES drugs(id),
    drug_name VARCHAR(255) NOT NULL,
    quantity DECIMAL(10, 2) NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    total_price DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_drug ON sale_items(drug_id);

-- ================================================
-- INSURANCE CLAIMS TABLE
-- ================================================
CREATE TABLE claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_number VARCHAR(50) UNIQUE NOT NULL,
    patient_id UUID REFERENCES patients(id),
    patient_name VARCHAR(255) NOT NULL,
    insurance_provider VARCHAR(255) NOT NULL,
    insurance_id VARCHAR(100) NOT NULL,
    service_date DATE NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    claim_status VARCHAR(20) DEFAULT 'pending' CHECK (claim_status IN ('pending', 'approved', 'rejected', 'processing')),
    approval_amount DECIMAL(10, 2),
    rejection_reason TEXT,
    prescription_url TEXT,
    notes TEXT,
    submitted_by UUID REFERENCES users(id),
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_claims_status ON claims(claim_status);
CREATE INDEX idx_claims_patient ON claims(patient_id);
CREATE INDEX idx_claims_number ON claims(claim_number);

-- ================================================
-- CLAIM ITEMS TABLE
-- ================================================
CREATE TABLE claim_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id UUID REFERENCES claims(id) ON DELETE CASCADE,
    drug_id UUID REFERENCES drugs(id),
    drug_name VARCHAR(255) NOT NULL,
    quantity DECIMAL(10, 2) NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    total_price DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_claim_items_claim ON claim_items(claim_id);

-- ================================================
-- STOCK MOVEMENTS TABLE (Audit Trail)
-- ================================================
CREATE TABLE stock_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    drug_id UUID REFERENCES drugs(id),
    movement_type VARCHAR(20) NOT NULL CHECK (movement_type IN ('purchase', 'sale', 'adjustment', 'expired', 'return')),
    quantity DECIMAL(10, 2) NOT NULL,
    previous_quantity DECIMAL(10, 2),
    new_quantity DECIMAL(10, 2),
    reference_id UUID, -- Can reference sale_id or other transaction
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_stock_movements_drug ON stock_movements(drug_id);
CREATE INDEX idx_stock_movements_date ON stock_movements(created_at);

-- ================================================
-- AUDIT LOGS TABLE
-- ================================================
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

CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

-- ================================================
-- PHARMACY SETTINGS TABLE
-- ================================================
CREATE TABLE pharmacy_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pharmacy_name VARCHAR(255) NOT NULL DEFAULT 'HealthFlow Pharmacy',
    phone VARCHAR(20),
    email VARCHAR(255),
    address TEXT,
    city VARCHAR(100),
    region VARCHAR(100),
    license_number VARCHAR(100),
    tax_rate DECIMAL(5, 2) DEFAULT 0,
    currency VARCHAR(10) DEFAULT 'GHS',
    low_stock_threshold DECIMAL(10, 2) DEFAULT 10,
    expiry_alert_days INTEGER DEFAULT 30,
    receipt_footer TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default settings
INSERT INTO pharmacy_settings (pharmacy_name) VALUES ('HealthFlow Pharmacy');

-- ================================================
-- VIEWS FOR REPORTING
-- ================================================

-- View: Low Stock Drugs
CREATE VIEW low_stock_drugs AS
SELECT 
    d.id,
    d.name,
    d.batch_number,
    d.quantity,
    d.reorder_level,
    d.price,
    d.expiry_date
FROM drugs d
WHERE d.quantity <= d.reorder_level 
    AND d.status = 'active'
ORDER BY d.quantity ASC;

-- View: Expiring Soon Drugs
CREATE VIEW expiring_soon_drugs AS
SELECT 
    d.id,
    d.name,
    d.batch_number,
    d.quantity,
    d.expiry_date,
    d.expiry_date - CURRENT_DATE as days_until_expiry
FROM drugs d
WHERE d.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
    AND d.expiry_date >= CURRENT_DATE
    AND d.status = 'active'
ORDER BY d.expiry_date ASC;

-- View: Expired Drugs
CREATE VIEW expired_drugs AS
SELECT 
    d.id,
    d.name,
    d.batch_number,
    d.quantity,
    d.expiry_date,
    d.price * d.quantity as total_value
FROM drugs d
WHERE d.expiry_date < CURRENT_DATE
ORDER BY d.expiry_date DESC;

-- View: Daily Sales Summary
CREATE VIEW daily_sales_summary AS
SELECT 
    DATE(sale_date) as sale_date,
    COUNT(*) as total_sales,
    SUM(net_amount) as total_revenue,
    SUM(CASE WHEN payment_method = 'cash' THEN net_amount ELSE 0 END) as cash_sales,
    SUM(CASE WHEN payment_method = 'momo' THEN net_amount ELSE 0 END) as momo_sales,
    SUM(CASE WHEN payment_method = 'insurance' THEN net_amount ELSE 0 END) as insurance_sales
FROM sales
WHERE payment_status = 'completed'
GROUP BY DATE(sale_date)
ORDER BY DATE(sale_date) DESC;

-- ================================================
-- FUNCTIONS
-- ================================================

-- Function: Update drug quantity after sale
CREATE OR REPLACE FUNCTION update_drug_quantity_after_sale()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE drugs 
    SET quantity = quantity - NEW.quantity,
        updated_at = NOW()
    WHERE id = NEW.drug_id;
    
    -- Log stock movement
    INSERT INTO stock_movements (drug_id, movement_type, quantity, reference_id, created_at)
    VALUES (NEW.drug_id, 'sale', -NEW.quantity, NEW.sale_id, NOW());
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: After inserting sale item
CREATE TRIGGER trigger_update_drug_quantity
AFTER INSERT ON sale_items
FOR EACH ROW
EXECUTE FUNCTION update_drug_quantity_after_sale();

-- Function: Generate sale number
CREATE OR REPLACE FUNCTION generate_sale_number()
RETURNS TEXT AS $$
DECLARE
    next_id INTEGER;
    sale_num TEXT;
BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(sale_number FROM 6) AS INTEGER)), 0) + 1
    INTO next_id
    FROM sales
    WHERE sale_number LIKE 'SAL-%';
    
    sale_num := 'SAL-' || LPAD(next_id::TEXT, 6, '0');
    RETURN sale_num;
END;
$$ LANGUAGE plpgsql;

-- Function: Generate claim number
CREATE OR REPLACE FUNCTION generate_claim_number()
RETURNS TEXT AS $$
DECLARE
    next_id INTEGER;
    claim_num TEXT;
BEGIN
    SELECT COALESCE(MAX(CAST(SUBSTRING(claim_number FROM 5) AS INTEGER)), 0) + 1
    INTO next_id
    FROM claims
    WHERE claim_number LIKE 'CLM-%';
    
    claim_num := 'CLM-' || LPAD(next_id::TEXT, 6, '0');
    RETURN claim_num;
END;
$$ LANGUAGE plpgsql;

-- Function: Create sale and items atomically
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

-- Function: Create claim and items atomically
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

-- Function: Write audit log entry
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

-- ================================================
-- ROW LEVEL SECURITY (RLS) - Optional but recommended
-- ================================================
-- Baseline role helper from JWT app metadata.
-- Expected values: admin, pharmacist, assistant
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

-- Numeric integrity constraints
ALTER TABLE drugs
    ADD CONSTRAINT drugs_quantity_non_negative CHECK (quantity >= 0),
    ADD CONSTRAINT drugs_price_non_negative CHECK (price >= 0),
    ADD CONSTRAINT drugs_cost_price_non_negative CHECK (cost_price >= 0),
    ADD CONSTRAINT drugs_reorder_level_non_negative CHECK (reorder_level >= 0);

ALTER TABLE sales
    ADD CONSTRAINT sales_amounts_non_negative CHECK (
      total_amount >= 0 AND discount >= 0 AND net_amount >= 0 AND COALESCE(amount_paid, 0) >= 0 AND COALESCE(change_given, 0) >= 0
    );

ALTER TABLE sale_items
    ADD CONSTRAINT sale_items_quantity_positive CHECK (quantity > 0),
    ADD CONSTRAINT sale_items_price_non_negative CHECK (unit_price >= 0 AND total_price >= 0);

ALTER TABLE claims
    ADD CONSTRAINT claims_total_amount_non_negative CHECK (total_amount >= 0),
    ADD CONSTRAINT claims_approval_amount_non_negative CHECK (COALESCE(approval_amount, 0) >= 0);

ALTER TABLE claim_items
    ADD CONSTRAINT claim_items_quantity_positive CHECK (quantity > 0),
    ADD CONSTRAINT claim_items_price_non_negative CHECK (unit_price >= 0 AND total_price >= 0);

-- Enable RLS on all operational tables
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

-- USERS
CREATE POLICY users_select_authenticated ON users
FOR SELECT TO authenticated
USING (true);

CREATE POLICY users_update_admin_or_self ON users
FOR UPDATE TO authenticated
USING (app_role() = 'admin' OR auth.email() = email)
WITH CHECK (app_role() = 'admin' OR auth.email() = email);

CREATE POLICY users_insert_self ON users
FOR INSERT TO authenticated
WITH CHECK (auth.email() = email);

-- DRUGS
CREATE POLICY drugs_select_authenticated ON drugs
FOR SELECT TO authenticated
USING (true);

CREATE POLICY drugs_write_pharmacist_admin ON drugs
FOR ALL TO authenticated
USING (app_role() IN ('admin', 'pharmacist'))
WITH CHECK (app_role() IN ('admin', 'pharmacist'));

-- PATIENTS
CREATE POLICY patients_select_authenticated ON patients
FOR SELECT TO authenticated
USING (true);

CREATE POLICY patients_write_staff ON patients
FOR ALL TO authenticated
USING (app_role() IN ('admin', 'pharmacist', 'assistant'))
WITH CHECK (app_role() IN ('admin', 'pharmacist', 'assistant'));

-- SALES
CREATE POLICY sales_select_authenticated ON sales
FOR SELECT TO authenticated
USING (true);

CREATE POLICY sales_write_staff ON sales
FOR ALL TO authenticated
USING (app_role() IN ('admin', 'pharmacist', 'assistant'))
WITH CHECK (app_role() IN ('admin', 'pharmacist', 'assistant'));

-- SALE ITEMS
CREATE POLICY sale_items_select_authenticated ON sale_items
FOR SELECT TO authenticated
USING (true);

CREATE POLICY sale_items_write_staff ON sale_items
FOR ALL TO authenticated
USING (app_role() IN ('admin', 'pharmacist', 'assistant'))
WITH CHECK (app_role() IN ('admin', 'pharmacist', 'assistant'));

-- CLAIMS
CREATE POLICY claims_select_authenticated ON claims
FOR SELECT TO authenticated
USING (true);

CREATE POLICY claims_write_pharmacist_admin ON claims
FOR ALL TO authenticated
USING (app_role() IN ('admin', 'pharmacist'))
WITH CHECK (app_role() IN ('admin', 'pharmacist'));

-- CLAIM ITEMS
CREATE POLICY claim_items_select_authenticated ON claim_items
FOR SELECT TO authenticated
USING (true);

CREATE POLICY claim_items_write_pharmacist_admin ON claim_items
FOR ALL TO authenticated
USING (app_role() IN ('admin', 'pharmacist'))
WITH CHECK (app_role() IN ('admin', 'pharmacist'));

-- STOCK MOVEMENTS
CREATE POLICY stock_movements_select_pharmacist_admin ON stock_movements
FOR SELECT TO authenticated
USING (app_role() IN ('admin', 'pharmacist'));

CREATE POLICY stock_movements_insert_staff ON stock_movements
FOR INSERT TO authenticated
WITH CHECK (app_role() IN ('admin', 'pharmacist', 'assistant'));

-- AUDIT LOGS
CREATE POLICY audit_logs_select_pharmacist_admin ON audit_logs
FOR SELECT TO authenticated
USING (app_role() IN ('admin', 'pharmacist'));

-- PHARMACY SETTINGS
CREATE POLICY settings_select_authenticated ON pharmacy_settings
FOR SELECT TO authenticated
USING (true);

CREATE POLICY settings_write_admin ON pharmacy_settings
FOR ALL TO authenticated
USING (app_role() = 'admin')
WITH CHECK (app_role() = 'admin');

-- ================================================
-- SAMPLE DATA (Optional for testing)
-- ================================================
-- Uncomment to insert sample data

/*
-- Sample User
INSERT INTO users (email, full_name, phone, role) 
VALUES ('admin@healthflow.com', 'David Gabion Selorm', '+233247654381', 'admin');

-- Sample Drugs
INSERT INTO drugs (name, batch_number, expiry_date, quantity, price, cost_price, supplier) VALUES
('Paracetamol 500mg', 'BT001', '2026-12-31', 500, 5.00, 3.00, 'PharmaCare Ltd'),
('Ibuprofen 200mg', 'BT002', '2026-10-15', 300, 4.00, 2.50, 'MediSupply Ghana'),
('Amoxicillin 500mg', 'BT003', '2026-08-20', 150, 37.00, 25.00, 'Beta Healthcare'),
('Vitamin C 1000mg', 'BT004', '2027-03-10', 200, 15.00, 10.00, 'Wellness Distributors');

-- Sample Patient
INSERT INTO patients (full_name, phone, email, insurance_provider, insurance_id) 
VALUES ('Kwame Boateng', '+233247654321', 'kwame@email.com', 'NHIS', 'NHIS123456789');
*/

-- ================================================
-- END OF SCHEMA
-- ================================================
