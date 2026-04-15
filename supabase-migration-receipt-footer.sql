-- ================================================
-- MIGRATION: Add receipt_footer to pharmacy_settings
-- Date: April 15, 2026
-- Description: Add receipt footer message for customized receipt printing
-- ================================================

-- Add receipt_footer column to pharmacy_settings
ALTER TABLE pharmacy_settings
ADD COLUMN IF NOT EXISTS receipt_footer TEXT;

-- Add comment for documentation
COMMENT ON COLUMN pharmacy_settings.receipt_footer IS 'Custom footer message displayed on printed receipts';

-- Verify column was added
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'pharmacy_settings' 
AND column_name = 'receipt_footer';
