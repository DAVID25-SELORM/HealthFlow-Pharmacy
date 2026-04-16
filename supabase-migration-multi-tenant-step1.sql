-- ================================================
-- MULTI-TENANT MIGRATION - STEP 1: ORGANIZATIONS
-- ================================================
-- Date: April 16, 2026
-- Description: Add organizations table and prepare for multi-tenancy
-- Author: David Gabion Selorm
-- ================================================

-- ================================================
-- STEP 1: CREATE ORGANIZATIONS TABLE
-- ================================================

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    subdomain VARCHAR(50) UNIQUE NOT NULL,
    
    -- Contact Information
    address TEXT,
    city VARCHAR(100),
    region VARCHAR(100),
    phone VARCHAR(20),
    email VARCHAR(255),
    license_number VARCHAR(100),
    
    -- Subscription & Status
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'trial', 'suspended', 'cancelled')),
    subscription_tier VARCHAR(20) DEFAULT 'trial' CHECK (subscription_tier IN ('trial', 'free', 'basic', 'pro', 'enterprise')),
    
    -- Ownership
    owner_user_id UUID, -- Set after user is created
    
    -- Subscription Dates
    trial_ends_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '30 days'),
    subscription_ends_at TIMESTAMP WITH TIME ZONE,
    
    -- Limits (for future use)
    max_users INTEGER DEFAULT 5,
    max_monthly_sales INTEGER DEFAULT 1000,
    
    -- Metadata
    settings JSONB DEFAULT '{}',
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_organizations_subdomain ON organizations(subdomain);
CREATE INDEX idx_organizations_status ON organizations(status);
CREATE INDEX idx_organizations_owner ON organizations(owner_user_id);

-- Comments
COMMENT ON TABLE organizations IS 'Multi-tenant organizations (pharmacies) using the system';
COMMENT ON COLUMN organizations.subdomain IS 'Unique subdomain identifier (e.g., starline, medplus)';
COMMENT ON COLUMN organizations.status IS 'Organization status: active, trial, suspended, cancelled';
COMMENT ON COLUMN organizations.subscription_tier IS 'Subscription plan level';
COMMENT ON COLUMN organizations.owner_user_id IS 'Primary admin user who owns this organization';

-- ================================================
-- STEP 2: ADD ORGANIZATION_ID TO EXISTING TABLES
-- ================================================

-- Users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);

-- Drugs table
ALTER TABLE drugs
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_drugs_org ON drugs(organization_id);

-- Patients table
ALTER TABLE patients
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_patients_org ON patients(organization_id);

-- Sales table
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_sales_org ON sales(organization_id);

-- Sale items table
ALTER TABLE sale_items
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_sale_items_org ON sale_items(organization_id);

-- Claims table
ALTER TABLE claims
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_claims_org ON claims(organization_id);

-- Claim items table
ALTER TABLE claim_items
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_claim_items_org ON claim_items(organization_id);

-- Stock movements table (if exists)
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'stock_movements') THEN
        ALTER TABLE stock_movements
        ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
        
        CREATE INDEX IF NOT EXISTS idx_stock_movements_org ON stock_movements(organization_id);
    END IF;
END $$;

-- Audit logs table (if exists)
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'audit_logs') THEN
        ALTER TABLE audit_logs
        ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
        
        CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(organization_id);
    END IF;
END $$;

-- Pharmacy settings table (make it multi-tenant)
ALTER TABLE pharmacy_settings
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_pharmacy_settings_org ON pharmacy_settings(organization_id);

-- ================================================
-- STEP 3: CREATE DEFAULT ORGANIZATION (for migration)
-- ================================================
-- This is for existing deployments to migrate current data

DO $$
DECLARE
    default_org_id UUID;
BEGIN
    -- Check if we need to create a default organization
    IF NOT EXISTS (SELECT 1 FROM organizations LIMIT 1) THEN
        -- Create default organization for existing data
        INSERT INTO organizations (
            name, 
            subdomain, 
            status, 
            subscription_tier,
            trial_ends_at
        )
        VALUES (
            'HealthFlow Pharmacy',
            'healthflow',
            'active',
            'enterprise', -- Give existing deployment full access
            NOW() + INTERVAL '365 days' -- 1 year trial
        )
        RETURNING id INTO default_org_id;
        
        -- Update all existing users with this organization
        UPDATE users SET organization_id = default_org_id WHERE organization_id IS NULL;
        
        -- Update all existing drugs
        UPDATE drugs SET organization_id = default_org_id WHERE organization_id IS NULL;
        
        -- Update all existing patients
        UPDATE patients SET organization_id = default_org_id WHERE organization_id IS NULL;
        
        -- Update all existing sales
        UPDATE sales SET organization_id = default_org_id WHERE organization_id IS NULL;
        
        -- Update all existing sale_items
        UPDATE sale_items SET organization_id = default_org_id WHERE organization_id IS NULL;
        
        -- Update all existing claims
        UPDATE claims SET organization_id = default_org_id WHERE organization_id IS NULL;
        
        -- Update all existing claim_items
        UPDATE claim_items SET organization_id = default_org_id WHERE organization_id IS NULL;
        
        -- Update all existing stock_movements (if table exists)
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'stock_movements') THEN
            UPDATE stock_movements SET organization_id = default_org_id WHERE organization_id IS NULL;
        END IF;
        
        -- Update all existing audit_logs (if table exists)
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'audit_logs') THEN
            UPDATE audit_logs SET organization_id = default_org_id WHERE organization_id IS NULL;
        END IF;
        
        -- Update pharmacy_settings
        UPDATE pharmacy_settings SET organization_id = default_org_id WHERE organization_id IS NULL;
        
        RAISE NOTICE 'Created default organization with ID: %', default_org_id;
    END IF;
END $$;

-- ================================================
-- STEP 4: MAKE ORGANIZATION_ID NOT NULL (after data migration)
-- ================================================
-- Uncomment these after verifying all data has organization_id

-- ALTER TABLE users ALTER COLUMN organization_id SET NOT NULL;
-- ALTER TABLE drugs ALTER COLUMN organization_id SET NOT NULL;
-- ALTER TABLE patients ALTER COLUMN organization_id SET NOT NULL;
-- ALTER TABLE sales ALTER COLUMN organization_id SET NOT NULL;
-- ALTER TABLE sale_items ALTER COLUMN organization_id SET NOT NULL;
-- ALTER TABLE claims ALTER COLUMN organization_id SET NOT NULL;
-- ALTER TABLE claim_items ALTER COLUMN organization_id SET NOT NULL;
-- ALTER TABLE stock_movements ALTER COLUMN organization_id SET NOT NULL;
-- ALTER TABLE audit_logs ALTER COLUMN organization_id SET NOT NULL;
-- ALTER TABLE pharmacy_settings ALTER COLUMN organization_id SET NOT NULL;

-- ================================================
-- STEP 5: VERIFY MIGRATION
-- ================================================

-- Check organization created
SELECT 'Organizations:' as check_type, COUNT(*) as count FROM organizations;

-- Check all tables have organization_id
SELECT 'Users with org:' as check_type, COUNT(*) as count FROM users WHERE organization_id IS NOT NULL;
SELECT 'Drugs with org:' as check_type, COUNT(*) as count FROM drugs WHERE organization_id IS NOT NULL;
SELECT 'Patients with org:' as check_type, COUNT(*) as count FROM patients WHERE organization_id IS NOT NULL;
SELECT 'Sales with org:' as check_type, COUNT(*) as count FROM sales WHERE organization_id IS NOT NULL;

-- Check for orphaned records (should be 0)
SELECT 'Orphaned users:' as check_type, COUNT(*) as count FROM users WHERE organization_id IS NULL;
SELECT 'Orphaned drugs:' as check_type, COUNT(*) as count FROM drugs WHERE organization_id IS NULL;
SELECT 'Orphaned patients:' as check_type, COUNT(*) as count FROM patients WHERE organization_id IS NULL;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Migration Step 1 completed successfully!';
END $$;
