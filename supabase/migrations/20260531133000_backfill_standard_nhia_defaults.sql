insert into public.nhia_configuration (
  organization_id,
  branch_id,
  mode,
  scheme_name,
  api_base_url,
  production_base_url,
  member_lookup_endpoint_path,
  member_lookup_endpoint,
  claim_endpoint_path,
  claim_submit_endpoint,
  integration_mode,
  connection_profile,
  validation_mode,
  claim_control_mode,
  credential_mode,
  api_key_header_name,
  api_secret_header_name,
  facility_type,
  pharmacy_facility_level,
  license_number,
  admission_payment_option,
  claimit_validation_enabled,
  claims_officer_name,
  direct_api_enabled,
  export_format,
  nhis_member_digits,
  ghana_card_digits,
  max_retry_attempts,
  is_active,
  created_at,
  updated_at
)
select
  o.id,
  null,
  'ONLINE_CLOUD',
  'National Health Insurance',
  'https://elig.nhia.gov.gh:5000',
  'http://localhost:31719/json-api',
  '/api/hmis/genCCC',
  '/api/hmis/genCCC',
  '/claims',
  '/claims',
  'claimit_assisted',
  'local_server',
  'validate_before_submit',
  'manual',
  'claimit_token',
  'x-nhia-apikey',
  'x-nhia-apisecret',
  case
    when lower(coalesce(to_jsonb(o)->>'organization_type', '')) = 'hospital' then 'Hospital'
    else 'Pharmacy'
  end,
  case
    when lower(coalesce(to_jsonb(o)->>'organization_type', '')) = 'hospital' then null
    when upper(coalesce(to_jsonb(o)->>'pharmacy_level', '')) in ('P1', 'P2', 'LCS', 'HP') then upper(to_jsonb(o)->>'pharmacy_level')
    else 'P1'
  end,
  nullif(to_jsonb(o)->>'license_number', ''),
  'nhis_pays_admission',
  true,
  (
    select nullif(to_jsonb(u)->>'full_name', '')
    from public.users u
    where u.organization_id = o.id
      and lower(coalesce(to_jsonb(u)->>'role', '')) = 'admin'
    order by u.created_at nulls last
    limit 1
  ),
  false,
  'json',
  8,
  10,
  3,
  true,
  now(),
  now()
from public.organizations o
where not exists (
  select 1
  from public.nhia_configuration nc
  where nc.organization_id = o.id
    and nc.branch_id is null
);

update public.nhia_configuration nc
set
  scheme_name = coalesce(nullif(nc.scheme_name, ''), 'National Health Insurance'),
  api_base_url = coalesce(nullif(nc.api_base_url, ''), 'https://elig.nhia.gov.gh:5000'),
  production_base_url = coalesce(nullif(nc.production_base_url, ''), 'http://localhost:31719/json-api'),
  member_lookup_endpoint_path = coalesce(nullif(nc.member_lookup_endpoint_path, ''), nullif(nc.member_lookup_endpoint, ''), '/api/hmis/genCCC'),
  member_lookup_endpoint = coalesce(nullif(nc.member_lookup_endpoint, ''), nullif(nc.member_lookup_endpoint_path, ''), '/api/hmis/genCCC'),
  claim_endpoint_path = coalesce(nullif(nc.claim_endpoint_path, ''), nullif(nc.claim_submit_endpoint, ''), '/claims'),
  claim_submit_endpoint = coalesce(nullif(nc.claim_submit_endpoint, ''), nullif(nc.claim_endpoint_path, ''), '/claims'),
  integration_mode = coalesce(nullif(nc.integration_mode, ''), 'claimit_assisted'),
  connection_profile = coalesce(nullif(nc.connection_profile, ''), 'local_server'),
  validation_mode = coalesce(nullif(nc.validation_mode, ''), 'validate_before_submit'),
  claim_control_mode = coalesce(nullif(nc.claim_control_mode, ''), 'manual'),
  credential_mode = coalesce(nullif(nc.credential_mode, ''), 'claimit_token'),
  api_key_header_name = coalesce(nullif(nc.api_key_header_name, ''), 'x-nhia-apikey'),
  api_secret_header_name = coalesce(nullif(nc.api_secret_header_name, ''), 'x-nhia-apisecret'),
  facility_type = coalesce(
    nullif(nc.facility_type, ''),
    case
      when lower(coalesce(to_jsonb(o)->>'organization_type', '')) = 'hospital' then 'Hospital'
      else 'Pharmacy'
    end
  ),
  pharmacy_facility_level = case
    when lower(coalesce(to_jsonb(o)->>'organization_type', '')) = 'hospital' then null
    else coalesce(
      nullif(nc.pharmacy_facility_level, ''),
      case
        when upper(coalesce(to_jsonb(o)->>'pharmacy_level', '')) in ('P1', 'P2', 'LCS', 'HP') then upper(to_jsonb(o)->>'pharmacy_level')
        else 'P1'
      end
    )
  end,
  license_number = coalesce(nullif(nc.license_number, ''), nullif(to_jsonb(o)->>'license_number', '')),
  admission_payment_option = coalesce(nullif(nc.admission_payment_option, ''), 'nhis_pays_admission'),
  claimit_validation_enabled = coalesce(nc.claimit_validation_enabled, true),
  claims_officer_name = coalesce(
    nullif(nc.claims_officer_name, ''),
    (
      select nullif(to_jsonb(u)->>'full_name', '')
      from public.users u
      where u.organization_id = o.id
        and lower(coalesce(to_jsonb(u)->>'role', '')) = 'admin'
      order by u.created_at nulls last
      limit 1
    )
  ),
  direct_api_enabled = coalesce(nc.direct_api_enabled, false),
  export_format = coalesce(nullif(nc.export_format, ''), 'json'),
  nhis_member_digits = coalesce(nc.nhis_member_digits, 8),
  ghana_card_digits = coalesce(nc.ghana_card_digits, 10),
  max_retry_attempts = coalesce(nc.max_retry_attempts, 3),
  is_active = coalesce(nc.is_active, true),
  updated_at = now()
from public.organizations o
where nc.organization_id = o.id
  and nc.branch_id is null
  and (
    nullif(nc.scheme_name, '') is null
    or nullif(nc.api_base_url, '') is null
    or nullif(nc.production_base_url, '') is null
    or nullif(nc.member_lookup_endpoint_path, '') is null
    or nullif(nc.member_lookup_endpoint, '') is null
    or nullif(nc.claim_endpoint_path, '') is null
    or nullif(nc.claim_submit_endpoint, '') is null
    or nullif(nc.integration_mode, '') is null
    or nullif(nc.connection_profile, '') is null
    or nullif(nc.validation_mode, '') is null
    or nullif(nc.claim_control_mode, '') is null
    or nullif(nc.credential_mode, '') is null
    or nullif(nc.api_key_header_name, '') is null
    or nullif(nc.api_secret_header_name, '') is null
    or nullif(nc.facility_type, '') is null
    or (
      lower(coalesce(to_jsonb(o)->>'organization_type', '')) <> 'hospital'
      and nullif(nc.pharmacy_facility_level, '') is null
    )
    or nullif(nc.license_number, '') is null
    or nullif(nc.admission_payment_option, '') is null
    or nullif(nc.claims_officer_name, '') is null
    or nullif(nc.export_format, '') is null
  );
