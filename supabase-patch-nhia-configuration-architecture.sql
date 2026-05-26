-- Enterprise NHIA configuration source of truth.
-- Dedicated table, branch scoping, secret flag columns, and updated_at maintenance.

create table if not exists public.nhia_configuration (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  mode text not null default 'ONLINE_CLOUD',
  provider_id text,
  credential_code text,
  accreditation_expiry_date date,
  claims_officer_name text,
  api_base_url text,
  submitter_id text,
  api_key_encrypted text,
  api_secret_encrypted text,
  has_api_key boolean not null default false,
  has_api_secret boolean not null default false,
  username text,
  password_encrypted text,
  claim_submit_endpoint text,
  claim_status_endpoint text,
  member_lookup_endpoint text,
  cc_endpoint_path text,
  validation_mode text not null default 'validate_before_submit',
  facility_code text,
  provider_number text,
  scheme_name text not null default 'National Health Insurance',
  facility_type text,
  pharmacy_facility_level text,
  provider_level_code text,
  license_number text,
  integration_mode text not null default 'claimit_export',
  connection_profile text not null default 'local_server',
  claim_control_mode text not null default 'manual',
  sandbox_base_url text,
  production_base_url text,
  provider_type_description text,
  provider_class_level text,
  admission_payment_option text not null default 'nhis_pays_admission',
  claimit_validation_enabled boolean not null default true,
  claims_officer_signature_url text,
  api_environment text not null default 'production',
  api_key_header_name text,
  api_secret_header_name text,
  api_key_header_prefix text,
  token_endpoint_path text,
  claim_endpoint_path text,
  claim_validation_endpoint_path text,
  cc_code_endpoint_path text,
  claim_status_endpoint_path text,
  member_lookup_endpoint_path text,
  direct_api_enabled boolean not null default false,
  credential_mode text not null default 'api_key',
  nhis_member_digits integer not null default 8,
  ghana_card_digits integer not null default 10,
  export_format text not null default 'json',
  max_retry_attempts integer not null default 3,
  is_active boolean not null default true,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.nhia_configuration
  add column if not exists mode text not null default 'ONLINE_CLOUD',
  add column if not exists provider_id text,
  add column if not exists credential_code text,
  add column if not exists accreditation_expiry_date date,
  add column if not exists claims_officer_name text,
  add column if not exists api_base_url text,
  add column if not exists submitter_id text,
  add column if not exists api_key_encrypted text,
  add column if not exists api_secret_encrypted text,
  add column if not exists has_api_key boolean not null default false,
  add column if not exists has_api_secret boolean not null default false,
  add column if not exists username text,
  add column if not exists password_encrypted text,
  add column if not exists claim_submit_endpoint text,
  add column if not exists claim_status_endpoint text,
  add column if not exists member_lookup_endpoint text,
  add column if not exists cc_endpoint_path text,
  add column if not exists validation_mode text not null default 'validate_before_submit',
  add column if not exists facility_code text,
  add column if not exists provider_number text,
  add column if not exists scheme_name text not null default 'National Health Insurance',
  add column if not exists facility_type text,
  add column if not exists pharmacy_facility_level text,
  add column if not exists provider_level_code text,
  add column if not exists license_number text,
  add column if not exists integration_mode text not null default 'claimit_export',
  add column if not exists connection_profile text not null default 'local_server',
  add column if not exists claim_control_mode text not null default 'manual',
  add column if not exists sandbox_base_url text,
  add column if not exists production_base_url text,
  add column if not exists provider_type_description text,
  add column if not exists provider_class_level text,
  add column if not exists admission_payment_option text not null default 'nhis_pays_admission',
  add column if not exists claimit_validation_enabled boolean not null default true,
  add column if not exists claims_officer_signature_url text,
  add column if not exists api_environment text not null default 'production',
  add column if not exists api_key_header_name text,
  add column if not exists api_secret_header_name text,
  add column if not exists api_key_header_prefix text,
  add column if not exists token_endpoint_path text,
  add column if not exists claim_endpoint_path text,
  add column if not exists claim_validation_endpoint_path text,
  add column if not exists cc_code_endpoint_path text,
  add column if not exists claim_status_endpoint_path text,
  add column if not exists member_lookup_endpoint_path text,
  add column if not exists direct_api_enabled boolean not null default false,
  add column if not exists credential_mode text not null default 'api_key',
  add column if not exists nhis_member_digits integer not null default 8,
  add column if not exists ghana_card_digits integer not null default 10,
  add column if not exists export_format text not null default 'json',
  add column if not exists max_retry_attempts integer not null default 3,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_by uuid,
  add column if not exists updated_at timestamptz not null default now();

update public.nhia_configuration
set
  has_api_key = nullif(api_key_encrypted, '') is not null,
  has_api_secret = nullif(api_secret_encrypted, '') is not null,
  updated_at = coalesce(updated_at, now());

create unique index if not exists idx_nhia_configuration_org_branch
  on public.nhia_configuration (organization_id, branch_id) nulls not distinct;

create index if not exists idx_nhia_configuration_branch
  on public.nhia_configuration (branch_id)
  where branch_id is not null;

alter table public.nhia_configuration enable row level security;

drop policy if exists "nhia_configuration_select_org" on public.nhia_configuration;
create policy "nhia_configuration_select_org"
  on public.nhia_configuration
  for select
  using (
    organization_id = public.user_organization_id()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'super_admin'
    )
  );

drop policy if exists "nhia_configuration_service_write" on public.nhia_configuration;
create policy "nhia_configuration_service_write"
  on public.nhia_configuration
  for all
  using (
    (
      organization_id = public.user_organization_id()
      and exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.role = 'admin'
      )
    )
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'super_admin'
    )
  )
  with check (
    (
      organization_id = public.user_organization_id()
      and exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.role = 'admin'
      )
    )
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'super_admin'
    )
  );

create or replace function public.set_nhia_configuration_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.has_api_key = nullif(new.api_key_encrypted, '') is not null;
  new.has_api_secret = nullif(new.api_secret_encrypted, '') is not null;
  return new;
end;
$$;

drop trigger if exists trg_nhia_configuration_updated_at on public.nhia_configuration;
create trigger trg_nhia_configuration_updated_at
before update on public.nhia_configuration
for each row
execute function public.set_nhia_configuration_updated_at();

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
    id, organization_id, branch_id, mode, provider_id, credential_code,
    accreditation_expiry_date, claims_officer_name, api_base_url, submitter_id,
    api_key_encrypted, api_secret_encrypted, has_api_key, has_api_secret,
    api_key_header_name, api_secret_header_name, api_key_header_prefix,
    username, password_encrypted, token_endpoint_path, claim_submit_endpoint,
    claim_status_endpoint, member_lookup_endpoint, cc_endpoint_path, validation_mode,
    facility_code, provider_number, scheme_name, facility_type, pharmacy_facility_level,
    provider_level_code, license_number, integration_mode, connection_profile,
    claim_control_mode, sandbox_base_url, production_base_url, provider_type_description,
    provider_class_level, admission_payment_option, claimit_validation_enabled,
    claims_officer_signature_url, api_environment, claim_endpoint_path,
    claim_validation_endpoint_path, cc_code_endpoint_path, member_lookup_endpoint_path,
    claim_status_endpoint_path, direct_api_enabled, credential_mode, nhis_member_digits,
    ghana_card_digits, export_format, max_retry_attempts, is_active, created_at, updated_at
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
    sync_client_id, event_type, local_id, remote_id, response
  )
  values (
    v_client.id, 'nhia_configuration.upsert', v_config_id, v_remote_id, v_response
  )
  on conflict (sync_client_id, event_type, local_id) do update set
    remote_id = excluded.remote_id,
    response = excluded.response,
    created_at = now();

  return v_response;
end;
$$;

grant execute on function public.branch_sync_upsert_nhia_configuration(text, jsonb) to anon, authenticated;
