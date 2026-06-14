BEGIN;

ALTER FUNCTION public.branch_sync_upsert_offline_record(TEXT, TEXT, UUID, JSONB)
  RENAME TO branch_sync_upsert_offline_record_core;

REVOKE ALL ON FUNCTION public.branch_sync_upsert_offline_record_core(TEXT, TEXT, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.branch_sync_upsert_offline_record(
  p_sync_token TEXT,
  p_entity_type TEXT,
  p_local_id UUID,
  p_record JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET row_security = off
AS $$
DECLARE
  v_client public.branch_sync_clients%ROWTYPE;
  v_remote_id UUID;
  v_response JSONB;
BEGIN
  IF p_entity_type <> 'nhis_drugs' THEN
    RETURN public.branch_sync_upsert_offline_record_core(
      p_sync_token,
      p_entity_type,
      p_local_id,
      p_record
    );
  END IF;

  IF p_local_id IS NULL THEN
    RAISE EXCEPTION 'Local record ID is required.';
  END IF;

  IF p_record IS NULL OR jsonb_typeof(p_record) <> 'object' THEN
    RAISE EXCEPTION 'Invalid offline record payload.';
  END IF;

  v_client := public.get_branch_sync_client(p_sync_token);

  INSERT INTO public.nhis_drugs (
    id,
    organization_id,
    code,
    description,
    generic_name,
    strength,
    dosage_form,
    category,
    unit,
    unit_price,
    is_active,
    medicine_access_level,
    required_pharmacy_level,
    created_at,
    updated_at
  )
  VALUES (
    p_local_id,
    v_client.organization_id,
    NULLIF(UPPER(BTRIM(p_record->>'code')), ''),
    NULLIF(BTRIM(p_record->>'description'), ''),
    NULLIF(BTRIM(p_record->>'generic_name'), ''),
    NULLIF(BTRIM(p_record->>'strength'), ''),
    NULLIF(BTRIM(p_record->>'dosage_form'), ''),
    NULLIF(BTRIM(p_record->>'category'), ''),
    COALESCE(NULLIF(BTRIM(p_record->>'unit'), ''), 'unit'),
    COALESCE(NULLIF(p_record->>'unit_price', '')::NUMERIC, 0),
    COALESCE(NULLIF(p_record->>'is_active', '')::BOOLEAN, true),
    NULLIF(BTRIM(p_record->>'medicine_access_level'), ''),
    NULLIF(BTRIM(p_record->>'required_pharmacy_level'), ''),
    COALESCE(NULLIF(p_record->>'created_at', '')::TIMESTAMPTZ, NOW()),
    COALESCE(NULLIF(p_record->>'updated_at', '')::TIMESTAMPTZ, NOW())
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
    medicine_access_level = EXCLUDED.medicine_access_level,
    required_pharmacy_level = EXCLUDED.required_pharmacy_level,
    updated_at = EXCLUDED.updated_at
  RETURNING id INTO v_remote_id;

  v_response := jsonb_build_object(
    'entity_type', p_entity_type,
    'local_id', p_local_id,
    'remote_id', v_remote_id,
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
    'record.upsert.nhis_drugs',
    p_local_id,
    v_remote_id,
    v_response
  )
  ON CONFLICT (sync_client_id, event_type, local_id) DO UPDATE SET
    remote_id = EXCLUDED.remote_id,
    response = EXCLUDED.response,
    created_at = NOW();

  RETURN v_response;
END;
$$;

GRANT EXECUTE ON FUNCTION public.branch_sync_upsert_offline_record(TEXT, TEXT, UUID, JSONB)
  TO anon, authenticated;

COMMIT;
