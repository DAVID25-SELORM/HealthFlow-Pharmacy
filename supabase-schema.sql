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

-- ================================================
-- ROW LEVEL SECURITY (RLS) - Optional but recommended
-- ================================================
-- Enable RLS on sensitive tables
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE drugs ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE sales ENABLE ROW LEVEL SECURITY;

-- Create policies as needed based on your auth setup

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
