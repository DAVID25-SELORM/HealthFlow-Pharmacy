create or replace function public.branch_sync_upsert_nhia_configuration(
  p_sync_token text,
  p_config jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client record;
  v_config_id uuid;
  v_remote_id uuid;
  v_response jsonb;
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'Invalid NHIA configuration payload.';
  end if;

  v_client := public.get_branch_sync_client(p_sync_token);
  v_config_id := coalesce(nullif(p_config->>'id', '')::uuid, gen_random_uuid());

  insert into public.nhia_configuration (
    id,
    organization_id,
    branch_id,
    mode,
    provider_id,
    credential_code,
    accreditation_expiry_date,
    claims_officer_name,
    api_base_url,
    submitter_id,
    api_key_encrypted,
    api_secret_encrypted,
    has_api_key,
    has_api_secret,
    api_key_header_name,
    api_secret_header_name,
    api_key_header_prefix,
    username,
    password_encrypted,
    token_endpoint_path,
    claim_submit_endpoint,
    claim_status_endpoint,
    member_lookup_endpoint,
    cc_endpoint_path,
    validation_mode,
    facility_code,
    provider_number,
    hpn,
    hp_code,
    scheme_name,
    facility_type,
    pharmacy_facility_level,
    provider_level_code,
    license_number,
    integration_mode,
    connection_profile,
    claim_control_mode,
    sandbox_base_url,
    production_base_url,
    provider_type_description,
    provider_class_level,
    admission_payment_option,
    claimit_validation_enabled,
    claims_officer_signature_url,
    api_environment,
    claim_endpoint_path,
    claim_validation_endpoint_path,
    cc_code_endpoint_path,
    member_lookup_endpoint_path,
    claim_status_endpoint_path,
    direct_api_enabled,
    credential_mode,
    nhis_member_digits,
    ghana_card_digits,
    export_format,
    max_retry_attempts,
    is_active,
    created_at,
    updated_at
  )
  values (
    v_config_id,
    v_client.organization_id,
    v_client.branch_id,
    coalesce(nullif(p_config->>'mode', ''), 'ONLINE_LOCAL_SYNC'),
    nullif(p_config->>'provider_id', ''),
    nullif(p_config->>'credential_code', ''),
    nullif(p_config->>'accreditation_expiry_date', '')::date,
    nullif(p_config->>'claims_officer_name', ''),
    nullif(p_config->>'api_base_url', ''),
    nullif(p_config->>'submitter_id', ''),
    nullif(p_config->>'api_key_encrypted', ''),
    nullif(p_config->>'api_secret_encrypted', ''),
    nullif(p_config->>'api_key_encrypted', '') is not null,
    nullif(p_config->>'api_secret_encrypted', '') is not null,
    nullif(p_config->>'api_key_header_name', ''),
    nullif(p_config->>'api_secret_header_name', ''),
    nullif(p_config->>'api_key_header_prefix', ''),
    nullif(p_config->>'username', ''),
    nullif(p_config->>'password_encrypted', ''),
    nullif(p_config->>'token_endpoint_path', ''),
    nullif(coalesce(p_config->>'claim_submit_endpoint', p_config->>'claim_endpoint_path'), ''),
    nullif(coalesce(p_config->>'claim_status_endpoint', p_config->>'claim_status_endpoint_path'), ''),
    nullif(coalesce(p_config->>'member_lookup_endpoint', p_config->>'member_lookup_endpoint_path'), ''),
    nullif(coalesce(p_config->>'cc_endpoint_path', p_config->>'cc_code_endpoint_path'), ''),
    coalesce(nullif(p_config->>'validation_mode', ''), 'validate_before_submit'),
    nullif(p_config->>'facility_code', ''),
    nullif(coalesce(p_config->>'provider_number', p_config->>'provider_id'), ''),
    nullif(coalesce(p_config->>'hpn', p_config->>'HPN', p_config->>'provider_number', p_config->>'provider_id'), ''),
    nullif(coalesce(p_config->>'hp_code', p_config->>'hpCode', p_config->>'HPCode', p_config->>'facility_code'), ''),
    coalesce(nullif(p_config->>'scheme_name', ''), 'National Health Insurance'),
    nullif(p_config->>'facility_type', ''),
    nullif(p_config->>'pharmacy_facility_level', ''),
    nullif(p_config->>'provider_level_code', ''),
    nullif(p_config->>'license_number', ''),
    coalesce(nullif(p_config->>'integration_mode', ''), 'claimit_export'),
    coalesce(nullif(p_config->>'connection_profile', ''), 'local_server'),
    coalesce(nullif(p_config->>'claim_control_mode', ''), 'manual'),
    nullif(p_config->>'sandbox_base_url', ''),
    nullif(p_config->>'production_base_url', ''),
    nullif(p_config->>'provider_type_description', ''),
    nullif(p_config->>'provider_class_level', ''),
    coalesce(nullif(p_config->>'admission_payment_option', ''), 'nhis_pays_admission'),
    coalesce(nullif(p_config->>'claimit_validation_enabled', '')::boolean, true),
    nullif(p_config->>'claims_officer_signature_url', ''),
    coalesce(nullif(p_config->>'api_environment', ''), 'production'),
    nullif(coalesce(p_config->>'claim_endpoint_path', p_config->>'claim_submit_endpoint'), ''),
    nullif(p_config->>'claim_validation_endpoint_path', ''),
    nullif(coalesce(p_config->>'cc_code_endpoint_path', p_config->>'cc_endpoint_path'), ''),
    nullif(coalesce(p_config->>'member_lookup_endpoint_path', p_config->>'member_lookup_endpoint'), ''),
    nullif(coalesce(p_config->>'claim_status_endpoint_path', p_config->>'claim_status_endpoint'), ''),
    coalesce(nullif(p_config->>'direct_api_enabled', '')::boolean, false),
    coalesce(nullif(p_config->>'credential_mode', ''), 'api_key'),
    coalesce(nullif(p_config->>'nhis_member_digits', '')::integer, 8),
    coalesce(nullif(p_config->>'ghana_card_digits', '')::integer, 10),
    coalesce(nullif(p_config->>'export_format', ''), 'json'),
    coalesce(nullif(p_config->>'max_retry_attempts', '')::integer, 3),
    coalesce(nullif(p_config->>'is_active', '')::boolean, true),
    coalesce(nullif(p_config->>'created_at', '')::timestamptz, now()),
    coalesce(nullif(p_config->>'updated_at', '')::timestamptz, now())
  )
  on conflict (organization_id, branch_id) do update set
    mode = excluded.mode,
    provider_id = excluded.provider_id,
    credential_code = excluded.credential_code,
    accreditation_expiry_date = excluded.accreditation_expiry_date,
    claims_officer_name = excluded.claims_officer_name,
    api_base_url = excluded.api_base_url,
    submitter_id = excluded.submitter_id,
    api_key_encrypted = excluded.api_key_encrypted,
    api_secret_encrypted = excluded.api_secret_encrypted,
    has_api_key = excluded.has_api_key,
    has_api_secret = excluded.has_api_secret,
    api_key_header_name = excluded.api_key_header_name,
    api_secret_header_name = excluded.api_secret_header_name,
    api_key_header_prefix = excluded.api_key_header_prefix,
    username = excluded.username,
    password_encrypted = excluded.password_encrypted,
    token_endpoint_path = excluded.token_endpoint_path,
    claim_submit_endpoint = excluded.claim_submit_endpoint,
    claim_status_endpoint = excluded.claim_status_endpoint,
    member_lookup_endpoint = excluded.member_lookup_endpoint,
    cc_endpoint_path = excluded.cc_endpoint_path,
    validation_mode = excluded.validation_mode,
    facility_code = excluded.facility_code,
    provider_number = excluded.provider_number,
    hpn = excluded.hpn,
    hp_code = excluded.hp_code,
    scheme_name = excluded.scheme_name,
    facility_type = excluded.facility_type,
    pharmacy_facility_level = excluded.pharmacy_facility_level,
    provider_level_code = excluded.provider_level_code,
    license_number = excluded.license_number,
    integration_mode = excluded.integration_mode,
    connection_profile = excluded.connection_profile,
    claim_control_mode = excluded.claim_control_mode,
    sandbox_base_url = excluded.sandbox_base_url,
    production_base_url = excluded.production_base_url,
    provider_type_description = excluded.provider_type_description,
    provider_class_level = excluded.provider_class_level,
    admission_payment_option = excluded.admission_payment_option,
    claimit_validation_enabled = excluded.claimit_validation_enabled,
    claims_officer_signature_url = excluded.claims_officer_signature_url,
    api_environment = excluded.api_environment,
    claim_endpoint_path = excluded.claim_endpoint_path,
    claim_validation_endpoint_path = excluded.claim_validation_endpoint_path,
    cc_code_endpoint_path = excluded.cc_code_endpoint_path,
    member_lookup_endpoint_path = excluded.member_lookup_endpoint_path,
    claim_status_endpoint_path = excluded.claim_status_endpoint_path,
    direct_api_enabled = excluded.direct_api_enabled,
    credential_mode = excluded.credential_mode,
    nhis_member_digits = excluded.nhis_member_digits,
    ghana_card_digits = excluded.ghana_card_digits,
    export_format = excluded.export_format,
    max_retry_attempts = excluded.max_retry_attempts,
    is_active = excluded.is_active,
    updated_at = excluded.updated_at
  returning id into v_remote_id;

  v_response := jsonb_build_object(
    'entity_type', 'nhia_configuration',
    'local_id', v_config_id,
    'remote_id', v_remote_id,
    'branch_id', v_client.branch_id,
    'organization_id', v_client.organization_id
  );

  insert into public.branch_sync_events (
    sync_client_id,
    event_type,
    local_id,
    remote_id,
    response
  )
  values (
    v_client.id,
    'nhia_configuration.upsert',
    v_config_id,
    v_remote_id,
    v_response
  )
  on conflict (sync_client_id, event_type, local_id) do update set
    remote_id = excluded.remote_id,
    response = excluded.response,
    created_at = now();

  return v_response;
end;
$$;

grant execute on function public.branch_sync_upsert_nhia_configuration(text, jsonb) to anon, authenticated;
