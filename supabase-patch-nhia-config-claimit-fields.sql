-- ================================================================
-- PATCH: NHIA / CLAIM-it configuration fields
-- ================================================================
-- ✅ NHIA CONFIG PATCH START
BEGIN;

ALTER TABLE public.organization_nhia_integrations
  ADD COLUMN IF NOT EXISTS facility_type TEXT,
  ADD COLUMN IF NOT EXISTS pharmacy_facility_level TEXT,
  ADD COLUMN IF NOT EXISTS provider_level_code TEXT,
  ADD COLUMN IF NOT EXISTS credential_code TEXT,
  ADD COLUMN IF NOT EXISTS license_number TEXT,
  ADD COLUMN IF NOT EXISTS accreditation_expiry_date DATE;

UPDATE public.organization_nhia_integrations AS integration
SET
  credential_code = COALESCE(NULLIF(integration.credential_code, ''), integration.facility_code),
  facility_type = COALESCE(
    NULLIF(integration.facility_type, ''),
    CASE
      WHEN org.organization_type = 'hospital' THEN 'Hospital'
      WHEN integration.provider_type_description ILIKE '%hospital%' THEN 'Hospital'
      WHEN integration.provider_type_description ILIKE '%clinic%' THEN 'Clinic'
      WHEN integration.provider_type_description ILIKE '%maternity%' THEN 'Maternity'
      WHEN integration.provider_type_description ILIKE '%chemical%' THEN 'Chemical Seller'
      WHEN integration.provider_type_description ILIKE '%pharmacy%' THEN 'Pharmacy'
      WHEN org.organization_type = 'pharmacy' THEN 'Pharmacy'
      ELSE NULL
    END
  ),
  provider_class_level = CASE
    WHEN COALESCE(NULLIF(integration.facility_type, ''), integration.provider_type_description, org.organization_type) ILIKE '%pharmacy%'
      THEN COALESCE(NULLIF(integration.provider_class_level, ''), 'C')
    ELSE NULLIF(integration.provider_class_level, '')
  END,
  pharmacy_facility_level = CASE
    WHEN COALESCE(NULLIF(integration.facility_type, ''), integration.provider_type_description, org.organization_type) ILIKE '%pharmacy%'
      THEN COALESCE(NULLIF(integration.pharmacy_facility_level, ''), 'P1')
    ELSE NULLIF(integration.pharmacy_facility_level, '')
  END
FROM public.organizations AS org
WHERE integration.organization_id = org.id
  AND integration.is_active = true;

COMMIT;
-- ✅ NHIA CONFIG PATCH END
