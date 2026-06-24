-- Replace the global nhis_claim_number_seq with a per-organization counter so
-- each pharmacy's NHIS claims start at NHIS-000001 independently.
--
-- What changes:
--   • New table  public.nhis_claim_counters  (one row per org)
--   • New function public.next_nhis_claim_number(UUID) — atomic per-org increment
--   • BEFORE INSERT trigger on nhis_claims assigns the number when none is supplied
--   • Column DEFAULT dropped (trigger replaces it)
--   • branch_sync_upsert_offline_record updated to call per-org function
--   • Global sequence public.nhis_claim_number_seq dropped
--
-- Existing claims are NOT modified. Each org's counter is seeded from its current
-- highest NHIS-NNNNNN number so new claims continue seamlessly.

BEGIN;

-- ----------------------------------------------------------------
-- 1. Per-org counter table
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.nhis_claim_counters (
  organization_id UUID    PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  last_number     INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE public.nhis_claim_counters ENABLE ROW LEVEL SECURITY;
-- Accessible only via SECURITY DEFINER functions; no direct authenticated access.

-- ----------------------------------------------------------------
-- 2. Atomic per-org increment function
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.next_nhis_claim_number(org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num INTEGER;
BEGIN
  INSERT INTO public.nhis_claim_counters (organization_id, last_number)
  VALUES (org_id, 1)
  ON CONFLICT (organization_id) DO UPDATE
    SET last_number = nhis_claim_counters.last_number + 1
  RETURNING last_number INTO next_num;

  RETURN 'NHIS-' || LPAD(next_num::TEXT, 6, '0');
END;
$$;

-- ----------------------------------------------------------------
-- 3. Seed counters from existing data so each org continues from
--    its current highest number (no resets, no gaps in new claims).
-- ----------------------------------------------------------------
INSERT INTO public.nhis_claim_counters (organization_id, last_number)
SELECT
  organization_id,
  MAX(CAST(SUBSTRING(claim_number FROM 6) AS INTEGER))
FROM public.nhis_claims
WHERE claim_number ~ '^NHIS-[0-9]{6}$'
GROUP BY organization_id
ON CONFLICT (organization_id) DO UPDATE
  SET last_number = GREATEST(
    nhis_claim_counters.last_number,
    EXCLUDED.last_number
  );

-- ----------------------------------------------------------------
-- 4. BEFORE INSERT trigger: auto-assign per-org number when none
--    is provided.  PHC-* (tier-access) and NHIA-* (local branch)
--    numbers are always explicit and bypass this trigger entirely.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_nhis_claim_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.claim_number IS NULL OR NEW.claim_number = '' THEN
    NEW.claim_number := public.next_nhis_claim_number(NEW.organization_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assign_nhis_claim_number_trigger ON public.nhis_claims;
CREATE TRIGGER assign_nhis_claim_number_trigger
  BEFORE INSERT ON public.nhis_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_nhis_claim_number();

-- ----------------------------------------------------------------
-- 5. Remove the global-sequence DEFAULT from the column.
--    The trigger above handles unset claim_number values going
--    forward; dropping the DEFAULT also removes the last reference
--    to nhis_claim_number_seq on the live table.
-- ----------------------------------------------------------------
ALTER TABLE public.nhis_claims
  ALTER COLUMN claim_number DROP DEFAULT;

-- ----------------------------------------------------------------
-- 6. Recreate branch_sync_upsert_offline_record with the per-org
--    counter replacing the global sequence fallback (line 863).
--    All other logic is reproduced verbatim.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.branch_sync_upsert_offline_record(
  p_sync_token TEXT,
  p_entity_type TEXT,
  p_local_id UUID,
  p_record JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_client public.branch_sync_clients%ROWTYPE;
  v_response JSONB;
  v_item JSONB;
  v_record JSONB;
  v_status TEXT;
BEGIN
  IF p_local_id IS NULL THEN
    RAISE EXCEPTION 'Local record ID is required.';
  END IF;

  IF p_record IS NULL OR jsonb_typeof(p_record) <> 'object' THEN
    RAISE EXCEPTION 'Invalid offline record payload.';
  END IF;

  v_client := public.get_branch_sync_client(p_sync_token);

  v_record := p_record
    || jsonb_build_object(
      'id', p_local_id,
      'organization_id', v_client.organization_id,
      'updated_at', COALESCE(NULLIF(p_record->>'updated_at', '')::TIMESTAMPTZ, NOW())
    );

  IF p_entity_type IN ('claims', 'nhis_claims', 'purchases') THEN
    v_record := v_record || jsonb_build_object('branch_id', v_client.branch_id);
  END IF;

  IF p_entity_type = 'patients' THEN
    INSERT INTO public.patients (
      id, organization_id, full_name, phone, email, date_of_birth, gender, address,
      insurance_provider, insurance_id, nhis_member_no, nhis_hin, allergies,
      medical_notes, created_at, updated_at
    )
    VALUES (
      p_local_id,
      v_client.organization_id,
      NULLIF(v_record->>'full_name', ''),
      NULLIF(v_record->>'phone', ''),
      NULLIF(v_record->>'email', ''),
      NULLIF(v_record->>'date_of_birth', '')::DATE,
      NULLIF(v_record->>'gender', ''),
      NULLIF(v_record->>'address', ''),
      NULLIF(v_record->>'insurance_provider', ''),
      NULLIF(v_record->>'insurance_id', ''),
      NULLIF(v_record->>'nhis_member_no', ''),
      NULLIF(v_record->>'nhis_hin', ''),
      NULLIF(v_record->>'allergies', ''),
      NULLIF(v_record->>'medical_notes', ''),
      COALESCE(NULLIF(v_record->>'created_at', '')::TIMESTAMPTZ, NOW()),
      COALESCE(NULLIF(v_record->>'updated_at', '')::TIMESTAMPTZ, NOW())
    )
    ON CONFLICT (id) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      phone = EXCLUDED.phone,
      email = EXCLUDED.email,
      date_of_birth = EXCLUDED.date_of_birth,
      gender = EXCLUDED.gender,
      address = EXCLUDED.address,
      insurance_provider = EXCLUDED.insurance_provider,
      insurance_id = EXCLUDED.insurance_id,
      nhis_member_no = EXCLUDED.nhis_member_no,
      nhis_hin = EXCLUDED.nhis_hin,
      allergies = EXCLUDED.allergies,
      medical_notes = EXCLUDED.medical_notes,
      updated_at = EXCLUDED.updated_at
    WHERE public.patients.organization_id = v_client.organization_id;

  ELSIF p_entity_type = 'suppliers' THEN
    INSERT INTO public.suppliers (
      id, organization_id, name, contact_person, phone, email, address, notes,
      is_active, created_at, updated_at
    )
    VALUES (
      p_local_id,
      v_client.organization_id,
      NULLIF(v_record->>'name', ''),
      NULLIF(v_record->>'contact_person', ''),
      NULLIF(v_record->>'phone', ''),
      NULLIF(v_record->>'email', ''),
      NULLIF(v_record->>'address', ''),
      NULLIF(v_record->>'notes', ''),
      COALESCE(NULLIF(v_record->>'is_active', '')::BOOLEAN, true),
      COALESCE(NULLIF(v_record->>'created_at', '')::TIMESTAMPTZ, NOW()),
      COALESCE(NULLIF(v_record->>'updated_at', '')::TIMESTAMPTZ, NOW())
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      contact_person = EXCLUDED.contact_person,
      phone = EXCLUDED.phone,
      email = EXCLUDED.email,
      address = EXCLUDED.address,
      notes = EXCLUDED.notes,
      is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at
    WHERE public.suppliers.organization_id = v_client.organization_id;

  ELSIF p_entity_type = 'nhis_drugs' THEN
    INSERT INTO public.nhis_drugs (
      id, organization_id, code, description, generic_name, strength, dosage_form,
      category, unit, unit_price, is_active, created_at, updated_at
    )
    VALUES (
      p_local_id,
      v_client.organization_id,
      NULLIF(v_record->>'code', ''),
      NULLIF(v_record->>'description', ''),
      NULLIF(v_record->>'generic_name', ''),
      NULLIF(v_record->>'strength', ''),
      NULLIF(v_record->>'dosage_form', ''),
      NULLIF(v_record->>'category', ''),
      COALESCE(NULLIF(v_record->>'unit', ''), 'unit'),
      COALESCE(NULLIF(v_record->>'unit_price', '')::NUMERIC, 0),
      COALESCE(NULLIF(v_record->>'is_active', '')::BOOLEAN, true),
      COALESCE(NULLIF(v_record->>'created_at', '')::TIMESTAMPTZ, NOW()),
      COALESCE(NULLIF(v_record->>'updated_at', '')::TIMESTAMPTZ, NOW())
    )
    ON CONFLICT (organization_id, code) DO UPDATE SET
      description = EXCLUDED.description,
      generic_name = EXCLUDED.generic_name,
      strength = EXCLUDED.strength,
      dosage_form = EXCLUDED.dosage_form,
      category = EXCLUDED.category,
      unit = EXCLUDED.unit,
      unit_price = EXCLUDED.unit_price,
      is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at
    WHERE public.nhis_drugs.organization_id = v_client.organization_id;

  ELSIF p_entity_type = 'claims' THEN
    v_status := COALESCE(NULLIF(v_record->>'claim_status', ''), 'pending');
    INSERT INTO public.claims (
      id, organization_id, branch_id, claim_number, patient_id, patient_name,
      insurance_provider, insurance_id, service_date, total_amount, claim_status,
      approval_amount, rejection_reason, prescription_url, notes, submitted_by,
      submitted_at, processed_at, created_at, updated_at
    )
    VALUES (
      p_local_id,
      v_client.organization_id,
      v_client.branch_id,
      COALESCE(NULLIF(v_record->>'claim_number', ''), public.generate_claim_number()),
      NULLIF(v_record->>'patient_id', '')::UUID,
      NULLIF(v_record->>'patient_name', ''),
      NULLIF(v_record->>'insurance_provider', ''),
      NULLIF(v_record->>'insurance_id', ''),
      COALESCE(NULLIF(v_record->>'service_date', '')::DATE, CURRENT_DATE),
      COALESCE(NULLIF(v_record->>'total_amount', '')::NUMERIC, 0),
      v_status,
      NULLIF(v_record->>'approval_amount', '')::NUMERIC,
      NULLIF(v_record->>'rejection_reason', ''),
      NULLIF(v_record->>'prescription_url', ''),
      NULLIF(v_record->>'notes', ''),
      NULLIF(v_record->>'submitted_by', '')::UUID,
      COALESCE(NULLIF(v_record->>'submitted_at', '')::TIMESTAMPTZ, NOW()),
      NULLIF(v_record->>'processed_at', '')::TIMESTAMPTZ,
      COALESCE(NULLIF(v_record->>'created_at', '')::TIMESTAMPTZ, NOW()),
      COALESCE(NULLIF(v_record->>'updated_at', '')::TIMESTAMPTZ, NOW())
    )
    ON CONFLICT (id) DO UPDATE SET
      claim_status = EXCLUDED.claim_status,
      approval_amount = EXCLUDED.approval_amount,
      rejection_reason = EXCLUDED.rejection_reason,
      prescription_url = EXCLUDED.prescription_url,
      notes = EXCLUDED.notes,
      processed_at = EXCLUDED.processed_at,
      updated_at = EXCLUDED.updated_at
    WHERE public.claims.organization_id = v_client.organization_id;

    DELETE FROM public.claim_items WHERE claim_id = p_local_id;
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_record->'claim_items', '[]'::JSONB)) LOOP
      INSERT INTO public.claim_items (
        id, organization_id, claim_id, drug_id, drug_name, quantity, unit_price, total_price
      )
      VALUES (
        COALESCE(NULLIF(v_item->>'id', '')::UUID, uuid_generate_v4()),
        v_client.organization_id,
        p_local_id,
        NULLIF(v_item->>'drug_id', '')::UUID,
        NULLIF(COALESCE(v_item->>'drug_name', v_item->>'name'), ''),
        COALESCE(NULLIF(v_item->>'quantity', '')::NUMERIC, 0),
        COALESCE(NULLIF(COALESCE(v_item->>'unit_price', v_item->>'price'), '')::NUMERIC, 0),
        COALESCE(NULLIF(v_item->>'total_price', '')::NUMERIC,
          COALESCE(NULLIF(v_item->>'quantity', '')::NUMERIC, 0) *
          COALESCE(NULLIF(COALESCE(v_item->>'unit_price', v_item->>'price'), '')::NUMERIC, 0))
      );
    END LOOP;

  ELSIF p_entity_type = 'nhis_claims' THEN
    INSERT INTO public.nhis_claims (
      id, organization_id, branch_id, claim_number, patient_id, member_no, hin,
      surname, other_names, folder_no, gender, date_of_birth, patient_address,
      child_weight_kg, ccc_no, diagnosis, diagnosis_details, service_date_from, service_date_to,
      referring_facility, referral_code, physician_name, pre_auth_codes,
      total_amount, status, rejection_reason, notes, created_by, created_at, updated_at
    )
    VALUES (
      p_local_id,
      v_client.organization_id,
      v_client.branch_id,
      COALESCE(NULLIF(v_record->>'claim_number', ''), public.next_nhis_claim_number(v_client.organization_id)),
      NULLIF(v_record->>'patient_id', '')::UUID,
      NULLIF(v_record->>'member_no', ''),
      NULLIF(v_record->>'hin', ''),
      NULLIF(v_record->>'surname', ''),
      NULLIF(v_record->>'other_names', ''),
      NULLIF(v_record->>'folder_no', ''),
      NULLIF(v_record->>'gender', ''),
      NULLIF(v_record->>'date_of_birth', '')::DATE,
      NULLIF(v_record->>'patient_address', ''),
      NULLIF(v_record->>'child_weight_kg', '')::NUMERIC,
      NULLIF(v_record->>'ccc_no', ''),
      NULLIF(v_record->>'diagnosis', ''),
      COALESCE(v_record->'diagnosis_details', '[]'::JSONB),
      NULLIF(v_record->>'service_date_from', '')::DATE,
      NULLIF(v_record->>'service_date_to', '')::DATE,
      NULLIF(v_record->>'referring_facility', ''),
      NULLIF(v_record->>'referral_code', ''),
      NULLIF(v_record->>'physician_name', ''),
      NULLIF(v_record->>'pre_auth_codes', ''),
      COALESCE(NULLIF(v_record->>'total_amount', '')::NUMERIC, 0),
      COALESCE(NULLIF(v_record->>'status', ''), 'served'),
      NULLIF(v_record->>'rejection_reason', ''),
      NULLIF(v_record->>'notes', ''),
      NULLIF(v_record->>'created_by', '')::UUID,
      COALESCE(NULLIF(v_record->>'created_at', '')::TIMESTAMPTZ, NOW()),
      COALESCE(NULLIF(v_record->>'updated_at', '')::TIMESTAMPTZ, NOW())
    )
    ON CONFLICT (id) DO UPDATE SET
      diagnosis = EXCLUDED.diagnosis,
      diagnosis_details = EXCLUDED.diagnosis_details,
      status = EXCLUDED.status,
      rejection_reason = EXCLUDED.rejection_reason,
      notes = EXCLUDED.notes,
      updated_at = EXCLUDED.updated_at
    WHERE public.nhis_claims.organization_id = v_client.organization_id;

    DELETE FROM public.nhis_claim_medicines WHERE claim_id = p_local_id;
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_record->'nhis_claim_medicines', '[]'::JSONB)) LOOP
      INSERT INTO public.nhis_claim_medicines (
        id, claim_id, nhis_drug_id, drug_code, description, unit, unit_price,
        dispensed_qty, dispensary_date, dose, frequency, duration, total_amount
      )
      VALUES (
        COALESCE(NULLIF(v_item->>'id', '')::UUID, uuid_generate_v4()),
        p_local_id,
        NULLIF(v_item->>'nhis_drug_id', '')::UUID,
        NULLIF(v_item->>'drug_code', ''),
        NULLIF(v_item->>'description', ''),
        COALESCE(NULLIF(v_item->>'unit', ''), 'unit'),
        COALESCE(NULLIF(v_item->>'unit_price', '')::NUMERIC, 0),
        COALESCE(NULLIF(v_item->>'dispensed_qty', '')::NUMERIC, 1),
        NULLIF(v_item->>'dispensary_date', '')::DATE,
        NULLIF(v_item->>'dose', ''),
        NULLIF(v_item->>'frequency', ''),
        NULLIF(v_item->>'duration', ''),
        COALESCE(NULLIF(v_item->>'total_amount', '')::NUMERIC, 0)
      );
    END LOOP;

    IF to_regclass('public.nhis_claim_services') IS NOT NULL THEN
      EXECUTE 'DELETE FROM public.nhis_claim_services WHERE claim_id = $1'
      USING p_local_id;

      FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_record->'nhis_claim_services', '[]'::JSONB)) LOOP
        EXECUTE $nhis_claim_service_sql$
          INSERT INTO public.nhis_claim_services (
            id, claim_id, nhia_tariff_item_id, tariff_version, facility_group, catering_option,
            mdc, gdrg_code, description, age_band, unit_price, quantity, service_date,
            total_amount, source_file, source_page
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16
          )
        $nhis_claim_service_sql$
        USING
          COALESCE(NULLIF(v_item->>'id', '')::UUID, uuid_generate_v4()),
          p_local_id,
          NULLIF(v_item->>'nhia_tariff_item_id', '')::UUID,
          COALESCE(NULLIF(v_item->>'tariff_version', ''), 'FEB 2023'),
          NULLIF(v_item->>'facility_group', ''),
          NULLIF(v_item->>'catering_option', ''),
          NULLIF(v_item->>'mdc', ''),
          NULLIF(v_item->>'gdrg_code', ''),
          NULLIF(v_item->>'description', ''),
          NULLIF(v_item->>'age_band', ''),
          COALESCE(NULLIF(v_item->>'unit_price', '')::NUMERIC, 0),
          COALESCE(NULLIF(v_item->>'quantity', '')::NUMERIC, 1),
          NULLIF(v_item->>'service_date', '')::DATE,
          COALESCE(NULLIF(v_item->>'total_amount', '')::NUMERIC, 0),
          NULLIF(v_item->>'source_file', ''),
          NULLIF(v_item->>'source_page', '')::INTEGER;
      END LOOP;
    END IF;

  ELSIF p_entity_type = 'purchases' THEN
    INSERT INTO public.purchases (
      id, organization_id, branch_id, purchase_number, supplier_id, supplier_name,
      invoice_number, purchase_date, total_amount, status, notes, created_by,
      created_at, updated_at
    )
    VALUES (
      p_local_id,
      v_client.organization_id,
      v_client.branch_id,
      COALESCE(NULLIF(v_record->>'purchase_number', ''), 'PO-' || LPAD(NEXTVAL('public.purchase_number_seq')::TEXT, 6, '0')),
      NULLIF(v_record->>'supplier_id', '')::UUID,
      NULLIF(v_record->>'supplier_name', ''),
      NULLIF(v_record->>'invoice_number', ''),
      COALESCE(NULLIF(v_record->>'purchase_date', '')::DATE, CURRENT_DATE),
      COALESCE(NULLIF(v_record->>'total_amount', '')::NUMERIC, 0),
      COALESCE(NULLIF(v_record->>'status', ''), 'draft'),
      NULLIF(v_record->>'notes', ''),
      NULLIF(v_record->>'created_by', '')::UUID,
      COALESCE(NULLIF(v_record->>'created_at', '')::TIMESTAMPTZ, NOW()),
      COALESCE(NULLIF(v_record->>'updated_at', '')::TIMESTAMPTZ, NOW())
    )
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      notes = EXCLUDED.notes,
      updated_at = EXCLUDED.updated_at
    WHERE public.purchases.organization_id = v_client.organization_id;

    DELETE FROM public.purchase_items WHERE purchase_id = p_local_id;
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_record->'purchase_items', '[]'::JSONB)) LOOP
      INSERT INTO public.purchase_items (
        id, purchase_id, drug_id, drug_name, brand_name, generic_name, sale_on_return, quantity, unit, unit_cost,
        discount_percent, net_total, batch_number, expiry_date
      )
      VALUES (
        COALESCE(NULLIF(v_item->>'id', '')::UUID, uuid_generate_v4()),
        p_local_id,
        NULLIF(v_item->>'drug_id', '')::UUID,
        NULLIF(v_item->>'drug_name', ''),
        NULLIF(v_item->>'brand_name', ''),
        NULLIF(v_item->>'generic_name', ''),
        COALESCE(NULLIF(v_item->>'sale_on_return', '')::BOOLEAN, false),
        COALESCE(NULLIF(v_item->>'quantity', '')::NUMERIC, 0),
        COALESCE(NULLIF(v_item->>'unit', ''), 'unit'),
        COALESCE(NULLIF(v_item->>'unit_cost', '')::NUMERIC, 0),
        COALESCE(NULLIF(v_item->>'discount_percent', '')::NUMERIC, 0),
        COALESCE(NULLIF(v_item->>'net_total', '')::NUMERIC, 0),
        NULLIF(v_item->>'batch_number', ''),
        NULLIF(v_item->>'expiry_date', '')::DATE
      );
    END LOOP;
  ELSE
    RAISE EXCEPTION 'Unsupported offline record entity type: %', p_entity_type;
  END IF;

  v_response := jsonb_build_object(
    'entity_type', p_entity_type,
    'local_id', p_local_id,
    'remote_id', p_local_id,
    'branch_id', v_client.branch_id,
    'organization_id', v_client.organization_id
  );

  INSERT INTO public.branch_sync_events (
    sync_client_id,
    event_type,
    local_id,
    remote_id,
    response
  )
  VALUES (
    v_client.id,
    'record.upsert.' || p_entity_type,
    p_local_id,
    p_local_id,
    v_response
  )
  ON CONFLICT (sync_client_id, event_type, local_id) DO UPDATE SET
    remote_id = EXCLUDED.remote_id,
    response = EXCLUDED.response,
    created_at = NOW();

  RETURN v_response;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

ALTER FUNCTION public.branch_sync_upsert_offline_record(TEXT, TEXT, UUID, JSONB)
  SET row_security = off;

GRANT EXECUTE ON FUNCTION public.branch_sync_upsert_offline_record(TEXT, TEXT, UUID, JSONB) TO anon, authenticated;

-- ----------------------------------------------------------------
-- 7. Drop the now-unused global sequence.
--    The DEFAULT was removed in step 5; no live code references it.
-- ----------------------------------------------------------------
DROP SEQUENCE IF EXISTS public.nhis_claim_number_seq;

COMMIT;
