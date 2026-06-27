-- ================================================================
-- PATCH: NHIS scanned prescription PDF/JPEG/PNG attachments
-- ================================================================
-- Purpose:
--   Stores scanned prescription PDF/JPEG/PNG metadata on NHIS claims,
--   stores CLAIM-it PDF export derivatives separately, and
--   creates a private Supabase Storage bucket for the files.
-- ================================================================

BEGIN;

ALTER TABLE public.nhis_claims
  ADD COLUMN IF NOT EXISTS prescription_file_url TEXT,
  ADD COLUMN IF NOT EXISTS prescription_file_path TEXT,
  ADD COLUMN IF NOT EXISTS prescription_file_name TEXT,
  ADD COLUMN IF NOT EXISTS prescription_file_type TEXT,
  ADD COLUMN IF NOT EXISTS prescription_file_size INTEGER,
  ADD COLUMN IF NOT EXISTS claimit_attachment_file_name TEXT,
  ADD COLUMN IF NOT EXISTS claimit_attachment_file_type TEXT,
  ADD COLUMN IF NOT EXISTS claimit_attachment_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS claimit_attachment_base64 TEXT;

CREATE INDEX IF NOT EXISTS idx_nhis_claims_prescription_file
  ON public.nhis_claims(organization_id, prescription_file_path)
  WHERE prescription_file_path IS NOT NULL;

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'nhis-prescriptions',
  'nhis-prescriptions',
  false,
  3145728,
  ARRAY['application/pdf', 'image/jpeg', 'image/png']
)
ON CONFLICT (id) DO UPDATE
SET
  public = false,
  file_size_limit = 3145728,
  allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png'];

DROP POLICY IF EXISTS nhis_prescriptions_select ON storage.objects;
CREATE POLICY nhis_prescriptions_select
ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'nhis-prescriptions'
  AND (storage.foldername(name))[1] = public.user_organization_id()::text
);

DROP POLICY IF EXISTS nhis_prescriptions_insert ON storage.objects;
CREATE POLICY nhis_prescriptions_insert
ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'nhis-prescriptions'
  AND (storage.foldername(name))[1] = public.user_organization_id()::text
  AND EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('admin', 'pharmacist', 'billing', 'branch_manager', 'claims_officer')
  )
);

DROP POLICY IF EXISTS nhis_prescriptions_update ON storage.objects;
CREATE POLICY nhis_prescriptions_update
ON storage.objects
FOR UPDATE TO authenticated
USING (
  bucket_id = 'nhis-prescriptions'
  AND (storage.foldername(name))[1] = public.user_organization_id()::text
)
WITH CHECK (
  bucket_id = 'nhis-prescriptions'
  AND (storage.foldername(name))[1] = public.user_organization_id()::text
  AND EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('admin', 'pharmacist', 'billing', 'branch_manager', 'claims_officer')
  )
);

DROP POLICY IF EXISTS nhis_prescriptions_delete ON storage.objects;
CREATE POLICY nhis_prescriptions_delete
ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'nhis-prescriptions'
  AND (storage.foldername(name))[1] = public.user_organization_id()::text
  AND EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('admin', 'pharmacist', 'billing', 'branch_manager', 'claims_officer')
  )
);

COMMIT;
