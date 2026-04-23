-- ================================================
-- PATCH: Align drug uniqueness with multi-tenant catalog copies
-- ================================================
-- Date: April 23, 2026
-- Purpose:
-- 1. Remove the legacy global drugs uniqueness rule.
-- 2. Allow each organization to keep its own copy of a catalog medicine.
-- 3. Preserve per-organization uniqueness for name + batch number.
-- ================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'drugs_name_batch_number_key'
    ) THEN
        ALTER TABLE public.drugs
        DROP CONSTRAINT drugs_name_batch_number_key;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'drugs_organization_name_batch_number_key'
    ) THEN
        ALTER TABLE public.drugs
        ADD CONSTRAINT drugs_organization_name_batch_number_key
        UNIQUE (organization_id, name, batch_number);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_drugs_org_name_batch
ON public.drugs (organization_id, name, batch_number);

DO $$
BEGIN
    RAISE NOTICE 'Drug catalog multitenancy patch applied successfully.';
END $$;
