-- ================================================================
-- PATCH: Enforce unique patient insurance IDs per organization
-- ================================================================
-- Date: 2026-05-07
-- Purpose:
--   Prevent the same insurance membership ID from being assigned to
--   multiple patients in one pharmacy tenant, whether the provider is
--   NHIS or a private insurer.
-- ================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT organization_id, LOWER(BTRIM(insurance_id)) AS normalized_insurance_id
      FROM public.patients
      WHERE insurance_id IS NOT NULL
        AND BTRIM(insurance_id) <> ''
      GROUP BY organization_id, LOWER(BTRIM(insurance_id))
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    RAISE EXCEPTION 'Duplicate patient insurance IDs exist. Merge or correct duplicate patient records before applying the unique insurance ID patch.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT organization_id, LOWER(BTRIM(nhis_member_no)) AS normalized_member_no
      FROM public.patients
      WHERE nhis_member_no IS NOT NULL
        AND BTRIM(nhis_member_no) <> ''
      GROUP BY organization_id, LOWER(BTRIM(nhis_member_no))
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    RAISE EXCEPTION 'Duplicate NHIS member numbers exist. Merge or correct duplicate patient records before applying the unique insurance ID patch.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT organization_id, LOWER(BTRIM(nhis_hin)) AS normalized_hin
      FROM public.patients
      WHERE nhis_hin IS NOT NULL
        AND BTRIM(nhis_hin) <> ''
      GROUP BY organization_id, LOWER(BTRIM(nhis_hin))
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    RAISE EXCEPTION 'Duplicate NHIS HIN values exist. Merge or correct duplicate patient records before applying the unique insurance ID patch.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_org_insurance_id_unique
  ON public.patients (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    LOWER(BTRIM(insurance_id))
  )
  WHERE insurance_id IS NOT NULL
    AND BTRIM(insurance_id) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_org_nhis_member_no_unique
  ON public.patients (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    LOWER(BTRIM(nhis_member_no))
  )
  WHERE nhis_member_no IS NOT NULL
    AND BTRIM(nhis_member_no) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_org_nhis_hin_unique
  ON public.patients (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    LOWER(BTRIM(nhis_hin))
  )
  WHERE nhis_hin IS NOT NULL
    AND BTRIM(nhis_hin) <> '';

COMMIT;
